require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

const MARCAS_CONOCIDAS = ['MICHELIN','BFGOODRICH','YOKOHAMA','GITI','GTRADIAL','NEXEN','HANKOOK',
  'LINGLONG','DUNLOP','PIRELLI','GOODYEAR','CONTINENTAL','BRIDGESTONE','FATE',
  'WESTLAKE','TRACMAX','SUNNY','CHAOYANG','TOYO','KUMHO','FALKEN','FIRESTONE',
  'COOPER','MAXXIS','NANKANG','ATLAS','TRIANGLE','UNIROYAL','SAILUN'];

function extraerModelo(desc) {
  let s = desc.toUpperCase().trim();
  // Quitar marca del inicio si está
  for (const m of MARCAS_CONOCIDAS) {
    if (s.startsWith(m)) { s = s.slice(m.length).trim(); break; }
  }
  // Quitar medida: 205/55R16, 205/55 R16, LT265/65R17, etc.
  s = s.replace(/\bLT\d{3}\/\d{2}\s*R\s*\d{2}C?\b/g, '');
  s = s.replace(/\b\d{3}\/\d{2}\s*R\s*\d{2}C?\b/g, '');
  s = s.replace(/\b\d{3}\/\d{2}ZR\d{2}\b/g, '');
  // Quitar índice de carga/velocidad: 88H, 114T, 112/110R, etc.
  s = s.replace(/\b\d{2,3}\/\d{2,3}[A-Z]\b/g, '');
  s = s.replace(/\b\d{2,3}[A-Z]{1,2}\b/g, '');
  // Quitar XL, TL, SL, C, N0, N1, MO, AO, RFT, RF
  s = s.replace(/\b(XL|TL|SL|RWL|RBL|RFT|RF|N[0-9]|MO|AO|VOL|SSR)\b/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

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

  // 2. Leer URLs existentes para preservarlas
  let urlsExistentes = {};
  try {
    const resImg = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Imágenes!A:C',
    });
    for (const row of (resImg.data.values || []).slice(1)) {
      const key = (row[0] || '').trim() + '|' + (row[1] || '').trim();
      const url = (row[2] || '').trim();
      if (key && url) urlsExistentes[key] = url;
    }
    console.log(`URLs existentes preservadas: ${Object.keys(urlsExistentes).length}`);
  } catch (e) {
    console.log('Hoja Imágenes no existe aún, se va a crear.');
  }

  // 3. Agrupar por Marca + Modelo
  const modelos = new Map(); // "MARCA|MODELO" → true
  for (const row of rows) {
    const desc  = (row[2] || '').trim();
    const marca = (row[3] || '').trim();
    if (!desc || !marca) continue;
    const modelo = extraerModelo(desc);
    if (!modelo) continue;
    const key = marca.toUpperCase() + '|' + modelo;
    if (!modelos.has(key)) modelos.set(key, { marca, modelo });
  }

  // 4. Ordenar por marca y modelo
  const lista = [...modelos.values()].sort((a, b) => {
    const mc = a.marca.localeCompare(b.marca);
    return mc !== 0 ? mc : a.modelo.localeCompare(b.modelo);
  });

  console.log(`Modelos únicos: ${lista.length}`);

  // 5. Construir filas con URLs preservadas
  const filas = [['Marca', 'Modelo', 'URL Imagen']];
  for (const { marca, modelo } of lista) {
    const key = marca.toUpperCase() + '|' + modelo;
    filas.push([marca, modelo, urlsExistentes[key] || '']);
  }

  // 6. Crear/limpiar hoja Imágenes
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
      range: 'Imágenes!A:C',
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Imágenes!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: filas },
  });

  console.log(`¡Listo! ${lista.length} modelos subidos a la hoja "Imágenes".`);
}

main().catch(console.error);
