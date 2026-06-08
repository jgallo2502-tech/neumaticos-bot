require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const path = require('path');

const SHEET_ID         = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';
const TN_TOKEN         = process.env.TIENDANUBE_TOKEN;
const TN_STORE_ID      = process.env.TIENDANUBE_STORE_ID;
const TN_API           = `https://api.tiendanube.com/v1/${TN_STORE_ID}`;
const TN_HEADERS       = {
  'Authentication': `bearer ${TN_TOKEN}`,
  'User-Agent': 'NeumaticosGallo/1.0 (j.gallo2502@gmail.com)',
  'Content-Type': 'application/json',
};

let fetch;

async function getFetch() {
  if (!fetch) fetch = (await import('node-fetch')).default;
  return fetch;
}

async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Leer todos los productos de Tiendanube (paginado)
async function leerProductosTN() {
  const f = await getFetch();
  const productos = [];
  let page = 1;
  while (true) {
    const res = await f(`${TN_API}/products?per_page=200&page=${page}&fields=id,variants`, { headers: TN_HEADERS });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) {
      for (const v of p.variants || []) {
        if (v.sku) productos.push({ productId: p.id, variantId: v.id, sku: v.sku.toString(), inventoryLevelId: v.inventory_levels?.[0]?.id });
      }
    }
    if (data.length < 200) break;
    page++;
    await sleep(500);
  }
  return productos;
}

// Leer hoja Google Sheets
async function leerSheet() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Bot WhatsApp!A:K' });
  const rows = res.data.values || [];
  const map = {}; // codAlt -> { precio, stockTotal }
  for (const row of rows.slice(1)) {
    const codAlt = (row[1] || '').toString().trim();
    const precio = parseInt((row[9] || '0').toString().replace(/\D/g, '')) || 0;
    const vic    = parseInt((row[6] || '0').toString().replace(/\D/g, '')) || 0;
    const nor    = parseInt((row[7] || '0').toString().replace(/\D/g, '')) || 0;
    const expr   = parseInt((row[8] || '0').toString().replace(/\D/g, '')) || 0;
    if (codAlt) map[codAlt] = { precio, stockTotal: vic + nor + expr };
  }
  return map;
}

async function main() {
  const f = await getFetch();
  console.log('📦 Leyendo productos de Tiendanube...');
  const productos = await leerProductosTN();
  console.log(`   ${productos.length} variantes encontradas`);

  console.log('📊 Leyendo precios y stock del Google Sheet...');
  const sheetMap = await leerSheet();
  console.log(`   ${Object.keys(sheetMap).length} artículos en la hoja`);

  let actualizados = 0, sinMatch = 0, errores = 0;

  for (const p of productos) {
    const datos = sheetMap[p.sku];
    if (!datos || datos.precio === 0) { sinMatch++; continue; }

    const precioLista     = datos.precio; // precio de lista (12 pagos) — va en promotional_price
    const precioTachado   = Math.round(datos.precio / 0.8); // precio "sin descuento" — va en price
    const stock = datos.stockTotal;

    try {
      const resVariant = await f(`${TN_API}/products/${p.productId}/variants/${p.variantId}`, {
        method: 'PUT',
        headers: TN_HEADERS,
        body: JSON.stringify({
          price: precioTachado.toString(),
          compare_at_price: precioTachado.toString(),
          promotional_price: precioLista.toString(),
          stock: stock,
        }),
      });

      if (resVariant.ok) {
        actualizados++;
        if (actualizados % 50 === 0) process.stdout.write(`   ${actualizados} actualizados...\r`);
      } else {
        const err = await resVariant.json();
        console.error(`\n❌ Error en SKU ${p.sku}:`, JSON.stringify(err));
        errores++;
      }
    } catch (err) {
      console.error(`\n❌ Error en SKU ${p.sku}:`, err.message);
      errores++;
    }

    // Pausa para no superar rate limit de Tiendanube (40 req/min)
    await sleep(1500);
  }

  console.log(`\n✅ Sincronización completada:`);
  console.log(`   Actualizados: ${actualizados}`);
  console.log(`   Sin match en sheet: ${sinMatch}`);
  console.log(`   Errores: ${errores}`);
}

main().catch(console.error);
