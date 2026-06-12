require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const MARKUP = 1.8;

// Normaliza medida: "205/70 R14" o "205/70R14" -> "205/70R14"
function normalizarMedida(s) {
  return s.toString().trim().replace(/\s+R/i, 'R').toUpperCase();
}

// Detecta medida en un texto libre
function extraerMedida(desc) {
  const m = desc.match(/(\d{2,3}[\/X]\d{1,2}\.?\d*\s*R\s*\d{2}C?)/i);
  return m ? normalizarMedida(m[1]) : '';
}

function parseMarca(desc) {
  // En el sistema de Victoria/Nordelta la descripción empieza con la marca
  // Ej: "DUNLOP 185/60 R15 84H ENASAVE" → "Dunlop"
  // Fallback: buscar marca conocida dentro del texto
  const conocidas = ['MICHELIN','BFGOODRICH','YOKOHAMA','GITI','GTRADIAL','NEXEN','HANKOOK',
    'LINGLONG','DUNLOP','PIRELLI','GOODYEAR','CONTINENTAL','BRIDGESTONE','FATE',
    'WESTLAKE','TRACMAX','SUNNY','CHAOYANG','TOYO','KUMHO','FALKEN','FIRESTONE',
    'COOPER','MAXXIS','NANKANG','ATLAS','TRIANGLE','UNIROYAL','SAILUN'];
  const up = desc.toUpperCase().trim();
  // Primero: si el primer word es una marca conocida, usarlo
  const primerWord = up.split(/[\s\/\d]/)[0];
  const exacta = conocidas.find(m => m === primerWord);
  if (exacta) return exacta.charAt(0) + exacta.slice(1).toLowerCase();
  // Si no, buscar en cualquier parte
  const encontrada = conocidas.find(m => up.includes(m));
  if (encontrada) return encontrada.charAt(0) + encontrada.slice(1).toLowerCase();
  // Último recurso: primer word capitalizado
  const primera = desc.trim().split(' ')[0];
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase();
}

function parseStock(val) {
  if (!val && val !== 0) return 0;
  const s = val.toString().toLowerCase().trim();
  if (s === 'ok' || s === 'nuevo ingreso') return 99;
  if (s === 'ultima unidad') return 1;
  const n = parseInt(val);
  return isNaN(n) || n < 0 ? 0 : n;
}

// ── 1. LEER VICTORIA / NORDELTA ──────────────────────────────────────────────
function leerVictoriaNordelta() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/120626 stock victoria y nordelta.xlsx');
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);

  const productos = new Map(); // codArt -> { desc, marca, medida, victoria, nordelta, precio }

  for (const row of data) {
    const deposito = (row[0] || '').toString().trim();
    if (!['Suc. Victoria', 'Suc. Nordelta'].includes(deposito)) continue;
    const codArt   = (row[2] || '').toString().trim();
    const cantidad = parseInt(row[6]) || 0;
    const precio   = parseFloat(row[12]) || 0;
    const desc     = (row[36] || '').toString().replace(/^N\.\s*/i, '').trim();
    if (!codArt || !desc) continue;

    if (!productos.has(codArt)) {
      productos.set(codArt, {
        codArt, desc,
        marca:  parseMarca(desc),
        medida: extraerMedida(desc),
        victoria: 0, nordelta: 0,
        precio,
      });
    }
    const p = productos.get(codArt);
    if (precio > 0) p.precio = precio;
    if (deposito === 'Suc. Victoria') p.victoria += cantidad;
    if (deposito === 'Suc. Nordelta') p.nordelta += cantidad;
  }

  return productos;
}

// ── 2. LEER DISTRIBUIDORES (Express) ─────────────────────────────────────────
function leerNexen() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/Nexen al 11-06 (1).xlsx', { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1);
  const verdes = new Set();
  for (const [addr, cell] of Object.entries(ws)) {
    if (!addr.startsWith('C')) continue;
    const rowNum = parseInt(addr.slice(1));
    if (rowNum < 2) continue;
    if (cell.s && cell.s.fgColor && cell.s.fgColor.rgb === '92D050' && !cell.v) verdes.add(rowNum - 2);
  }
  return data.map((row, i) => {
    const desc = (row[1] || '').trim();
    if (!desc || !row[3]) return null;
    const stockNum = parseInt(row[2]) || 0;
    return {
      medida:  extraerMedida(desc),
      marca:   'Nexen',
      desc,
      express: stockNum > 0 ? stockNum : (verdes.has(i) ? 99 : 0),
      precio:  Math.round(parseFloat(row[3]) * MARKUP),
    };
  }).filter(Boolean);
}

function leerHankook() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/LP Hankook 11.06.26.xlsx', { cellStyles: true });
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(2);
  return data.map(row => {
    if (!row[1] || typeof row[1] !== 'string') return null;
    const volumen = parseFloat(row[14]);
    if (!volumen) return null;
    const p = row[2], t = row[3], r = row[4];
    const medida = (p && t && r) ? normalizarMedida(`${p}/${t}R${r}`) : '';
    const desc = (row[6] || '').trim();
    return { medida, marca: 'Hankook', desc, express: parseStock(row[10]), precio: Math.round(volumen * MARKUP) };
  }).filter(Boolean);
}

function leerLinglong() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/Ling Long 1-6.xlsx', { cellStyles: true });
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(3);
  return data.map(row => {
    if (!row[0] || typeof row[0] !== 'string') return null;
    const volumen = parseFloat(row[5]);
    if (!volumen) return null;
    if ((row[6] || '').toString() === 'STOCK') return null;
    const desc = (row[1] || '').trim();
    return { medida: extraerMedida(desc), marca: 'Linglong', desc, express: parseStock(row[6]), precio: Math.round(volumen * MARKUP) };
  }).filter(Boolean);
}

function leerMichelinBFGoodrich() {
  // 1. Mapa de precios desde lista de referencia (Mostrador = col9, o col10/0.8)
  const wbP = XLSX.readFile('C:/Users/juani/Desktop/PC Anterior Backup/Google Drive/Documents/Listas de Precio/202606/Lista de Referencia Auto y Camioneta - 01 Junio 2026.xlsx');
  const sheetsMarca = {
    'Turismo y Camioneta Michelin': 'Michelin',
    'Michelin R14':                 'Michelin',
    'Invierno Michelin':            'Michelin',
    'Camioneta BFG':                'Bfgoodrich',
    'BFGoodrich Auto':              'Bfgoodrich',
  };
  const precioMap = new Map();
  for (const [sheetName, marca] of Object.entries(sheetsMarca)) {
    if (!wbP.SheetNames.includes(sheetName)) continue;
    const rows = XLSX.utils.sheet_to_json(wbP.Sheets[sheetName], { header: 1 });
    for (const row of rows) {
      const medida = extraerMedida((row[4] || '').toString());
      if (!medida) continue;
      const mostrador = parseFloat(row[9]);
      const refIVA    = parseFloat(row[10]);
      const precio    = mostrador > 0 ? Math.round(mostrador) : (refIVA > 0 ? Math.round(refIVA / 0.8) : 0);
      if (!precio) continue;
      const key = `${medida}|${marca.toUpperCase()}`;
      if (!precioMap.has(key)) precioMap.set(key, precio);
    }
  }

  // 2. Stock express
  const wbS = XLSX.readFile('C:/Users/juani/Downloads/Stock_Disponible_2026-06-12_17-42-31.xlsx');
  const dataS = XLSX.utils.sheet_to_json(wbS.Sheets[wbS.SheetNames[0]], { header: 1 }).slice(1);
  return dataS.map(row => {
    const lp    = (row[2] || '').toString().trim();
    const marca = (row[3] || '').toString().trim();
    const desc  = (row[1] || '').toString().trim();
    const stock = parseInt(row[6]) || 0;
    if (!['TC', 'TCR'].includes(lp)) return null;
    if (!['MICHELIN', 'BFGOODRICH'].includes(marca)) return null;
    if (!stock) return null;
    const medida = extraerMedida(desc);
    if (!medida) return null;
    const marcaNorm = marca.charAt(0) + marca.slice(1).toLowerCase();
    const express = stock >= 8 ? 99 : stock;
    const precio = precioMap.get(`${medida}|${marca}`) || 0;
    return { medida, marca: marcaNorm, desc, express, precio };
  }).filter(Boolean);
}

function leerYokohama() {
  const wb = XLSX.readFile('C:/Users/juani/Desktop/PC Anterior Backup/Google Drive/Documents/Listas de Precio/202606/LP Yokohama JUNIO 36% (1).xlsx');
  const data = XLSX.utils.sheet_to_json(wb.Sheets['Hoja1'], { header: 1 }).slice(5);
  return data.map(row => {
    const medida    = normalizarMedida((row[3] || '').toString().trim());
    const promoClub = parseFloat(row[10]);
    const stockVal  = row[11];
    if (!medida || !promoClub) return null;
    const stockRaw  = stockVal === 'OK' ? 99 : (parseInt(stockVal) || 0);
    if (!stockRaw) return null;
    const express = stockRaw >= 8 ? 99 : stockRaw;
    const precio  = Math.round(promoClub * 1.8);
    const desc    = (row[4] || '').toString().trim();
    return { medida, marca: 'Yokohama', desc, express, precio };
  }).filter(Boolean);
}

// Extrae palabras clave del modelo desde una descripción (ej: "G015", "N'FERA", "BLUEARTH")
function extraerModelo(desc) {
  // Buscar tokens alfanuméricos que parezcan códigos de modelo (2+ letras o combinados)
  const tokens = desc.toUpperCase().split(/[\s\-\/]+/);
  return tokens.filter(t => /^[A-Z][A-Z0-9']{1,}$/.test(t) && !/^(YOKOHAMA|MICHELIN|NEXEN|HANKOOK|LINGLONG|BFGOODRICH|GITI|GTRADIAL|TL|XL|LT|ZR|SUV|AWD|DOT)$/.test(t));
}

function descMatch(desc1, desc2) {
  const m1 = extraerModelo(desc1);
  const m2 = extraerModelo(desc2);
  return m1.some(t => m2.includes(t));
}

// ── 3. MERGE ─────────────────────────────────────────────────────────────────
function merge(productos, distribuidores) {
  // Índice de productos propios por medida+marca para match con distribuidores
  const porMedidaMarca = new Map(); // key → [p, ...]
  for (const p of productos.values()) {
    const key = `${p.medida}|${p.marca.toUpperCase()}`;
    if (!porMedidaMarca.has(key)) porMedidaMarca.set(key, []);
    porMedidaMarca.get(key).push(p);
  }

  // Agregar express a productos existentes o crear nuevos
  for (const d of distribuidores) {
    if (!d.express) continue; // sin stock express, no agregar
    const key = `${normalizarMedida(d.medida)}|${d.marca.toUpperCase()}`;
    const candidatos = porMedidaMarca.get(key) || [];

    // Buscar el candidato con descripción que más coincida
    const existente = candidatos.find(p => descMatch(p.desc, d.desc)) || (candidatos.length === 1 ? candidatos[0] : null);

    if (existente && (existente.victoria + existente.nordelta) > 0) {
      // Tiene stock propio: solo agregar express si el modelo coincide
      if (descMatch(existente.desc, d.desc)) {
        existente.express = d.express;
      } else {
        // Modelo distinto: crear entrada nueva para este producto del distribuidor
        if (d.precio > 0) {
          const nuevo = { codArt: '', desc: d.desc, marca: d.marca, medida: d.medida, victoria: 0, nordelta: 0, express: d.express, precio: d.precio };
          productos.set(`dist_${key}_${d.desc.slice(0, 20)}`, nuevo);
          porMedidaMarca.get(key).push(nuevo);
        }
      }
    } else if (existente && (existente.victoria + existente.nordelta) === 0) {
      // Existe pero sin stock propio: reemplazar con datos del distribuidor
      existente.express = d.express;
      if (d.precio > 0) existente.precio = d.precio;
      existente.desc = d.desc;
    } else if (!existente && d.precio > 0) {
      // Producto nuevo del distribuidor (solo si tiene precio)
      const nuevo = { codArt: '', desc: d.desc, marca: d.marca, medida: d.medida, victoria: 0, nordelta: 0, express: d.express, precio: d.precio };
      productos.set(`dist_${key}_${d.desc.slice(0, 20)}`, nuevo);
      if (!porMedidaMarca.has(key)) porMedidaMarca.set(key, []);
      porMedidaMarca.get(key).push(nuevo);
    }
  }
}

// ── 4. MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Leyendo archivos...');
  const productos = leerVictoriaNordelta();
  console.log(`Victoria/Nordelta: ${productos.size} productos`);

  const distribuidores = [...leerNexen(), ...leerHankook(), ...leerLinglong(), ...leerMichelinBFGoodrich(), ...leerYokohama()];
  console.log(`Distribuidores: ${distribuidores.length} productos`);

  // Inicializar express en 0 para todos los existentes
  for (const p of productos.values()) p.express = 0;

  merge(productos, distribuidores);

  // Construir filas: solo incluir si hay algún stock (victoria + nordelta + express > 0)
  const filas = [];
  for (const p of productos.values()) {
    const vic = Math.max(0, p.victoria || 0);
    const nor = Math.max(0, p.nordelta || 0);
    const exp = p.express || 0;
    if (vic + nor + exp === 0) continue;

    // Si tiene stock propio, usar precio propio; si no, usar precio del distribuidor
    filas.push([
      p.codArt || '',
      '',
      p.desc,
      p.marca,
      '',
      p.medida,
      vic,
      nor,
      exp,
      p.precio,
      '',
    ]);
  }

  console.log(`Total filas a subir: ${filas.length}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Limpiar todo el contenido del sheet excepto el header
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A2:Z10000',
  });
  console.log('Sheet limpiado');

  // Subir en bloques de 500 para evitar límites
  for (let i = 0; i < filas.length; i += 500) {
    const bloque = filas.slice(i, i + 500);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Bot WhatsApp!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: bloque },
    });
    console.log(`Subido bloque ${i + 1} - ${Math.min(i + 500, filas.length)}`);
  }

  console.log('¡Listo!');
}

main().catch(console.error);
