require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });

  const rows = res.data.values || [];
  const marcas = {};

  for (const row of rows.slice(1)) {
    const marca  = (row[3] || '').trim();
    const precio = parseInt((row[9] || '0').toString().replace(/\D/g, '')) || 0;
    const vic    = parseInt((row[6] || '0').toString().replace(/\D/g, '')) || 0;
    const nor    = parseInt((row[7] || '0').toString().replace(/\D/g, '')) || 0;
    const expr   = parseInt((row[8] || '0').toString().replace(/\D/g, '')) || 0;

    if (!marca) continue;
    if (!marcas[marca]) marcas[marca] = { cant: 0, minPrecio: Infinity, maxPrecio: 0, conStock: 0 };

    marcas[marca].cant++;
    if (precio > 0) {
      marcas[marca].minPrecio = Math.min(marcas[marca].minPrecio, precio);
      marcas[marca].maxPrecio = Math.max(marcas[marca].maxPrecio, precio);
    }
    if (vic + nor + expr > 0) marcas[marca].conStock++;
  }

  const fmt = n => n.toLocaleString('es-AR');

  console.log('\n📊 RESUMEN DE PRECIOS Y STOCK POR MARCA\n');
  console.log('Marca'.padEnd(20) + 'Productos'.padEnd(12) + 'Con stock'.padEnd(12) + 'Precio mín'.padEnd(16) + 'Precio máx');
  console.log('─'.repeat(75));

  const sorted = Object.entries(marcas).sort((a, b) => b[1].cant - a[1].cant);
  for (const [marca, d] of sorted) {
    const min = d.minPrecio === Infinity ? '-' : '$' + fmt(d.minPrecio);
    const max = d.maxPrecio === 0 ? '-' : '$' + fmt(d.maxPrecio);
    console.log(
      marca.padEnd(20) +
      d.cant.toString().padEnd(12) +
      d.conStock.toString().padEnd(12) +
      min.padEnd(16) +
      max
    );
  }

  console.log('─'.repeat(75));
  const total = Object.values(marcas).reduce((s, d) => s + d.cant, 0);
  const conStock = Object.values(marcas).reduce((s, d) => s + d.conStock, 0);
  console.log(`${'TOTAL'.padEnd(20)}${total.toString().padEnd(12)}${conStock}`);
}

main().catch(console.error);
