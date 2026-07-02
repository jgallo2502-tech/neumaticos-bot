require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
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

  const rows = (res.data.values || []).slice(1);
  const botSet = new Set();
  for (const row of rows) {
    const cod = (row[0] || '').toString().trim();
    if (cod) botSet.add(cod);
  }

  console.log('Bot WhatsApp - Cod.Art unicos:', botSet.size);

  const invPath = 'C:/Users/juani/Desktop/INV 160626 actualizado.xlsx';
  const wb = XLSX.readFile(invPath);
  const ws = wb.Sheets['Sheet1'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const VALID_DEPOSITOS = new Set(['Suc. Victoria', 'Suc. Nordelta']);

  const totals = new Map(); // codArt -> {cantidad, descripcion}

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    const deposito = (row[0] || '').toString().trim();
    if (!VALID_DEPOSITOS.has(deposito)) continue;

    const codArt = (row[2] || '').toString().trim();
    if (!codArt) continue;

    const cantidad = parseFloat((row[6] || '0').toString().replace(',', '.')) || 0;

    let descripcion = (row[36] || '').toString().trim();
    if (descripcion.startsWith('N. ')) descripcion = descripcion.slice(3);

    if (!totals.has(codArt)) {
      totals.set(codArt, { cantidad: 0, descripcion });
    }
    const entry = totals.get(codArt);
    entry.cantidad += cantidad;
    if (!entry.descripcion && descripcion) entry.descripcion = descripcion;
  }

  const missing = [];
  for (const [codArt, info] of totals.entries()) {
    if (info.cantidad > 0 && !botSet.has(codArt)) {
      missing.push({ CodArt: codArt, Descripcion: info.descripcion, Cantidad: info.cantidad });
    }
  }

  missing.sort((a, b) => a.CodArt.localeCompare(b.CodArt));

  console.log('Total CodArt con stock>0 (Victoria+Nordelta):', [...totals.values()].filter(v => v.cantidad > 0).length);
  console.log('Faltantes en Bot WhatsApp:', missing.length);
  console.log('--- Primeros 60 ---');
  console.log(JSON.stringify(missing.slice(0, 60), null, 2));
}

main().catch(console.error);
