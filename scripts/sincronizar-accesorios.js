/**
 * Lee el archivo de inventario Gallo (mismo formato .xls SpreadsheetML que
 * el resto) y separa los productos por prefijo de CodArt:
 *   05... → Filtros
 *   06... → Frasle (pastillas de freno)
 *   21... → Baterias
 * Actualiza las tres pestañas del Google Sheet en una sola pasada.
 *
 * Uso: node scripts/sincronizar-accesorios.js "C:/ruta/al/inventario.xls"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const HEADER = ['CodArt', 'Descripcion', 'CodAlternativo', 'StockVictoria', 'StockNordelta', 'StockAcassuso', 'Precio'];

const TABS = {
  '05': 'Filtros',
  '06': 'Frasle',
  '21': 'Baterias',
};

const ARCHIVO = process.argv[2];
if (!ARCHIVO) { console.error('Falta ruta del archivo'); process.exit(1); }

function leerArchivo(archivo) {
  let wb;
  try {
    // Intenta como SpreadsheetML con prólogo roto (formato Gallo .xls)
    let texto = fs.readFileSync(archivo, 'utf8');
    texto = texto.replace(/^<xml version>/, '<?xml version="1.0"?>');
    wb = XLSX.read(texto, { type: 'string' });
  } catch {
    // Si falla, lee como xlsx normal
    wb = XLSX.readFile(archivo);
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);
}

function agruparPorPrefijo(rows) {
  const grupos = {};
  for (const prefix of Object.keys(TABS)) grupos[prefix] = new Map();

  for (const row of rows) {
    const deposito = (row[0] || '').toString().trim();
    const codArt   = (row[2] || '').toString().trim();
    const cantidad = parseInt(row[6]) || 0;
    const precio   = parseFloat(row[12]) || 0;
    const codAlt   = (row[24] || '').toString().trim();
    const desc     = (row[36] || '').toString().trim();
    if (!codArt || !desc) continue;

    const prefix = codArt.substring(0, 2);
    if (!grupos[prefix]) continue;

    const mapa = grupos[prefix];
    if (!mapa.has(codArt)) {
      mapa.set(codArt, { codArt, desc, codAlt, victoria: 0, nordelta: 0, acassuso: 0, precio: 0 });
    }
    const p = mapa.get(codArt);
    if (precio > 0) p.precio = precio;
    if (deposito === 'Suc. Victoria')  p.victoria  += cantidad;
    if (deposito === 'Suc. Nordelta')  p.nordelta  += cantidad;
    if (deposito === 'Suc. Acassuso')  p.acassuso  += cantidad;
  }

  return grupos;
}

async function asegurarPestaña(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existe = meta.data.sheets.some(s => s.properties.title === tabName);
  if (existe) return;
  console.log(`Creando pestaña "${tabName}"...`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1:G1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
}

async function subirTab(sheets, tabName, productos) {
  await asegurarPestaña(sheets, tabName);

  const filas = [];
  for (const p of productos.values()) {
    if (p.precio <= 0) continue;
    filas.push([p.codArt, p.desc, p.codAlt,
      Math.max(0, p.victoria), Math.max(0, p.nordelta), Math.max(0, p.acassuso),
      p.precio]);
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${tabName}!A2:Z10000` });
  console.log(`${tabName}: ${filas.length} productos (limpiado)`);

  for (let i = 0; i < filas.length; i += 500) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values: filas.slice(i, i + 500) },
    });
  }
  console.log(`${tabName}: ✅ subido`);
}

async function main() {
  console.log('Leyendo', ARCHIVO);
  const rows = leerArchivo(ARCHIVO);
  console.log(`${rows.length} filas en el archivo`);

  const grupos = agruparPorPrefijo(rows);
  for (const [prefix, mapa] of Object.entries(grupos)) {
    console.log(`  Prefijo ${prefix} (${TABS[prefix]}): ${mapa.size} productos únicos`);
  }

  const auth = new google.auth.GoogleAuth({
    ...(process.env.GOOGLE_CREDENTIALS
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS) }
      : { keyFile: path.join(__dirname, '../credentials.json') }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  for (const [prefix, tabName] of Object.entries(TABS)) {
    await subirTab(sheets, tabName, grupos[prefix]);
  }

  console.log('Listo.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
