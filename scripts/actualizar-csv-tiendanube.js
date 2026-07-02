require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const CSV_IN = 'C:/Users/juani/Downloads/tiendanube-4807532-17816324106587792546642309933.csv';
const CSV_OUT = path.join('C:/Users/juani/Desktop', 'tiendanube-actualizado.csv');

// Columnas CSV (0-index): 9=Precio, 10=Precio promocional, 15=Stock(Victoria), 16=Stock(Centro de Distribución), 17=SKU
const COL_PRECIO = 9, COL_PROMO = 10, COL_STOCK_VIC = 15, COL_STOCK_CD = 16, COL_SKU = 17;

function splitCsvLineRaw(line) {
  const fields = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    let start = i;
    if (line[i] === '"') {
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { i += 2; continue; }
          else { i++; break; }
        }
        i++;
      }
    } else {
      while (i < n && line[i] !== ';') i++;
    }
    fields.push(line.slice(start, i));
    if (i < n && line[i] === ';') { i++; continue; }
    else break;
  }
  return fields;
}

function fmtPrecio(n) {
  return Math.round(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function leerBotWhatsApp() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Bot WhatsApp!A:K' });
  const rows = (res.data.values || []).slice(1);

  const porSku = new Map(); // codArt o codAlt -> { precio, vic, nor, expr }
  for (const row of rows) {
    const codArt = (row[0] || '').toString().trim();
    const codAlt = (row[1] || '').toString().trim();
    const vic    = parseInt((row[6] || '0').toString().replace(/\D/g, '')) || 0;
    const nor    = parseInt((row[7] || '0').toString().replace(/\D/g, '')) || 0;
    const expr   = parseInt((row[8] || '0').toString().replace(/\D/g, '')) || 0;
    const precio = parseInt((row[9] || '0').toString().replace(/\D/g, '')) || 0;
    if (!precio) continue;
    const datos = { precio, vic, nor, expr };
    if (codArt) porSku.set(codArt, datos);
    if (codAlt) porSku.set(codAlt, datos);
  }
  return porSku;
}

async function main() {
  console.log('Leyendo Bot WhatsApp...');
  const porSku = await leerBotWhatsApp();
  console.log(`${porSku.size} claves SKU/CodArt cargadas`);

  const txt = fs.readFileSync(CSV_IN, 'latin1');
  const lines = txt.split(/\r?\n/);

  let actualizados = 0, sinMatch = 0;
  const sinMatchList = [];

  const outLines = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { outLines.push(line); continue; }
    const fields = splitCsvLineRaw(line);
    const sku = (fields[COL_SKU] || '').trim();
    const datos = porSku.get(sku);

    if (!datos) {
      sinMatch++;
      if (sinMatchList.length < 30) sinMatchList.push({ sku, nombre: fields[1] });
      outLines.push(line);
      continue;
    }

    fields[COL_PROMO]      = fmtPrecio(datos.precio);
    fields[COL_PRECIO]     = fmtPrecio(datos.precio / 0.8);
    fields[COL_STOCK_VIC]  = (datos.vic + datos.nor).toString();
    fields[COL_STOCK_CD]   = datos.expr.toString();
    actualizados++;
    outLines.push(fields.join(';'));
  }

  fs.writeFileSync(CSV_OUT, outLines.join('\r\n'), 'latin1');
  console.log(`Actualizados: ${actualizados}`);
  console.log(`Sin match (no se tocaron): ${sinMatch}`);
  console.log('Primeros sin match:', JSON.stringify(sinMatchList, null, 2));
  console.log('CSV generado:', CSV_OUT);
}

main().catch(console.error);
