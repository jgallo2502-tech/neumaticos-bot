require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const NEXEN_FILE = 'C:/Users/juani/Downloads/Nexen al 11-06 (1) (1).xlsx';

async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function normalizarMedida(texto) {
  if (!texto) return null;
  const t = texto.replace(/\s+/g, ' ').trim().replace(/^RF\s*/i, '');
  const mAm = t.match(/(\d{2})\s*[xX]\s*(\d{2}\.?\d*)\s*[rR]\s*(\d{2})(?:LT)?\b/i);
  if (mAm) { const ancho = parseFloat(mAm[2]).toString(); return `${mAm[1]}X${ancho}R${mAm[3]}`.toUpperCase(); }
  const m1 = t.match(/(\d{3})\s*[\/\-\s]\s*(\d{2})\s*(?:[rR][fF]?|[\/\-\s])\s*(\d{2})(C)?\b/i);
  if (m1) return `${m1[1]}/${m1[2]}R${m1[3]}${m1[4] ? 'C' : ''}`;
  const m2 = t.match(/(\d{3})(\d{2})[rR][fF]?(\d{2})(C)?\b/i);
  if (m2) return `${m2[1]}/${m2[2]}R${m2[3]}${m2[4] ? 'C' : ''}`;
  return null;
}

async function main() {
  // Leer lista de precios Nexen (Neumasur)
  const wb = XLSX.readFile(NEXEN_FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Mapear medida → precio de la lista Neumasur
  const preciosNeumasur = {};
  for (let i = 1; i < rows.length; i++) {
    const desc = (rows[i][1] || '').toString();
    const precio = rows[i][3];
    if (!precio) continue;
    const medida = normalizarMedida(desc);
    if (medida) {
      preciosNeumasur[medida] = precio;
    }
  }
  console.log('Precios Neumasur cargados:', Object.keys(preciosNeumasur).length);

  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  const sheetRows = res.data.values || [];

  const updates = [];
  for (let i = 1; i < sheetRows.length; i++) {
    const marca = (sheetRows[i][3] || '').toUpperCase();
    if (marca !== 'NEXEN') continue;

    const medidaRaw = sheetRows[i][5] || '';
    const medida = normalizarMedida(medidaRaw) || medidaRaw.replace(/\s/g, '').toUpperCase();
    const stockVic = parseInt(sheetRows[i][6]) || 0;

    // Solo actualizar si stock cero en Victoria y hay precio en Neumasur
    if (stockVic === 0 && preciosNeumasur[medida] !== undefined) {
      const nuevoPrecio = Math.round(preciosNeumasur[medida] * 1.8);
      const precioActual = sheetRows[i][9] || '';
      console.log(`Fila ${i+1} | ${medida} | actual: ${precioActual} → nuevo: ${nuevoPrecio}`);
      updates.push({
        range: `Bot WhatsApp!J${i + 1}`,
        values: [[nuevoPrecio]],
      });
    }
  }

  if (updates.length === 0) {
    console.log('No hay filas para actualizar.');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates,
    },
  });

  console.log(`\nActualizadas ${updates.length} filas.`);
}

main().catch(console.error);
