require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const EJECUTAR = process.argv.includes('--ejecutar');
const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: path.join(__dirname, '../credentials.json'), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Bot WhatsApp!A:F' });
  const rows = res.data.values || [];

  // Construir set de claves que tienen CodArt
  const conCodArt = new Set();
  rows.forEach((r, i) => {
    if (i === 0) return;
    const codArt = (r[0]||'').trim();
    if (!codArt) return;
    const marca = (r[3]||'').toLowerCase().trim();
    const modelo = (r[4]||'').toLowerCase().trim();
    const medida = (r[5]||'').replace(/\s/g,'').toUpperCase();
    if (marca && modelo && medida) conCodArt.add(`${marca}|${modelo}|${medida}`);
  });

  // Encontrar filas SIN CodArt cuya clave ya existe CON CodArt
  const filasBorrar = [];
  rows.forEach((r, i) => {
    if (i === 0) return;
    const codArt = (r[0]||'').trim();
    if (codArt) return; // tiene CodArt, no tocar
    const marca = (r[3]||'').toLowerCase().trim();
    const modelo = (r[4]||'').toLowerCase().trim();
    const medida = (r[5]||'').replace(/\s/g,'').toUpperCase();
    if (!marca || !modelo || !medida) return;
    const key = `${marca}|${modelo}|${medida}`;
    if (conCodArt.has(key)) {
      filasBorrar.push({ fila: i+1, codAlt: r[1]||'', desc: (r[2]||'').substring(0,60), key });
    }
  });

  console.log(`Filas a eliminar: ${filasBorrar.length}`);
  filasBorrar.forEach(f => console.log(`  Fila ${f.fila} | CodAlt: ${f.codAlt} | ${f.key} | ${f.desc}`));

  if (!EJECUTAR) {
    console.log('\n→ Preview. Para ejecutar: node scripts/limpiar-duplicados-modelo.js --ejecutar');
    return;
  }

  // Obtener sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === 'Bot WhatsApp');
  const sheetId = sheet.properties.sheetId;

  // Borrar de abajo hacia arriba para no desplazar índices
  const filasOrden = filasBorrar.map(f => f.fila).sort((a, b) => b - a);
  const requests = filasOrden.map(fila => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila } }
  }));

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  console.log(`\n✓ Eliminadas ${filasOrden.length} filas duplicadas`);
}

main().catch(console.error);
