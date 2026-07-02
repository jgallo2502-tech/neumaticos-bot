require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function main() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });

  const rows = res.data.values || [];

  for (const row of rows) {
    const desc = (row[2] || '').toLowerCase();
    if (desc.includes('265/60') && desc.includes('ltx')) {
      console.log({
        'Cod.Art': row[0],
        'Descripción': row[2],
        'Victoria': row[6],
        'Nordelta': row[7],
        'Pedido Express': row[8],
        'Precio': row[9],
      });
    }
  }
}

main().catch(console.error);
