/**
 * Sincronización de stock/precios de baterías Moura hacia la pestaña "Baterias"
 * del Google Sheet de presupuestos, para el módulo de "Presupuesto Baterías".
 *
 * Fuente: export de stock de baterías. OJO: este export viene en formato
 * SpreadsheetML (XML de Excel 2003) con la extensión .xls, y el archivo trae
 * el prólogo XML roto ("<xml version>" en vez de "<?xml version=\"1.0\"?>") —
 * hay que corregirlo antes de parsear o falla silenciosamente.
 * Mismas columnas Deposito/CodArt/Cantidad/PrecioUnitario/CodAlternativo/
 * Descripcion que el resto de los exports (filtros, neumáticos).
 *
 * Uso: node scripts/sincronizar-baterias.js "C:/ruta/al/inv baterias DDMMAA.xls"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const TAB_NAME = 'Baterias';
const HEADER = ['CodArt', 'Descripcion', 'CodAlternativo', 'StockVictoria', 'StockNordelta', 'StockAcassuso', 'Precio'];

const ARCHIVO = process.argv[2] || 'C:/Users/juani/Downloads/inv baterias 030826.xls';

function leerBaterias(archivo) {
  let texto = fs.readFileSync(archivo, 'utf8');
  texto = texto.replace(/^<xml version>/, '<?xml version="1.0"?>');
  const wb = XLSX.read(texto, { type: 'string' });
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1);

  const productos = new Map(); // codArt -> { codArt, desc, codAlt, victoria, nordelta, acassuso, precio }

  for (const row of data) {
    const deposito = (row[0] || '').toString().trim();
    const codArt = (row[2] || '').toString().trim();
    const cantidad = parseInt(row[6]) || 0;
    const precio = parseFloat(row[12]) || 0;
    const codAlt = (row[24] || '').toString().trim();
    const desc = (row[36] || '').toString().trim();
    if (!codArt || !desc) continue;

    if (!productos.has(codArt)) {
      productos.set(codArt, {
        codArt, desc, codAlt,
        victoria: 0, nordelta: 0, acassuso: 0,
        precio: 0,
      });
    }
    const p = productos.get(codArt);
    if (precio > 0) p.precio = precio;
    if (deposito === 'Suc. Victoria') p.victoria += cantidad;
    if (deposito === 'Suc. Nordelta') p.nordelta += cantidad;
    if (deposito === 'Suc. Acassuso') p.acassuso += cantidad;
  }

  return productos;
}

async function asegurarPestaña(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existe = meta.data.sheets.some(s => s.properties.title === TAB_NAME);
  if (existe) return;

  console.log(`Pestaña "${TAB_NAME}" no existe, creándola...`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A1:G1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] },
  });
}

async function main() {
  console.log('Leyendo', ARCHIVO);
  const productos = leerBaterias(ARCHIVO);
  console.log(`${productos.size} productos únicos encontrados`);

  const filas = [];
  for (const p of productos.values()) {
    const vic = Math.max(0, p.victoria);
    const nor = Math.max(0, p.nordelta);
    const aca = Math.max(0, p.acassuso);
    if (p.precio <= 0) continue; // sin precio no sirve para presupuestar
    filas.push([p.codArt, p.desc, p.codAlt, vic, nor, aca, p.precio]);
  }
  console.log(`${filas.length} filas a subir (con precio > 0)`);

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  await asegurarPestaña(sheets);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB_NAME}!A2:Z10000`,
  });
  console.log('Pestaña limpiada');

  for (let i = 0; i < filas.length; i += 500) {
    const bloque = filas.slice(i, i + 500);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${TAB_NAME}!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values: bloque },
    });
    console.log(`Subido bloque ${i + 1} - ${Math.min(i + 500, filas.length)}`);
  }

  console.log('Listo.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
