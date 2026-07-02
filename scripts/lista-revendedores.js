require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

const DESCUENTOS = { giti: 0.33, gtradial: 0.33, yokohama: 0.32, michelin: 0.35, bfgoodrich: 0.35, nexen: 0.32, hankook: 0.28, linglong: 0.28 };
const MARCAS = ['giti', 'gtradial', 'yokohama', 'michelin', 'bfgoodrich', 'nexen', 'hankook', 'linglong'];

let promoInvierno = [];
try {
  promoInvierno = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'promo-invierno.json'), 'utf8'));
} catch (e) { /* sin promo invierno cargada */ }

function extraerModelo(desc) {
  const tokens = desc.toUpperCase().split(/[\s\-\/]+/);
  return tokens.filter(t => /^[A-Z][A-Z0-9']{1,}$/.test(t) && !/^(YOKOHAMA|MICHELIN|NEXEN|HANKOOK|LINGLONG|BFGOODRICH|GITI|GTRADIAL|TL|XL|LT|ZR|SUV|AWD|DOT)$/.test(t));
}

function descMatch(desc1, desc2) {
  const m1 = extraerModelo(desc1), m2 = extraerModelo(desc2);
  if (m1.length === 0 || m2.length === 0) return false;
  const set1 = new Set(m1), set2 = new Set(m2);
  const interseccion = [...set1].filter(t => set2.has(t));
  const union = new Set([...set1, ...set2]);
  return (interseccion.length / union.size) >= 0.5;
}

function esPromoInvierno(medida, marca, desc) {
  return promoInvierno.some(p => p.medida === medida && p.marca === marca.toUpperCase() && descMatch(p.desc, desc));
}

function formatStock(total) {
  if (total === 0) return 0;
  if (total <= 7) return total;
  return 'OK';
}

function fmt(n) {
  return Math.round(n);
}

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

  // Agrupar por marca
  const porMarca = { giti: [], gtradial: [], yokohama: [], michelin: [], bfgoodrich: [], nexen: [], hankook: [], linglong: [] };

  for (const row of rows) {
    const marca = (row[3] || '').toLowerCase().trim();
    if (!MARCAS.includes(marca)) continue;

    const sku      = row[1] || '';
    const desc     = row[2] || '';
    const medida   = row[5] || '';
    const sVic     = parseInt((row[6] || '0').toString().replace(/\D/g, '')) || 0;
    const sNor     = parseInt((row[7] || '0').toString().replace(/\D/g, '')) || 0;
    const sExpr    = parseInt((row[8] || '0').toString().replace(/\D/g, '')) || 0;
    const precio   = parseInt((row[9] || '0').toString().replace(/\D/g, '')) || 0;

    if (!precio) continue;

    const desc_pct = DESCUENTOS[marca];
    const baseReventa = esPromoInvierno(medida, marca, desc) ? precio / 0.9 : precio;
    const precioRev = fmt(baseReventa * (1 - desc_pct));
    const stockTotal = sVic + sNor + sExpr;

    porMarca[marca].push({
      SKU: sku,
      Descripción: desc,
      Medida: medida,
      'Precio lista (12p)': precio,
      [`Precio reventa (-${Math.round(desc_pct * 100)}%)`]: precioRev,
      'Stock Victoria': formatStock(sVic),
      'Stock Nordelta': formatStock(sNor),
      'Stock Express': formatStock(sExpr),
      'Stock Total': formatStock(stockTotal),
    });
  }

  const wb = XLSX.utils.book_new();

  const NOMBRES = { giti: 'Giti', gtradial: 'GTRadial', yokohama: 'Yokohama', michelin: 'Michelin', bfgoodrich: 'BFGoodrich', nexen: 'Nexen', hankook: 'Hankook', linglong: 'Linglong' };

  for (const marca of MARCAS) {
    const datos = porMarca[marca];
    if (datos.length === 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Sin datos']]), NOMBRES[marca]);
      continue;
    }

    const ws = XLSX.utils.json_to_sheet(datos);

    // Ancho de columnas
    ws['!cols'] = [
      { wch: 16 }, // SKU
      { wch: 45 }, // Descripción
      { wch: 14 }, // Medida
      { wch: 18 }, // Precio lista
      { wch: 20 }, // Precio reventa
      { wch: 14 }, // Stock Victoria
      { wch: 14 }, // Stock Nordelta
      { wch: 14 }, // Stock Express
      { wch: 12 }, // Stock Total
    ];

    XLSX.utils.book_append_sheet(wb, ws, NOMBRES[marca]);
  }

  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const archivo = path.join('C:/Users/juani/Desktop', `lista-revendedores-${fecha}.xlsx`);
  XLSX.writeFile(wb, archivo);
  console.log('Archivo generado:', archivo);
}

main().catch(console.error);
