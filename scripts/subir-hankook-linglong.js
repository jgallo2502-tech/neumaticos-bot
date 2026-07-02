require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const MARKUP = 1.8;

function parseStock(val) {
  if (!val && val !== 0) return 0;
  const s = val.toString().toLowerCase().trim();
  if (s === 'ok' || s === 'nuevo ingreso') return 99;
  if (s === 'ultima unidad') return 1;
  const n = parseInt(val);
  return isNaN(n) ? 0 : n;
}

function buildHankook() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/LP Hankook 11.06.26.xlsx', { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(2);

  const filas = [];
  for (const row of data) {
    const codigo  = row[1];
    if (!codigo || typeof codigo !== 'string') continue;
    const volumen = parseFloat(row[14]);
    if (!volumen) continue;

    const pisada  = row[2], talon = row[3], rodado = row[4];
    const medida  = (pisada && talon && rodado) ? `${pisada}/${talon}R${rodado}` : '';
    const desc    = (row[6] || '').trim();
    const modelo  = (row[8] || '').trim();
    const stock   = parseStock(row[10]);
    const precio  = Math.round(volumen * MARKUP);

    filas.push([codigo, '', desc, 'Hankook', modelo, medida, 0, 0, stock, precio, '']);
  }
  return filas;
}

function buildLinglong() {
  const wb = XLSX.readFile('C:/Users/juani/Downloads/Ling Long 1-6.xlsx', { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(3);

  const filas = [];
  for (const row of data) {
    const codigo = row[0];
    if (!codigo || typeof codigo !== 'string') continue;
    const volumen = parseFloat(row[5]);
    if (!volumen) continue;
    if ((row[6] || '').toString() === 'STOCK') continue;

    const desc   = (row[1] || '').trim();
    const medida = desc.split(' ')[0];
    const modelo = desc.replace('LINGLONG', '').replace(medida, '').trim();
    const stock  = parseStock(row[6]);
    const precio = Math.round(volumen * MARKUP);

    filas.push([codigo, '', desc, 'Linglong', modelo, medida, 0, 0, stock, precio, '']);
  }
  return filas;
}

async function main() {
  const hankook  = buildHankook();
  const linglong = buildLinglong();
  console.log(`Hankook: ${hankook.length} filas | Linglong: ${linglong.length} filas`);

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Leer marcas existentes para borrar
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:D',
  });
  const rows = existing.data.values || [];
  const marcasBorrar = new Set(['hankook', 'linglong']);
  const aBorrar = [];
  rows.forEach((r, i) => {
    if (i === 0) return;
    if (marcasBorrar.has((r[3] || '').toLowerCase())) aBorrar.push(i + 1);
  });

  if (aBorrar.length > 0) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabId = meta.data.sheets.find(s => s.properties.title === 'Bot WhatsApp').properties.sheetId;
    const requests = aBorrar.reverse().map(rowNum => ({
      deleteDimension: {
        range: { sheetId: tabId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
      },
    }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    console.log(`Eliminadas ${aBorrar.length} filas anteriores`);
  }

  const todasLasFilas = [...hankook, ...linglong];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: todasLasFilas },
  });

  console.log(`Subidas ${todasLasFilas.length} filas en total`);
}

main().catch(console.error);
