require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const ARCHIVO = 'C:/Users/juani/Downloads/Nexen al 11-06 (1).xlsx';
const MARKUP = 1.8;

async function main() {
  const wb = XLSX.readFile(ARCHIVO, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1);

  // Detectar filas con celda C en verde (92D050) = stock disponible sin cantidad
  const verdes = new Set();
  for (const [addr, cell] of Object.entries(ws)) {
    if (!addr.startsWith('C')) continue;
    const rowNum = parseInt(addr.slice(1));
    if (rowNum < 2) continue;
    if (cell.s && cell.s.fgColor && cell.s.fgColor.rgb === '92D050' && !cell.v) {
      verdes.add(rowNum - 2); // índice en data (0-based, ya sin header)
    }
  }

  const filas = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const codigo = row[0] || '';
    const desc   = (row[1] || '').trim();
    const stockNum = parseInt(row[2]) || 0;
    const stock  = stockNum > 0 ? stockNum : (verdes.has(i) ? 99 : 0);
    const costo  = parseFloat(row[3]) || 0;

    if (!desc || !costo) continue;

    // Extraer medida (todo antes de "NEXEN")
    const idxNexen = desc.toUpperCase().indexOf('NEXEN');
    const medida = idxNexen > 0 ? desc.slice(0, idxNexen).trim() : '';
    const modelo = idxNexen >= 0 ? desc.slice(idxNexen + 6).trim() : desc;

    const precio = Math.round(costo * MARKUP);

    filas.push([
      codigo,   // A - Cod.Art
      '',       // B - Cod.Alt
      desc,     // C - Descripción
      'Nexen',  // D - Marca
      modelo,   // E - Modelo
      medida,   // F - Medida
      0,        // G - Victoria
      0,        // H - Nordelta
      stock,    // I - Pedido Express
      precio,   // J - Precio
      '',       // K - Promoción
    ]);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Primero eliminar filas Nexen existentes si las hay
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:D',
  });
  const rows = existing.data.values || [];
  // Encontrar filas a borrar (marca = Nexen), de atrás para adelante
  const aBorrar = [];
  rows.forEach((r, i) => {
    if (i === 0) return;
    if ((r[3] || '').toLowerCase() === 'nexen') aBorrar.push(i + 1); // 1-based
  });

  if (aBorrar.length > 0) {
    const tabId = await getSheetId(sheets, SHEET_ID, 'Bot WhatsApp');
    const requests = aBorrar.reverse().map(rowNum => ({
      deleteDimension: {
        range: {
          sheetId: tabId,
          dimension: 'ROWS',
          startIndex: rowNum - 1,
          endIndex: rowNum,
        },
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
    console.log(`Eliminadas ${aBorrar.length} filas Nexen anteriores`);
  }

  // Agregar las nuevas filas
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filas },
  });

  console.log(`Subidas ${filas.length} filas de Nexen (${filas.filter(f => f[8] > 0).length} con stock)`);
}

async function getSheetId(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  return sheet ? sheet.properties.sheetId : 0;
}

main().catch(console.error);
