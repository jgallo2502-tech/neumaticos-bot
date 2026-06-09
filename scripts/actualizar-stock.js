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
  const str = val.toString().trim();
  // Formato argentino: punto = miles, coma = decimal (ej: 1.234.567,89)
  // Detectar si tiene coma decimal
  if (str.includes(',')) {
    // Sacar puntos de miles, cambiar coma a punto decimal
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // Sin coma: puede ser entero con puntos de miles (ej: 870.619)
  // Si tiene un solo punto y más de 3 dígitos después → es decimal
  const parts = str.split('.');
  if (parts.length === 2 && parts[1].length <= 2) {
    return parseFloat(str) || 0; // decimal real
  }
  // Si tiene puntos de miles, sacarlos
  return parseFloat(str.replace(/\./g, '')) || 0;
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

  // --- Leer todas las pestañas de precios de referencia ---
  console.log('📊 Leyendo listas de precios de referencia...');
  const TABS_PRECIOS = [
    'Turismo y Camioneta Michelin',
    'Camioneta BFG',
    'BFGoodrich Auto',
    'Michelin R14',
    'Invierno Michelin',
  ];

  const listaPreciosCAI = {};
  for (const tab of TABS_PRECIOS) {
    const listRes = await sheets.spreadsheets.values.get({ spreadsheetId: LISTA_REF_ID, range: `${tab}!A:L` });
    const listRows = listRes.data.values || [];
    // Buscar fila de encabezado (contiene 'CAI')
    let headerIdx = listRows.findIndex(r => r.some(c => (c||'').toString().trim() === 'CAI'));
    if (headerIdx === -1) continue;
    const header = listRows[headerIdx];
    const iCAIList = header.findIndex(c => (c||'').toString().trim() === 'CAI');
    const iPrecioIVA = header.findIndex(c => (c||'').toString().includes('con IVA'));
    if (iCAIList === -1 || iPrecioIVA === -1) continue;

    let count = 0;
    for (const row of listRows.slice(headerIdx + 1)) {
      const cai  = (row[iCAIList] || '').toString().trim();
      const pIVA = parseNum((row[iPrecioIVA] || '').toString().replace(/[^\d,\.]/g, ''));
      if (cai && pIVA > 0 && !listaPreciosCAI[cai]) {
        listaPreciosCAI[cai] = Math.round(pIVA / 0.8);
        count++;
      }
    }
    console.log(`   ${tab}: ${count} precios`);
  }
  console.log(`   Total con precio referencia: ${Object.keys(listaPreciosCAI).length}`);

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

  // --- Actualizar precios de productos Celsur (sin CodArt) usando lista de referencia ---
  console.log('\n💰 Actualizando precios de productos Celsur...');
  const updatesCelsur = [];
  for (let i = 1; i < botRows.length; i++) {
    const row = botRows[i];
    const codArt = (row[0] || '').toString().trim();
    const codAlt = (row[1] || '').toString().trim();
    const pActual = parseInt((row[9] || '0').toString().replace(/\D/g, '')) || 0;
    if (codArt) continue; // tiene CodArt, ya fue procesado arriba
    if (!codAlt) continue;
    const nuevoPrecio = listaPreciosCAI[codAlt];
    if (!nuevoPrecio || nuevoPrecio === pActual) continue;
    updatesCelsur.push({ range: `Bot WhatsApp!J${i + 1}`, values: [[nuevoPrecio]] });
  }

  if (updatesCelsur.length > 0) {
    for (let i = 0; i < updatesCelsur.length; i += 500) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updatesCelsur.slice(i, i + 500) },
      });
    }
    console.log(`   ✅ ${updatesCelsur.length} precios Celsur actualizados`);
  } else {
    console.log('   Sin cambios en precios Celsur');
  }

  // --- Agregar productos nuevos de Celsur (Michelin y BFGoodrich) que no están en la hoja ---
  console.log('\n🔍 Buscando productos nuevos de Celsur...');

  // CodAlternativo ya existentes en la hoja
  const codAltsExistentes = new Set(botRows.slice(1).map(r => (r[1] || '').toString().trim()).filter(Boolean));

  // Función para normalizar medida desde descripción
  function extraerMedidaDesc(desc) {
    const m = desc.match(/(\d{3})[\/\s](\d{2,3})\s*[rR]\s*(\d{2})/);
    if (m) return `${m[1]}/${m[2]}R${m[3]}`;
    const m2 = desc.match(/LT(\d{3})[\/\s](\d{2,3})\s*[rR]\s*(\d{2})/);
    if (m2) return `${m2[1]}/${m2[2]}R${m2[3]}`;
    const m3 = desc.match(/(\d{2,3})[Xx](\d{2,3}\.\d{1,2})[rR](\d{2})/);
    if (m3) return `${m3[1]}X${m3[2]}R${m3[3]}`;
    return '';
  }

  const nuevasFilas = [];
  const MARCAS_CELSUR = ['MICHELIN', 'BFGOODRICH'];

  // Términos agrícolas/industriales a excluir
  const EXCLUIR = ['AGRIBIB','MEGAXBIB','CEREXBIB','SPRAYBIB','MACHXBIB','CARGOXBIB','AXIOBIB','ULTRAFLEX','TRACBIB','BIBLOAD','POWER CL','AGIL'];

  for (const row of expRows.slice(1)) {
    const cai   = (row[iCAI] || '').toString().trim();
    const desc  = (row[iDesc] || '').toString().trim();
    const marca = (row[iMarca] || '').toString().trim().toUpperCase();
    const familia = (row[4] || '').toString().trim().toUpperCase();
    const llanta = parseInt((row[5] || '0').toString().trim()) || 0;
    const stock = parseNum(row[iStock]);

    if (!MARCAS_CELSUR.includes(marca)) continue;
    if (!familia.includes('NEUMATICO')) continue;
    if (!cai || stock <= 0) continue;
    if (codAltsExistentes.has(cai)) continue;

    // Solo rodados de auto/camioneta (13 a 24)
    if (llanta < 13 || llanta > 24) continue;

    // Excluir agrícolas/industriales por nombre
    if (EXCLUIR.some(ex => desc.toUpperCase().includes(ex))) continue;

    const medida = extraerMedidaDesc(desc);
    if (!medida) continue; // si no pudo parsear la medida, saltar

    const precio = listaPreciosCAI[cai] || 0;
    const descripcionFull = `N. ${marca} ${desc}`;

    nuevasFilas.push([
      '',           // A: CodArt
      cai,          // B: CodAlt (CAI)
      descripcionFull, // C: Descripcion
      marca,        // D: Marca
      '',           // E: Modelo
      medida,       // F: Medida
      0,            // G: Victoria
      0,            // H: Nordelta
      stock,        // I: Express
      precio,       // J: Precio
      '',           // K: Promo
    ]);
  }

  if (nuevasFilas.length === 0) {
    console.log('   No hay productos nuevos para agregar.');
  } else {
    console.log(`   Agregando ${nuevasFilas.length} productos nuevos...`);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Bot WhatsApp!A:K',
      valueInputOption: 'RAW',
      requestBody: { values: nuevasFilas },
    });
    console.log(`✅ ${nuevasFilas.length} productos nuevos agregados a la hoja.`);
    for (const f of nuevasFilas) {
      console.log(`   + ${f[2]} | Medida: ${f[5]} | Stock: ${f[8]} | Precio: ${f[9]}`);
    }
  }
}

main().catch(console.error);
