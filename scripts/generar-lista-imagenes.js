require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Leer productos del Bot WhatsApp
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  const rows = (res.data.values || []).slice(1);

  // 2. Leer URLs existentes en la hoja Imágenes (para no pisarlas)
  let urlsExistentes = {};
  try {
    const resImg = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Imágenes!A:D',
    });
    for (const row of (resImg.data.values || []).slice(1)) {
      const desc = (row[0] || '').trim();
      const url  = (row[3] || '').trim();
      if (desc && url) urlsExistentes[desc] = url;
    }
    console.log(`URLs existentes preservadas: ${Object.keys(urlsExistentes).length}`);
  } catch (e) {
    console.log('Hoja Imágenes no existe aún, se va a crear.');
  }

  // 3. Construir lista única por descripción
  const vistos = new Set();
  const filas = [['Descripción', 'Marca', 'Medida', 'URL Imagen']];

  for (const row of rows) {
    const desc   = (row[2] || '').trim();
    const marca  = (row[3] || '').trim();
    const medida = (row[5] || '').trim();
    if (!desc || vistos.has(desc)) continue;
    vistos.add(desc);
    filas.push([desc, marca, medida, urlsExistentes[desc] || '']);
  }

  console.log(`Modelos únicos: ${filas.length - 1}`);

  // 4. Crear o limpiar hoja Imágenes
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const hojaExiste = meta.data.sheets.some(s => s.properties.title === 'Imágenes');

  if (!hojaExiste) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Imágenes' } } }] },
    });
    console.log('Hoja "Imágenes" creada.');
  } else {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: 'Imágenes!A:D',
    });
  }

  // 5. Escribir lista
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Imágenes!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filas },
  });

  console.log(`¡Listo! ${filas.length - 1} modelos subidos a la hoja "Imágenes".`);
}

main().catch(console.error);
