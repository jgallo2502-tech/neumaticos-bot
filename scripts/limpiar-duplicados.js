require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const SOLO_PREVIEW = process.argv[2] !== '--ejecutar';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:F',
  });
  const rows = res.data.values || [];

  // CodAlts que tienen al menos una fila con CodArt
  const codAltConCodArt = new Set();
  for (let i = 1; i < rows.length; i++) {
    const codArt = (rows[i][0] || '').toString().trim();
    const codAlt = (rows[i][1] || '').toString().trim();
    if (codArt && codAlt) codAltConCodArt.add(codAlt);
  }

  // Filas a eliminar: sin CodArt pero con CodAlt que ya tiene CodArt en otra fila
  const filasAEliminar = [];
  for (let i = 1; i < rows.length; i++) {
    const codArt = (rows[i][0] || '').toString().trim();
    const codAlt = (rows[i][1] || '').toString().trim();
    if (!codArt && codAlt && codAltConCodArt.has(codAlt)) {
      filasAEliminar.push({ fila: i + 1, codAlt, desc: rows[i][2] || '' });
    }
  }

  console.log(`Filas a eliminar: ${filasAEliminar.length}`);
  filasAEliminar.forEach(f => console.log(`  Fila ${f.fila} | CodAlt: ${f.codAlt} | ${f.desc}`));

  if (SOLO_PREVIEW) {
    console.log('\n→ Preview. Para ejecutar: node scripts/limpiar-duplicados.js --ejecutar');
    return;
  }

  // Eliminar de abajo para arriba para no desplazar índices
  const sheetRes = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = sheetRes.data.sheets.find(s => s.properties.title === 'Bot WhatsApp');
  const sheetId = sheet.properties.sheetId;

  const requests = filasAEliminar
    .sort((a, b) => b.fila - a.fila)
    .map(f => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: f.fila - 1, endIndex: f.fila },
      },
    }));

  // Enviar en lotes de 100
  for (let i = 0; i < requests.length; i += 100) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: requests.slice(i, i + 100) },
    });
    console.log(`  ${Math.min(i + 100, requests.length)}/${requests.length} filas eliminadas`);
  }

  console.log('✅ Limpieza completa.');
}

main().catch(console.error);
