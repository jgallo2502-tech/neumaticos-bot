const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

function extraerMedida(desc) {
  const m = desc.match(/(\d{2,3}[\/X]\d{1,2}\.?\d*\s*R\s*\d{2}C?)/i);
  return m ? m[1].toString().trim().replace(/\s+R/i, 'R').toUpperCase() : '';
}

function extraerModelo(desc) {
  const tokens = desc.toUpperCase().split(/[\s\-\/]+/);
  return tokens.filter(t => /^[A-Z][A-Z0-9']{1,}$/.test(t) && !/^(YOKOHAMA|MICHELIN|NEXEN|HANKOOK|LINGLONG|BFGOODRICH|GITI|GTRADIAL|TL|XL|LT|ZR|SUV|AWD|DOT)$/.test(t));
}

function jaccardModelo(desc1, desc2) {
  const m1 = extraerModelo(desc1), m2 = extraerModelo(desc2);
  if (m1.length === 0 || m2.length === 0) return 0;
  const set1 = new Set(m1), set2 = new Set(m2);
  const interseccion = [...set1].filter(t => set2.has(t));
  const union = new Set([...set1, ...set2]);
  return interseccion.length / union.size;
}

// 1. Lista de precios de referencia (Michelin/BFGoodrich)
const wbP = XLSX.readFile('C:/Users/juani/Desktop/PC Anterior Backup/Google Drive/Documents/Listas de Precio/202606/Lista de Referencia Auto y Camioneta - 15 Junio 2026 (1).xlsx');
const sheetsConfig = {
  'Turismo y Camioneta Michelin': { marca: 'MICHELIN',   dim: 4, modelo: 5, refIVA: 10, obs: 11 },
  'Camioneta BFG':                { marca: 'BFGOODRICH', dim: 4, modelo: 5, refIVA: 10, obs: 11 },
  'Michelin R14':                 { marca: 'MICHELIN',   dim: 4, modelo: 6, refIVA: 11, obs: 12 },
  'BFGoodrich Auto':              { marca: 'BFGOODRICH', dim: 4, modelo: 6, refIVA: 11, obs: 12 },
  'Invierno Michelin':            { marca: 'MICHELIN',   dim: 4, modelo: 5, refIVA: 10, obs: 11 },
};
const listaPrecios = [];
for (const [sheetName, cfg] of Object.entries(sheetsConfig)) {
  if (!wbP.SheetNames.includes(sheetName)) continue;
  const rows = XLSX.utils.sheet_to_json(wbP.Sheets[sheetName], { header: 1 }).slice(4);
  for (const row of rows) {
    const dim = (row[cfg.dim] || '').toString();
    const medida = extraerMedida(dim);
    if (!medida) continue;
    const refIVA = parseFloat(row[cfg.refIVA]);
    if (!refIVA) continue;
    const precio = Math.round(refIVA / 0.8);
    const modeloDesc = `${dim} ${(row[cfg.modelo] || '').toString()}`.trim();
    const codProveedor = (row[3] || '').toString().trim();
    const obs = (row[cfg.obs] || '').toString().toUpperCase();
    listaPrecios.push({ marca: cfg.marca, medida, modeloDesc, precio, codProveedor, promoInvierno: obs.includes('PROMO INVIERNO'), usado: false });
  }
}
console.log(`Lista de referencia: ${listaPrecios.length} modelos Michelin/BFGoodrich`);

// 2. Inventario actual
let txt = fs.readFileSync('C:/Users/juani/Downloads/INV 160626.xls', 'utf8');
txt = txt.replace('<xml version>', '<?xml version="1.0"?>');
const tmpFile = path.join(require('os').tmpdir(), 'INV_fixed.xls');
fs.writeFileSync(tmpFile, txt, 'utf8');
const wbI = XLSX.readFile(tmpFile);
const dataI = XLSX.utils.sheet_to_json(wbI.Sheets[wbI.SheetNames[0]], { header: 1 }).slice(1);

const productos = new Map(); // codArt -> { desc, marca, medida, precioUnit, filas: [rowIndexEnDataI] }
dataI.forEach((row, idx) => {
  const codArt = (row[2] || '').toString().trim();
  const desc = (row[36] || '').toString().replace(/^N\.\s*/i, '').trim();
  if (!codArt || !desc) return;
  const descUp = desc.toUpperCase();
  let marca = '';
  if (descUp.includes('MICHELIN')) marca = 'MICHELIN';
  else if (descUp.includes('BFGOODRICH')) marca = 'BFGOODRICH';
  if (!marca) return;
  if (!productos.has(codArt)) {
    productos.set(codArt, { codArt, desc, marca, medida: extraerMedida(desc), precioUnit: parseFloat(row[12]) || 0, filas: [] });
  }
  productos.get(codArt).filas.push(idx);
});
console.log(`Inventario: ${productos.size} artículos Michelin/BFGoodrich únicos (codArt)`);

// 3. Matchear y comparar precios — SKU primero, descripción como fallback
function matchearPrecio(p) {
  // 1. Match exacto por SKU (CodAlternativo del inventario = codProveedor de la lista)
  const porSku = listaPrecios.find(e => e.codProveedor && e.codProveedor === p.codAlt);
  if (porSku) { porSku.usado = true; return porSku; }
  // 2. Fallback: Jaccard por descripción dentro de misma marca+medida
  const candidatos = listaPrecios.filter(e => e.marca === p.marca && e.medida === p.medida);
  let mejor = null, mejorScore = 0;
  for (const c of candidatos) {
    const score = jaccardModelo(c.modeloDesc, p.desc);
    if (score > mejorScore) { mejorScore = score; mejor = c; }
  }
  if (mejor && mejorScore >= 0.3) { mejor.usado = true; return mejor; }
  return null;
}

const cambios = [];
for (const p of productos.values()) {
  const mejor = matchearPrecio(p);
  if (mejor) {
    if (Math.abs(mejor.precio - p.precioUnit) > 1) {
      cambios.push({
        CodArt: p.codArt, Descripción: p.desc, Medida: p.medida,
        'Precio actual': p.precioUnit, 'Precio correcto': mejor.precio,
        Diferencia: mejor.precio - p.precioUnit,
        'Match': listaPrecios.find(e => e.codProveedor === p.codAlt) ? 'SKU' : 'descripción',
        'Promo Invierno': mejor.promoInvierno ? 'SI' : '',
      });
    }
  }
}

// 4. Modelos de la lista que no están en el inventario (nuevos)
const nuevos = listaPrecios.filter(e => !e.usado).map(e => ({
  'Código proveedor': e.codProveedor, Marca: e.marca, Medida: e.medida,
  Modelo: e.modeloDesc, 'Precio lista': e.precio, 'Promo Invierno': e.promoInvierno ? 'SI' : '',
}));

console.log(`Artículos a corregir precio: ${cambios.length}`);
console.log(`Modelos nuevos (no están en inventario): ${nuevos.length}`);

// 5. Reporte de cambios + nuevos
const wbOut = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbOut, XLSX.utils.json_to_sheet(cambios), 'A Corregir');
XLSX.utils.book_append_sheet(wbOut, XLSX.utils.json_to_sheet(nuevos), 'Nuevos en lista');
const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const archivoReporte = path.join('C:/Users/juani/Desktop', `cambios-precios-michelin-bfg-${fecha}.xlsx`);
XLSX.writeFile(wbOut, archivoReporte);
console.log('Reporte generado:', archivoReporte);

// 6. Inventario actualizado: corregir Precio y PrecioUnitario de filas Michelin/BFGoodrich
const header = XLSX.utils.sheet_to_json(wbI.Sheets[wbI.SheetNames[0]], { header: 1 })[0];
const dataOut = dataI.map(r => r.slice());
for (const p of productos.values()) {
  const mejor = matchearPrecio(p);
  if (!mejor) continue;
  for (const idx of p.filas) {
    const row = dataOut[idx];
    const cantidad = parseInt(row[6]) || 0;
    row[12] = mejor.precio;
    row[11] = mejor.precio * cantidad;
  }
}
const wsOut = XLSX.utils.aoa_to_sheet([header, ...dataOut]);
const wbInvOut = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbInvOut, wsOut, 'Sheet1');
const archivoInv = path.join('C:/Users/juani/Desktop', `INV 160626 actualizado.xlsx`);
XLSX.writeFile(wbInvOut, archivoInv);
console.log('Inventario actualizado generado:', archivoInv);
