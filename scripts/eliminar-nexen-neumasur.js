require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const CREDS_PATH = path.join(__dirname, '../credentials.json');

async function getAuth() {
  const auth = new google.auth.GoogleAuth({ keyFile: CREDS_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return auth.getClient();
}

async function main() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:D',
  });
  const rows = res.data.values || [];

  // Filas a eliminar: marca NEXEN y CodAlt empieza con NE (de Neumasur, no de Gallo)
  const aBorrar = [];
  for (let i = 1; i < rows.length; i++) {
    const codAlt = (rows[i][1] || '').toString().trim();
    const marca  = (rows[i][3] || '').toString().trim().toUpperCase();
    if (marca === 'NEXEN' && /^NE/i.test(codAlt)) {
      aBorrar.push(i + 1); // 1-based
    }
  }

  if (aBorrar.length === 0) {
    console.log('No hay filas Nexen/Neumasur para eliminar.');
    return;
  }

  console.log(`Eliminando ${aBorrar.length} filas Nexen (Neumasur) con CodAlt NE...`);

  // Obtener spreadsheetId de la hoja
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Bot WhatsApp');
  const sheetId = sheet.properties.sheetId;

  // Eliminar de atrás para adelante para no desplazar índices
  const requests = aBorrar.slice().reverse().map(rowNum => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum }
    }
  }));

  // En lotes de 100
  for (let i = 0; i < requests.length; i += 100) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: requests.slice(i, i + 100) }
    });
    console.log(`  ${Math.min(i + 100, requests.length)}/${requests.length} filas eliminadas`);
  }

  console.log('✅ Filas Nexen/Neumasur eliminadas.');
}

main().catch(console.error);
