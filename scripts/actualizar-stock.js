require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const FOLDER_ID   = '1anE-HOp-5V7oqql5raZp101dZw9xIAxD';
const SHEET_ID    = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const INV_ID      = '1nVtzTANXHQP2rZP6baCRd89OV1_dGaTjdPn0F8DltIs';
const EXPRESS_ID  = '1pxGZgDxKP1Ha2sKKMYO8Uz1bgwTHbIvZb3m5FAL_xQY';
const LISTA_REF_ID = '1wqPJsfb3s8UX-dTy_sREcmce8Ubv6kde04Ntsr7n1Fc';

async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

function parseNum(val) {
  if (!val) return 0;
  return parseFloat(val.toString().replace(',', '.')) || 0;
}

async function main() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  // --- Leer inventario Victoria/Nordelta ---
  console.log('📊 Leyendo inventario...');
  const invRes = await sheets.spreadsheets.values.get({ spreadsheetId: INV_ID, range: 'A:Z' });
  const invRows = invRes.data.values || [];
  const invHeader = invRows[0];

  // Encontrar índices de columnas
  const iDeposito   = invHeader.indexOf('Deposito');
  const iCodArt     = invHeader.indexOf('CodArt');
  const iCantidad   = invHeader.indexOf('Cantidad');
  const iPrecioUnit = invHeader.indexOf('PrecioUnitario');
  const iCodAlt     = invHeader.indexOf('CodAlternativo');

  console.log(`   Filas inventario: ${invRows.length - 1}`);

  // Agrupar por CodArt: { victoria: qty, nordelta: qty, precio: num, codAlt: str }
  const stockMap = {};
  for (const row of invRows.slice(1)) {
    const deposito = (row[iDeposito] || '').toLowerCase();
    const codArt   = (row[iCodArt] || '').toString().trim();
    const cantidad = parseNum(row[iCantidad]);
    const precio   = parseNum(row[iPrecioUnit]);
    const codAlt   = (row[iCodAlt] || '').toString().trim();

    if (!codArt) continue;

    if (!stockMap[codArt]) {
      stockMap[codArt] = { victoria: 0, nordelta: 0, precio: 0, codAlt };
    }
    if (deposito.includes('victoria')) stockMap[codArt].victoria += cantidad;
    else if (deposito.includes('nordelta')) stockMap[codArt].nordelta += cantidad;

    if (precio > 0) stockMap[codArt].precio = precio;
  }

  console.log(`   Artículos únicos: ${Object.keys(stockMap).length}`);

  // --- Leer stock Express (Michelin y BFGoodrich) ---
  console.log('📊 Leyendo stock Express...');
  const expRes = await sheets.spreadsheets.values.get({ spreadsheetId: EXPRESS_ID, range: 'A:G' });
  const expRows = expRes.data.values || [];
  const expHeader = expRows[0];

  const iCAI   = expHeader.indexOf('CAI');
  const iDesc  = expHeader.indexOf('DESCRIPCION');
  const iMarca = expHeader.indexOf('MARCA');
  const iStock = expHeader.indexOf('STOCK');

  // Mapa express por CAI y descripción
  const expressMap = {}; // cai -> stock
  const expressDescMap = {}; // descripcion normalizada -> stock

  for (const row of expRows.slice(1)) {
    const cai   = (row[iCAI] || '').toString().trim();
    const desc  = (row[iDesc] || '').toString().trim().toUpperCase();
    const stock = parseNum(row[iStock]);
    if (cai) expressMap[cai] = stock;
    if (desc) expressDescMap[desc] = stock;
  }

  console.log(`   Artículos Express: ${Object.keys(expressMap).length}`);

  // --- Leer lista de precios de referencia Michelin (precio con IVA / 0.8) ---
  console.log('📊 Leyendo lista de precios de referencia...');
  const listRes = await sheets.spreadsheets.values.get({ spreadsheetId: LISTA_REF_ID, range: 'A:L' });
  const listRows = listRes.data.values || [];
  // Fila 4 es el encabezado: Sección | Serie | Llanta | CAI | Dimensión | Gama | ... | Precio con IVA
  const listHeader = listRows[3]; // índice 3 = fila 4
  const iCAIList = listHeader ? listHeader.indexOf('CAI') : 3;
  const iPrecioIVA = listHeader ? listHeader.indexOf('Precio Referencia con IVA') : 10;

  const listaPreciosCAI = {}; // CAI -> precio lista (con IVA / 0.8, sin decimales)
  for (const row of listRows.slice(4)) {
    const cai   = (row[iCAIList] || '').toString().trim();
    const pIVA  = parseNum((row[iPrecioIVA] || '').toString().replace(/[^\d,\.]/g, ''));
    if (cai && pIVA > 0) {
      listaPreciosCAI[cai] = Math.round(pIVA / 0.8);
    }
  }
  console.log(`   Artículos con precio referencia: ${Object.keys(listaPreciosCAI).length}`);

  // --- Leer hoja principal Bot WhatsApp ---
  console.log('📊 Leyendo hoja Bot WhatsApp...');
  const botRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  const botRows = botRes.data.values || [];
  console.log(`   Filas en hoja: ${botRows.length - 1}`);

  // Columnas: A=CodArt | B=CodAlt | C=Descripcion | D=Marca | E=Modelo | F=Medida
  //           G=Victoria | H=Nordelta | I=Express | J=Precio | K=Promo
  let actualizados = 0;
  let sinStock = 0;
  const updates = [];

  for (let i = 1; i < botRows.length; i++) {
    const row = botRows[i];
    const codArt  = (row[0] || '').toString().trim();
    const codAlt  = (row[1] || '').toString().trim();
    const desc    = (row[2] || '').toString().trim().toUpperCase();
    const marca   = (row[3] || '').toString().toLowerCase();

    // Buscar en inventario por CodArt
    const inv = stockMap[codArt];
    if (!inv) { sinStock++; continue; }

    const vic  = Math.floor(inv.victoria);
    const nor  = Math.floor(inv.nordelta);
    const precio = Math.round(inv.precio);

    // Buscar express: primero por CodAlt, luego por descripción
    let express = 0;
    if (codAlt && expressMap[codAlt]) {
      express = expressMap[codAlt];
    } else if (expressDescMap[desc]) {
      express = expressDescMap[desc];
    }

    // Solo actualizar Michelin y BFGoodrich en express
    if (!['michelin', 'bfgoodrich'].includes(marca)) express = 0;

    // Si el precio del inventario es 0 y hay stock express, usar lista de referencia por CAI
    if (precio === 0 && express > 0 && codAlt && listaPreciosCAI[codAlt]) {
      precio = listaPreciosCAI[codAlt];
    }

    // Guardar la fila con índice para batch update
    updates.push({
      fila: i + 1,
      vic, nor, express, precio
    });
    actualizados++;
  }

  console.log(`\n✅ Artículos a actualizar: ${actualizados}`);
  console.log(`⚠️  Sin match en inventario: ${sinStock}`);

  if (updates.length === 0) {
    console.log('Nada para actualizar.');
    return;
  }

  // --- Batch update en Google Sheets ---
  console.log('\n📝 Actualizando hoja...');

  const data = updates.map(u => ([
    {
      range: `Bot WhatsApp!G${u.fila}`,
      values: [[u.vic]]
    },
    {
      range: `Bot WhatsApp!H${u.fila}`,
      values: [[u.nor]]
    },
    {
      range: `Bot WhatsApp!I${u.fila}`,
      values: [[u.express]]
    },
    {
      range: `Bot WhatsApp!J${u.fila}`,
      values: [[u.precio]]
    }
  ])).flat();

  // Enviar en bloques de 500
  const BLOQUE = 500;
  for (let i = 0; i < data.length; i += BLOQUE) {
    const bloque = data.slice(i, i + BLOQUE);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: bloque,
      },
    });
    process.stdout.write(`   ${Math.min(i + BLOQUE, data.length)}/${data.length} rangos actualizados\r`);
  }

  console.log('\n✅ ¡Actualización completada!');
  console.log(`   Victoria/Nordelta/Express/Precio actualizados: ${actualizados} filas`);
}

main().catch(console.error);
