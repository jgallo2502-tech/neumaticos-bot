/**
 * Sincronización de precios y stock desde carpeta Drive de fuentes.
 *
 * Fuentes:
 *   - Inventario Gallo       → StockVic + StockNor para todas las marcas
 *   - Celsur                 → StockExpr para Michelin / BFGoodrich
 *   - Lista Michelin/BFG     → Precio Mostrador Gallo para Michelin / BFGoodrich (match por CAI)
 *   - Hankook / Yokohama / Linglong → StockExpr + Precio (columna "Precio Mostrador Gallo")
 *   - Neumasur Nexen         → StockExpr + Precio (columna "Precio Mostrador Gallo")
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

// ─── IDs ────────────────────────────────────────────────────────────────────
const SHEET_ID    = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const FOLDER_ID   = '11Ham__W-bVOJtaMsZQHRap-orDV6cpek';

// ─── Auth ────────────────────────────────────────────────────────────────────
async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizarMedida(texto) {
  if (!texto) return null;
  const t = texto.toString().replace(/\s+/g, ' ').trim().replace(/^RF\s*/i, '');
  const mAm = t.match(/(\d{2})\s*[xX]\s*(\d{2}\.?\d*)\s*[rR]\s*(\d{2})(?:LT)?\b/i);
  if (mAm) return `${mAm[1]}X${parseFloat(mAm[2])}R${mAm[3]}`.toUpperCase();
  const m1 = t.match(/(\d{3})\s*[\/\-\s]\s*(\d{2})\s*(?:[zZ]?[rR][fF]?|[\/\-\s])\s*(\d{2})(C)?\b/i);
  if (m1) return `${m1[1]}/${m1[2]}R${m1[3]}${m1[4] ? 'C' : ''}`;
  const m2 = t.match(/(\d{3})(\d{2})[rR][fF]?(\d{2})(C)?\b/i);
  if (m2) return `${m2[1]}/${m2[2]}R${m2[3]}${m2[4] ? 'C' : ''}`;
  return null;
}

// Devuelve cantidad real para la columna StockExpr.
// stockDesconocido: qué poner cuando el valor es undefined/null/vacío (99 = disponible a pedir, 0 = no disponible)
function stockExterno(val, stockDesconocido = 0) {
  if (val === undefined || val === null || val === '') return stockDesconocido;
  if (typeof val === 'number') return val > 0 ? val : 0;
  const s = val.toString().trim();
  if (/^ok$/i.test(s) || /nuevo ingreso/i.test(s)) return 99;
  const n = parseFloat(s);
  if (!isNaN(n)) return n > 0 ? n : 0;
  return stockDesconocido;
}

function tieneStock(val) {
  return stockExterno(val) > 0;
}

function parseNum(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  const s = val.toString().trim();
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  return parseFloat(s) || 0;
}

// ─── Descargar archivo de Drive ───────────────────────────────────────────────
async function descargarXlsx(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return XLSX.read(Buffer.from(res.data));
}

// ─── Listar archivos en carpeta ───────────────────────────────────────────────
async function listarCarpeta(drive) {
  const res = await drive.files.list({
    q: `'${FOLDER_ID}' in parents`,
    fields: 'files(id, name)',
  });
  return res.data.files;
}

function encontrarArchivo(archivos, keywords, excluir = []) {
  const matches = archivos.filter(f => {
    const n = f.name.toLowerCase();
    return keywords.every(k => n.includes(k.toLowerCase())) && excluir.every(e => !n.includes(e.toLowerCase()));
  });
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => b.name.localeCompare(a.name))[0];
}

// ─── Leer Inventario Gallo ────────────────────────────────────────────────────
function leerInventarioGallo(wb) {
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
  const vicMap    = {};
  const norMap    = {};
  const precioMap = {};
  const productos = {};  // codArt → { codArt, codAlt, desc, marca, modelo, medida }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const deposito = (r[0] || '').toString().toLowerCase();
    const codArt   = (r[2] || '').toString().trim();
    const cantidad = parseNum(r[6]);
    const precio   = parseNum(r[12]);
    if (!codArt) continue;

    if (deposito.includes('victoria')) {
      vicMap[codArt] = (vicMap[codArt] || 0) + cantidad;
    } else if (deposito.includes('nordelta')) {
      norMap[codArt] = (norMap[codArt] || 0) + cantidad;
    }
    if (precio > 0 && !precioMap[codArt]) {
      precioMap[codArt] = precio;
    }
    if (!productos[codArt]) {
      const descRaw = (r[36] || r[1] || '').toString().trim();
      const codAlt  = (r[24] || '').toString().trim();
      // Extraer marca de la descripción (primer token significativo)
      const { marca, modelo, medida } = parsearDesc(descRaw);
      productos[codArt] = { codArt, codAlt, desc: descRaw, marca, modelo, medida };
    }
  }
  return { vicMap, norMap, precioMap, productos };
}

function parsearDesc(desc) {
  // Descripción típica: "N. MICHELIN 225/40 R18 92Y ZR PILOT SPORT 4S" o "N. TRACMAX 205/55 R16 91V XL X-PRIVILO ZR"
  const marcas = ['MICHELIN','BFGOODRICH','YOKOHAMA','HANKOOK','LINGLONG','NEXEN','TRACMAX','GITI','GTRADIAL','CONTINENTAL','BRIDGESTONE','GOODYEAR','PIRELLI','DUNLOP','TOYO','NITTO','KUMHO','SUNNY','WESTLAKE','ROUTE'];
  const upper = desc.toUpperCase().replace(/^N\.\s*/,'');
  let marca = '';
  for (const m of marcas) {
    if (upper.includes(m)) { marca = m === 'BFGOODRICH' ? 'BFGoodrich' : m.charAt(0) + m.slice(1).toLowerCase(); break; }
  }
  const medida = normalizarMedida(desc) || '';
  // Modelo: todo lo que viene después de la medida + índice de carga/velocidad + XL/RF opcional
  // Ej: "225/40 R18 92Y ZR ..." → captura "ZR ..."
  let modelo = '';
  const mModelo = desc.match(/\d{3}[\/ ]\d{2}\s*[Rr][Cc]?\s*\d{2}[Cc]?\s*\(?\d{2,3}[A-Za-z]{1,2}\)?\s*(?:XL|RF|C|TL)?\s*(.+)/i);
  if (mModelo) {
    modelo = mModelo[1].trim();
  }
  return { marca, modelo, medida };
}

// ─── Leer Celsur (stock Express Michelin/BFG) ─────────────────────────────────
function leerCelsur(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Hoja1'], { header: 1 });
  const caiMap   = {};  // CAI → stock
  const descMap  = {};  // CAI → desc
  const marcaMap = {};  // CAI → marca (col D)
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cai   = r[0] ? r[0].toString().trim() : null;
    const stock = parseNum(r[6]);
    const desc  = (r[1] || '').toString().trim();
    const marca = (r[3] || '').toString().trim();
    if (cai) { caiMap[cai] = stock; descMap[cai] = desc; marcaMap[cai] = marca; }
  }
  return { caiMap, descMap, marcaMap };
}

// ─── Leer lista Michelin/BFG (precio por CAI, PMG buscado por nombre de columna) ─
function leerMichelinPrecios(wb) {
  const caiMap = {};
  for (const sheetName of wb.SheetNames) {
    if (sheetName.toLowerCase() === 'glosario') continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    // Header está en fila 3 (índice 3)
    const header = rows[3] || [];
    const pmgCol = header.findIndex(h => /precio mostrador gallo/i.test((h || '').toString()));
    if (pmgCol === -1) {
      console.log(`  ⚠️  Sin columna "Precio Mostrador Gallo" en hoja: ${sheetName}`);
      continue;
    }
    for (let i = 4; i < rows.length; i++) {
      const r = rows[i];
      const cai   = r[3] ? r[3].toString().trim() : null;
      const precio = r[pmgCol];
      if (cai && typeof precio === 'number' && precio > 0) {
        caiMap[cai] = precio;
      }
    }
  }
  return caiMap;
}

// ─── Leer Hankook — match por SKU (CodAlt del sheet = "HA" + Cod. producto) ──
function leerHankook(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Lista Precios Hankook'], { header: 1 });
  const skuMap   = {};  // cod. producto → datos
  const medidaMap = {}; // fallback por medida
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r[2] && !r[3] && !r[4]) continue;
    const cod    = (r[1] || '').toString().trim();
    const pisada = r[2], talon = r[3], rodado = r[4];
    const stock  = r[10];
    const precio = r[15];
    if (typeof precio !== 'number' || precio <= 0) continue;
    const medida = normalizarMedida(`${pisada}/${talon}R${rodado}`) || '';
    const desc = `HANKOOK ${medida} ${r[5] || ''} ${r[6] || ''}`.trim();
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Yokohama — match por SKU (CodAlt = "YO" + CODIGO) ──────────────────
function leerYokohama(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Hoja1'], { header: 1 });
  const skuMap    = {};
  const medidaMap = {};
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    const cod       = (r[7] || '').toString().trim();
    if (!cod) continue;
    const medidaRaw = (r[3] || '').toString();
    const precio    = r[12];
    const stock     = r[11];
    const modelo    = (r[4] || '').toString().trim();
    if (typeof precio !== 'number' || precio <= 0) continue;
    const medida = normalizarMedida(medidaRaw) || '';
    const desc = `YOKOHAMA ${medidaRaw} ${modelo}`.trim();
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Linglong — match por SKU (CodAlt = MATERIAL directamente) ──────────
function leerLinglong(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Lista'], { header: 1 });
  const skuMap    = {};
  const medidaMap = {};
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if ((r[0] || '').toString() === 'MATERIAL') continue;
    if (!r[1] || typeof r[7] !== 'number' || r[7] <= 0) continue;
    const cod    = (r[0] || '').toString().trim();
    const desc   = r[1].toString();
    const precio = r[7];
    const stock  = r[6];
    const medida = normalizarMedida(desc) || '';
    const entry  = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Neumasur (Nexen) — match por SKU (CodAlt = "NE" + codigo) ──────────
function leerNeumasur(wb) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Nexen'], { header: 1 });
  const skuMap    = {};
  const medidaMap = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cod    = r[0] ? r[0].toString().trim() : null;
    const desc   = (r[1] || '').toString();
    const stock  = r[2];
    const precio = r[4];
    if (typeof precio !== 'number' || precio <= 0) continue;
    const medida = normalizarMedida(desc) || '';
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const auth  = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('📂 Listando carpeta Drive...');
  const archivos = await listarCarpeta(drive);
  console.log('Archivos encontrados:', archivos.map(f => f.name).join(', '));

  const archivoInventario = encontrarArchivo(archivos, ['inv', 'gallo'])
    || encontrarArchivo(archivos, ['inventario'])
    || encontrarArchivo(archivos, ['gallo'], ['michelin', 'lista', 'precio']);
  const archivoCelsur     = encontrarArchivo(archivos, ['celsur']);
  const archivoMichelin   = encontrarArchivo(archivos, ['michelin', 'bfgoodrich']);
  const archivoHankook    = encontrarArchivo(archivos, ['hankook']);
  const archivoYokohama   = encontrarArchivo(archivos, ['yokohama']);
  const archivoLinglong   = encontrarArchivo(archivos, ['ling']);
  const archivoNeumasur   = encontrarArchivo(archivos, ['neumasur']);

  for (const [nombre, archivo] of [
    ['Inventario Gallo', archivoInventario],
    ['Celsur', archivoCelsur],
    ['Michelin/BFG precios', archivoMichelin],
    ['Hankook', archivoHankook],
    ['Yokohama', archivoYokohama],
    ['Linglong', archivoLinglong],
    ['Neumasur', archivoNeumasur],
  ]) {
    if (!archivo) { console.error(`❌ No se encontró archivo: ${nombre}`); process.exit(1); }
  }

  console.log('📥 Descargando archivos...');
  const [wbInv, wbCelsur, wbMich, wbHank, wbYoko, wbLL, wbNex] = await Promise.all([
    descargarXlsx(drive, archivoInventario.id),
    descargarXlsx(drive, archivoCelsur.id),
    descargarXlsx(drive, archivoMichelin.id),
    descargarXlsx(drive, archivoHankook.id),
    descargarXlsx(drive, archivoYokohama.id),
    descargarXlsx(drive, archivoLinglong.id),
    descargarXlsx(drive, archivoNeumasur.id),
  ]);

  console.log('🔄 Procesando fuentes...');
  const { vicMap, norMap, precioMap, productos } = leerInventarioGallo(wbInv);
  const { caiMap: celsurStock, descMap: celsurDesc, marcaMap: celsurMarca } = leerCelsur(wbCelsur);
  const michelinPrecios    = leerMichelinPrecios(wbMich);
  const hankookData        = leerHankook(wbHank);
  const yokoData           = leerYokohama(wbYoko);
  const llData             = leerLinglong(wbLL);
  const nexenData          = leerNeumasur(wbNex);

  console.log(`  Gallo Victoria: ${Object.keys(vicMap).length} productos`);
  console.log(`  Gallo Nordelta: ${Object.keys(norMap).length} productos`);
  console.log(`  Celsur: ${Object.keys(celsurStock).length} productos`);
  console.log(`  Michelin/BFG precios: ${Object.keys(michelinPrecios).length} productos`);
  console.log(`  Hankook: ${Object.keys(hankookData.skuMap).length} SKUs`);
  console.log(`  Yokohama: ${Object.keys(yokoData.skuMap).length} SKUs`);
  console.log(`  Linglong: ${Object.keys(llData.skuMap).length} SKUs`);
  console.log(`  Nexen: ${Object.keys(nexenData.skuMap).length} SKUs`);

  console.log('📊 Leyendo hoja Bot WhatsApp...');
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  const sheetRows = sheetRes.data.values || [];

  const updates = [];
  let sinPrecio = 0, sinStock = 0;

  for (let i = 1; i < sheetRows.length; i++) {
    const r      = sheetRows[i];
    const codArt = (r[0] || '').toString().trim();
    const codAlt = (r[1] || '').toString().trim();
    const marca  = (r[3] || '').toUpperCase().trim();
    const medida = normalizarMedida(r[5]) || (r[5] || '').replace(/\s/g, '').toUpperCase();
    const fila   = i + 1;

    let stockVic = 0, stockNor = 0, stockExpr = null, precio = null;

    // Stock propio (Victoria / Nordelta) desde Inventario Gallo
    stockVic = Math.round(vicMap[codArt] || 0);
    stockNor = Math.round(norMap[codArt] || 0);

    // Precio de Gallo solo si hay stock físico en Gallo
    if ((stockVic > 0 || stockNor > 0) && precioMap[codArt]) {
      precio = precioMap[codArt];
    }

    if (marca === 'MICHELIN' || marca === 'BFGOODRICH') {
      stockExpr = calsurStockPorCAI(celsurStock, codAlt);
      // Lista oficial solo si Gallo no tiene stock propio
      const pMich = michelinPrecios[codAlt];
      if (pMich && !precio) precio = pMich;
      else if (!precio) sinPrecio++;

    } else if (marca === 'HANKOOK') {
      const skuKey = codAlt.replace(/^HA/i, '');
      const d = hankookData.skuMap[skuKey] || hankookData.medidaMap[medida];
      if (d) { stockExpr = d.stock; if (!precio) precio = d.precio; }
      else { stockExpr = 0; sinStock++; }

    } else if (marca === 'YOKOHAMA') {
      const skuKey = codAlt.replace(/^YO/i, '');
      const d = yokoData.skuMap[skuKey] || yokoData.medidaMap[medida];
      if (d) { stockExpr = d.stock; if (!precio) precio = d.precio; }
      else { stockExpr = 0; sinStock++; }

    } else if (marca === 'LINGLONG') {
      const d = llData.skuMap[codAlt] || llData.medidaMap[medida];
      if (d) { stockExpr = d.stock; if (!precio) precio = d.precio; }
      else { stockExpr = 0; sinStock++; }

    } else if (marca === 'NEXEN') {
      const skuKey = codAlt.replace(/^NE/i, '');
      const d = nexenData.skuMap[skuKey] || nexenData.medidaMap[medida];
      if (d) {
        stockExpr = d.stock;
        if (!precio) precio = d.precio;
      } else { stockExpr = 0; sinStock++; }
    }
    // Otras marcas (Giti, GTRadial, etc.): stock propio + precio del inventario Gallo

    // Si el Modelo (col E) está vacío y tenemos datos del producto, completarlo
    const modeloActual = (r[4] || '').toString().trim();
    if (!modeloActual && codArt && productos[codArt] && productos[codArt].modelo) {
      updates.push({ range: `Bot WhatsApp!E${fila}`, values: [[productos[codArt].modelo]] });
    }

    // Armar actualización como rango continuo G:J para evitar updates parciales
    const rowData = [
      stockVic,
      stockNor,
      stockExpr !== null ? stockExpr : (parseInt(r[8]) || 0),
      precio !== null ? Math.round(precio) : (parseInt(r[9]) || 0),
    ];
    updates.push({ range: `Bot WhatsApp!G${fila}:J${fila}`, values: [rowData] });
  }

  // ─── Detectar productos nuevos que no están en la hoja ───────────────────────
  const codArtsEnHoja  = new Set(sheetRows.slice(1).map(r => (r[0] || '').toString().trim()).filter(Boolean));
  const codAltsEnHoja  = new Set(sheetRows.slice(1).map(r => (r[1] || '').toString().trim()).filter(Boolean));
  const nuevos = [];

  function agregarNuevo(codArt, codAlt, desc, stockVic, stockNor, stockExpr, precio, marcaOverride = '') {
    const { marca: marcaParsed, modelo, medida } = parsearDesc(desc);
    const marca = marcaOverride || marcaParsed;
    if (!medida) return;  // sin medida reconocible no la agregamos
    nuevos.push([codArt, codAlt, desc, marca, modelo, medida, stockVic, stockNor, stockExpr, precio ? Math.round(precio) : 0]);
  }

  // 1. Inventario Gallo: productos con stock propio no están en la hoja
  for (const [codArt, prod] of Object.entries(productos)) {
    if (codArtsEnHoja.has(codArt)) continue;
    const stockVicN = Math.round(vicMap[codArt] || 0);
    const stockNorN = Math.round(norMap[codArt] || 0);
    if (stockVicN <= 0 && stockNorN <= 0) continue;
    agregarNuevo(codArt, prod.codAlt, prod.desc, stockVicN, stockNorN, 0, precioMap[codArt]);
  }

  // 2. Celsur: Michelin/BFG con stock express no están en la hoja
  for (const [cai, stock] of Object.entries(celsurStock)) {
    if (codAltsEnHoja.has(cai) || stock <= 0) continue;
    const desc   = celsurDesc[cai] || '';
    const precio = michelinPrecios[cai];
    if (!precio) continue;
    const marca  = celsurMarca[cai] || '';
    agregarNuevo('', cai, desc, 0, 0, Math.round(stock), precio, marca);
  }

  // 3. Hankook: SKUs con stock no están en la hoja
  for (const [sku, entry] of Object.entries(hankookData.skuMap)) {
    const codAlt = 'HA' + sku;
    if (codAltsEnHoja.has(codAlt) || entry.stock <= 0) continue;
    agregarNuevo('', codAlt, entry.desc || '', 0, 0, entry.stock, entry.precio);
  }

  // 4. Yokohama: SKUs con stock no están en la hoja
  for (const [sku, entry] of Object.entries(yokoData.skuMap)) {
    const codAlt = 'YO' + sku;
    if (codAltsEnHoja.has(codAlt) || entry.stock <= 0) continue;
    agregarNuevo('', codAlt, entry.desc || '', 0, 0, entry.stock, entry.precio);
  }

  // 5. Linglong: SKUs con stock no están en la hoja
  for (const [sku, entry] of Object.entries(llData.skuMap)) {
    if (codAltsEnHoja.has(sku) || entry.stock <= 0) continue;
    agregarNuevo('', sku, entry.desc || '', 0, 0, entry.stock, entry.precio);
  }

  // 6. Neumasur (Nexen): SKUs con stock no están en la hoja
  for (const [sku, entry] of Object.entries(nexenData.skuMap)) {
    const codAlt = 'NE' + sku;
    if (codAltsEnHoja.has(codAlt) || entry.stock <= 0) continue;
    agregarNuevo('', codAlt, entry.desc || '', 0, 0, entry.stock, entry.precio);
  }

  if (nuevos.length > 0) {
    console.log(`\n➕ Agregando ${nuevos.length} productos nuevos:`);
    nuevos.forEach(r => console.log(`   CodAlt:${r[1]} | ${r[3]} | ${r[5]} | Vic:${r[6]} Nor:${r[7]} Expr:${r[8]} $${r[9]}`));
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Bot WhatsApp!A:J',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: nuevos },
    });
  }

  console.log(`\n📝 Enviando ${updates.length} actualizaciones...`);
  console.log(`   Sin precio: ${sinPrecio} | Sin match stock externo: ${sinStock}`);

  // Enviar en lotes de 500
  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.slice(i, i + BATCH),
      },
    });
    process.stdout.write(`  ${Math.min(i + BATCH, updates.length)}/${updates.length}\r`);
  }

  console.log('\n✅ Sincronización completa.');
}

function calsurStockPorCAI(caiMap, codAlt) {
  if (!codAlt) return null;
  const stock = caiMap[codAlt];
  return stock !== undefined ? Math.round(stock) : null;
}

main().catch(console.error);
