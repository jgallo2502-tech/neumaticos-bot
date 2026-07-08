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

function normalizarCodAlt(codAlt) {
  if (!codAlt) return '';
  let s = codAlt.toString().trim().toUpperCase().replace(/\s+/g, '');
  if (/^YO(?=\d)/.test(s)) s = s.slice(2);
  if (/^HA(?=\d)/.test(s)) s = s.slice(2);
  if (/^NE(?=\d)/.test(s)) s = s.slice(2);
  return s;
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
    // Buscar fila de header (la que contiene "Precio Mostrador Gallo")
    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      if (rows[i].some(h => /precio mostrador gallo/i.test((h || '').toString()))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      console.log(`  ⚠️  Sin columna "Precio Mostrador Gallo" en hoja: ${sheetName}`);
      continue;
    }
    const header = rows[headerIdx];
    const pmgCol = header.findIndex(h => /precio mostrador gallo/i.test((h || '').toString()));
    const caiCol = header.findIndex(h => /^cai$/i.test((h || '').toString().trim()));
    const caiColFinal = caiCol !== -1 ? caiCol : 3; // fallback col 3
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const cai   = r[caiColFinal] ? r[caiColFinal].toString().trim() : null;
      const precio = r[pmgCol];
      if (cai && typeof precio === 'number' && precio > 0) {
        caiMap[cai] = precio;
      }
    }
  }
  return caiMap;
}

// ─── Helper: encontrar columna por nombre de header ──────────────────────────
// Busca en las primeras 'maxRows' filas la que tenga un header que matchee algún
// patrón. Devuelve { headerIdx, colIdx } o null si no encuentra.
function encontrarColumna(rows, patronesHeader, maxRows = 10) {
  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    const idx = rows[i].findIndex(h => patronesHeader.some(p => p.test((h || '').toString())));
    if (idx !== -1) return { headerIdx: i, colIdx: idx };
  }
  return null;
}

// ─── Leer Hankook — match por SKU (CodAlt del sheet = "HA" + Cod. producto) ──
function leerHankook(wb) {
  const sheetName = wb.SheetNames.find(s => /hankook|lista/i.test(s)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  // Encontrar fila de header buscando columna PMG
  const pmgInfo = encontrarColumna(rows, [/^pmg$/i, /precio mostrador gallo/i]);
  if (!pmgInfo) { console.error('❌ Hankook: no se encontró columna PMG'); return { skuMap: {}, medidaMap: {} }; }

  const header = rows[pmgInfo.headerIdx];
  const col = nombre => header.findIndex(h => nombre.test((h || '').toString()));

  const colPMG   = pmgInfo.colIdx;
  const colStock = col(/^stock$/i);
  const colCod   = col(/cod\.?\s*producto/i);
  const colDesc  = col(/descripci[oó]n\s*larga/i);
  const colPisada = col(/^pisada$/i);
  const colTalon  = col(/^tal[oó]n$/i);
  const colRodado = col(/^rodado$/i);
  const colDiseno = col(/^dise[nñ]o$/i);

  if (colStock === -1) console.warn('⚠️  Hankook: columna Stock no encontrada, usando 0');
  if (colCod === -1)   { console.error('❌ Hankook: columna Cod. producto no encontrada'); return { skuMap: {}, medidaMap: {} }; }

  console.log(`  Hankook cols — PMG:${colPMG} Stock:${colStock} Cod:${colCod} Desc:${colDesc} Pisada:${colPisada}`);

  const skuMap = {}, medidaMap = {};
  for (let i = pmgInfo.headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const cod = colCod !== -1 ? (r[colCod] || '').toString().trim() : '';
    if (!cod || /^cod/i.test(cod)) continue;
    const precio = r[colPMG];
    if (typeof precio !== 'number' || precio <= 0) continue;
    const stock = colStock !== -1 ? r[colStock] : undefined;
    const pisada = colPisada !== -1 ? r[colPisada] : '';
    const talon  = colTalon  !== -1 ? r[colTalon]  : '';
    const rodado = colRodado !== -1 ? r[colRodado] : '';
    const medida = normalizarMedida(`${pisada}/${talon}R${rodado}`) || '';
    const descLarga = colDesc !== -1 ? (r[colDesc] || '').toString().trim() : '';
    const diseño    = colDiseno !== -1 ? (r[colDiseno] || '').toString().trim() : '';
    const desc = descLarga || (medida && diseño ? `HANKOOK ${medida} ${diseño}` : '');
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Yokohama — match por SKU (CodAlt = "YO" + CODIGO) ──────────────────
function leerYokohama(wb) {
  const sheetName = wb.SheetNames.find(s => /hoja1/i.test(s)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  const pmgInfo = encontrarColumna(rows, [/^pmg$/i, /precio mostrador gallo/i]);
  if (!pmgInfo) { console.error('❌ Yokohama: no se encontró columna PMG'); return { skuMap: {}, medidaMap: {} }; }

  const header = rows[pmgInfo.headerIdx];
  const col = patron => header.findIndex(h => patron.test((h || '').toString()));

  const colPMG    = pmgInfo.colIdx;
  const colStock  = col(/^stock$/i);
  const colCod    = col(/^c[oó]digo$|^cod\.?$|^codigo$/i);
  const colDesc   = col(/descripci[oó]n\s*larga/i);
  const colMedida = col(/^medida$/i);

  if (colStock === -1) console.warn('⚠️  Yokohama: columna Stock no encontrada, usando 0');
  if (colCod === -1)   { console.error('❌ Yokohama: columna Código no encontrada'); return { skuMap: {}, medidaMap: {} }; }

  console.log(`  Yokohama cols — PMG:${colPMG} Stock:${colStock} Cod:${colCod} Desc:${colDesc} Medida:${colMedida}`);

  const skuMap = {}, medidaMap = {};
  for (let i = pmgInfo.headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const cod = colCod !== -1 ? (r[colCod] || '').toString().trim() : '';
    if (!cod || /^c[oó]d/i.test(cod)) continue;
    const precio = r[colPMG];
    if (typeof precio !== 'number' || precio <= 0) continue;
    const stock = colStock !== -1 ? r[colStock] : undefined;
    const medidaRaw = colMedida !== -1 ? (r[colMedida] || '').toString() : '';
    const medida = normalizarMedida(medidaRaw) || '';
    const desc = colDesc !== -1 ? (r[colDesc] || '').toString().trim() : '';
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Linglong — match por SKU (CodAlt = MATERIAL directamente) ──────────
function leerLinglong(wb) {
  const sheetName = wb.SheetNames.find(s => /lista/i.test(s)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  // Linglong: buscar columna PMG (col con nombre "PMG" o "Precio Mostrador Gallo")
  const pmgInfo = encontrarColumna(rows, [/^pmg$/i, /precio mostrador gallo/i]);
  if (!pmgInfo) { console.error('❌ Linglong: no se encontró columna PMG'); return { skuMap: {}, medidaMap: {} }; }

  const header = rows[pmgInfo.headerIdx];
  const col = patron => header.findIndex(h => patron.test((h || '').toString()));

  const colPMG   = pmgInfo.colIdx;
  const colStock = col(/^stock$/i);
  const colCod   = col(/^material$|^c[oó]d/i);
  const colDesc  = col(/^descripci[oó]n$|^desc/i);

  // Fallback: si no hay header claro, usar posiciones conocidas del formato actual
  const colCodFinal  = colCod  !== -1 ? colCod  : 0;
  const colDescFinal = colDesc !== -1 ? colDesc : 1;
  const colStockFinal = colStock !== -1 ? colStock : -1;

  if (colStockFinal === -1) console.warn('⚠️  Linglong: columna Stock no encontrada, usando 0');
  console.log(`  Linglong cols — PMG:${colPMG} Stock:${colStockFinal} Cod:${colCodFinal} Desc:${colDescFinal}`);

  const skuMap = {}, medidaMap = {};
  for (let i = pmgInfo.headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r[colCodFinal] || '').toString() === 'MATERIAL') continue;
    const precio = r[colPMG];
    if (!r[colDescFinal] || typeof precio !== 'number' || precio <= 0) continue;
    const cod   = (r[colCodFinal] || '').toString().trim();
    const desc  = r[colDescFinal].toString().trim();
    const stock = colStockFinal !== -1 ? r[colStockFinal] : undefined;
    const medida = normalizarMedida(desc) || '';
    const entry = { stock: stockExterno(stock), precio, desc, medida };
    if (cod) skuMap[cod] = entry;
    if (medida) medidaMap[medida] = entry;
  }
  return { skuMap, medidaMap };
}

// ─── Leer Neumasur (Nexen) — match por SKU (CodAlt = "NE" + codigo) ──────────
function leerNeumasur(wb) {
  const sheetName = wb.SheetNames.find(s => /nexen/i.test(s)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });

  // Buscar header por columna PMG
  const pmgInfo = encontrarColumna(rows, [/^pmg$/i, /precio mostrador gallo/i]);
  if (!pmgInfo) { console.error('❌ Neumasur: no se encontró columna PMG'); return { skuMap: {}, medidaMap: {} }; }

  const header = rows[pmgInfo.headerIdx];
  const col = patron => header.findIndex(h => patron.test((h || '').toString()));

  const colPMG   = pmgInfo.colIdx;
  const colStock = col(/^stock$/i);
  const colCod   = col(/^c[oó]d|^material/i);
  const colDesc  = col(/^descripci[oó]n|^desc/i);

  const colCodFinal  = colCod  !== -1 ? colCod  : 0;
  const colDescFinal = colDesc !== -1 ? colDesc : 1;

  if (colStock === -1) console.warn('⚠️  Neumasur: columna Stock no encontrada, usando 0');
  console.log(`  Neumasur cols — PMG:${colPMG} Stock:${colStock} Cod:${colCodFinal} Desc:${colDescFinal}`);

  const skuMap = {}, medidaMap = {};
  for (let i = pmgInfo.headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const cod   = r[colCodFinal] ? r[colCodFinal].toString().trim() : null;
    const desc  = (r[colDescFinal] || '').toString();
    const stock = colStock !== -1 ? r[colStock] : undefined;
    const precio = r[colPMG];
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
  const archivoCelsur     = encontrarArchivo(archivos, ['celsur'])
    || encontrarArchivo(archivos, ['stock_disponible'])
    || encontrarArchivo(archivos, ['stock'], ['inv', 'gallo', 'hankook', 'yokohama', 'ling', 'nexen', 'neumasur', 'michelin']);
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
  ]) {
    if (!archivo) { console.error(`❌ No se encontró archivo: ${nombre}`); process.exit(1); }
  }
  if (!archivoNeumasur) console.log('⚠️  Neumasur no encontrado — Nexen sin actualizar');

  console.log('📥 Descargando archivos...');
  const [wbInv, wbCelsur, wbMich, wbHank, wbYoko, wbLL] = await Promise.all([
    descargarXlsx(drive, archivoInventario.id),
    descargarXlsx(drive, archivoCelsur.id),
    descargarXlsx(drive, archivoMichelin.id),
    descargarXlsx(drive, archivoHankook.id),
    descargarXlsx(drive, archivoYokohama.id),
    descargarXlsx(drive, archivoLinglong.id),
  ]);
  const wbNex = archivoNeumasur ? await descargarXlsx(drive, archivoNeumasur.id) : null;

  console.log('🔄 Procesando fuentes...');
  const { vicMap, norMap, precioMap, productos } = leerInventarioGallo(wbInv);
  const { caiMap: celsurStock, descMap: celsurDesc, marcaMap: celsurMarca } = leerCelsur(wbCelsur);
  const michelinPrecios    = leerMichelinPrecios(wbMich);
  const hankookData        = leerHankook(wbHank);
  const yokoData           = leerYokohama(wbYoko);
  const llData             = leerLinglong(wbLL);
  const nexenData          = wbNex ? leerNeumasur(wbNex) : { skuMap: {}, medidaMap: {} };

  console.log(`  Gallo Victoria: ${Object.keys(vicMap).length} productos`);
  console.log(`  Gallo Nordelta: ${Object.keys(norMap).length} productos`);
  console.log(`  Celsur: ${Object.keys(celsurStock).length} productos`);
  console.log(`  Michelin/BFG precios: ${Object.keys(michelinPrecios).length} productos`);
  console.log(`  Hankook: ${Object.keys(hankookData.skuMap).length} SKUs`);
  console.log(`  Yokohama: ${Object.keys(yokoData.skuMap).length} SKUs`);
  console.log(`  Linglong: ${Object.keys(llData.skuMap).length} SKUs`);
  console.log(`  Nexen: ${Object.keys(nexenData.skuMap).length} SKUs (${wbNex ? 'actualizado' : 'sin archivo'})`);

  console.log('📊 Leyendo hoja Bot WhatsApp...');
  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  let sheetRows = sheetRes.data.values || [];

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
      if (pMich && precio === null) {
        precio = pMich;
      } else if (precio === null) {
        precio = 0;
        sinPrecio++;
      }

    } else if (marca === 'HANKOOK') {
      const skuKey = codAlt.replace(/^HA/i, '');
      const dSku = hankookData.skuMap[skuKey];
      const d = dSku || (!codArt ? hankookData.medidaMap[medida] : null);
      if (d) {
        stockExpr = d.stock;
        if (precio === null) precio = d.precio || 0;
      } else {
        stockExpr = 0;
        if (precio === null) precio = 0;
        sinStock++;
      }

    } else if (marca === 'YOKOHAMA') {
      const skuKey = codAlt.replace(/^YO/i, '');
      const dSku = yokoData.skuMap[skuKey];
      const d = dSku || (!codArt ? yokoData.medidaMap[medida] : null);
      if (d) {
        stockExpr = d.stock;
        if (precio === null) precio = d.precio || 0;
      } else {
        stockExpr = 0;
        if (precio === null) precio = 0;
        sinStock++;
      }

    } else if (marca === 'LINGLONG') {
      const dSku = llData.skuMap[codAlt];
      const d = dSku || (!codArt ? llData.medidaMap[medida] : null);
      if (d) {
        stockExpr = d.stock;
        if (precio === null) precio = d.precio || 0;
      } else {
        stockExpr = 0;
        if (precio === null) precio = 0;
        sinStock++;
      }

    } else if (marca === 'NEXEN') {
      const skuKey = codAlt.replace(/^NE/i, '');
      const dSku = nexenData.skuMap[skuKey];
      const d = dSku || (!codArt ? nexenData.medidaMap[medida] : null);
      if (d) {
        stockExpr = d.stock;
        if (precio === null) precio = d.precio || 0;
      } else {
        stockExpr = 0;
        if (precio === null) precio = 0;
        sinStock++;
      }
    }
    // Otras marcas (Giti, GTRadial, etc.): stock propio + precio del inventario Gallo

    // Si el Modelo (col E) está vacío y tenemos datos del producto, completarlo
    const modeloActual = (r[4] || '').toString().trim();
    if (!modeloActual && codArt && productos[codArt] && productos[codArt].modelo) {
      updates.push({ range: `Bot WhatsApp!E${fila}`, values: [[productos[codArt].modelo]] });
    }

    // ─── Chequeo y corrección de descripción (col C) desde archivo fuente ────────
    {
      const descHoja = (r[2] || '').toString().trim();
      let descFuente = null;
      if (marca === 'LINGLONG') {
        const d = llData.skuMap[codAlt]; if (d) descFuente = d.desc;
      } else if (marca === 'HANKOOK') {
        const key = codAlt.replace(/^HA/i, '');
        const d = hankookData.skuMap[key]; if (d) descFuente = d.desc;
      } else if (marca === 'YOKOHAMA') {
        const key = codAlt.replace(/^YO/i, '');
        const d = yokoData.skuMap[key]; if (d) descFuente = d.desc;
      }
      if (descFuente) {
        const normD = s => s.toLowerCase().replace(/green[- ]?max/g,'greenmax').replace(/sport[- ]?master/g,'sportmaster').replace(/grip[- ]?master/g,'gripmaster').replace(/\s+/g,' ').replace(/[-]/g,'').trim();
        if (normD(descFuente) !== normD(descHoja)) {
          updates.push({ range: `Bot WhatsApp!C${fila}`, values: [[descFuente]] });
          console.log(`  📝 Desc corregida fila ${fila}: ${descHoja} → ${descFuente}`);
        }
      }
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
  const codAltsEnHoja  = new Set(sheetRows.slice(1).map(r => normalizarCodAlt(r[1] || '')).filter(Boolean));
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
    const refreshed = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Bot WhatsApp!A:K',
    });
    sheetRows = refreshed.data.values || [];
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

  // Limpiar duplicados por CodAlt para que el archivo quede depurado
  const filasDuplicadas = [];
  const keep = new Map();
  for (let i = 1; i < sheetRows.length; i++) {
    const fila = i + 1;
    const codArt = (sheetRows[i][0] || '').toString().trim();
    const codAltRaw = (sheetRows[i][1] || '').toString().trim();
    const codAlt = normalizarCodAlt(codAltRaw);
    if (!codAlt) continue;
    const tieneCodArt = Boolean(codArt);
    if (!keep.has(codAlt)) {
      keep.set(codAlt, { fila, tieneCodArt });
      continue;
    }
    const existente = keep.get(codAlt);
    if (!existente.tieneCodArt && tieneCodArt) {
      filasDuplicadas.push(existente.fila);
      keep.set(codAlt, { fila, tieneCodArt });
    } else {
      filasDuplicadas.push(fila);
    }
  }

  if (filasDuplicadas.length > 0) {
    console.log(`\n🧹 Eliminando ${filasDuplicadas.length} filas duplicadas por CodAlt...`);
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === 'Bot WhatsApp');
    const sheetId = sheet.properties.sheetId;
    const requests = filasDuplicadas
      .sort((a, b) => b - a)
      .map(fila => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila },
        },
      }));

    for (let i = 0; i < requests.length; i += 100) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: requests.slice(i, i + 100) },
      });
      process.stdout.write(`  ${Math.min(i + 100, requests.length)}/${requests.length} filas eliminadas\r`);
    }
    console.log('\n✅ Duplicados eliminados.');
  }

  console.log('\n✅ Sincronización completa.');
}

function calsurStockPorCAI(caiMap, codAlt) {
  if (!codAlt) return null;
  const stock = caiMap[codAlt];
  return stock !== undefined ? Math.round(stock) : null;
}

main().catch(console.error);
