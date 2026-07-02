require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw',
    range: 'Bot WhatsApp!A:F',
  });
  const rows = res.data.values || [];

  const visto = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const marca  = (r[3] || '').toLowerCase().trim();
    const medida = (r[5] || '').replace(/\s/g, '').toUpperCase();
    const modelo = (r[4] || '').toLowerCase().trim();
    const key = `${marca}|${medida}|${modelo}`;
    if (!visto[key]) visto[key] = [];
    visto[key].push({ fila: i + 1, codArt: r[0] || '', codAlt: r[1] || '', desc: r[2] || '' });
  }

  let total = 0;
  for (const [key, filas] of Object.entries(visto)) {
    if (filas.length > 1) {
      total++;
      console.log(`\nDUPLICADO: ${key}`);
      filas.forEach(f => console.log(`  Fila ${f.fila} | CodArt: ${f.codArt} | CodAlt: ${f.codAlt} | ${f.desc}`));
    }
  }
  console.log(`\nTotal duplicados: ${total}`);
}

main().catch(console.error);
