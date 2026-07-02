require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const SHEET_ID = '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw';

function normalizarMedida(s) {
  return s.toString().trim().replace(/\s+R/i, 'R').toUpperCase();
}

function extraerMedida(desc) {
  const m = desc.match(/(\d{2,3}[\/X]\d{1,2}\.?\d*\s*R\s*\d{2}C?)/i);
  return m ? normalizarMedida(m[1]) : '';
}

function parseMarca(desc) {
  const conocidas = ['MICHELIN','BFGOODRICH','YOKOHAMA','GITI','GTRADIAL','NEXEN','HANKOOK',
    'LINGLONG','DUNLOP','PIRELLI','GOODYEAR','CONTINENTAL','BRIDGESTONE','FATE',
    'WESTLAKE','TRACMAX','SUNNY','CHAOYANG','TOYO','KUMHO','FALKEN','FIRESTONE',
    'COOPER','MAXXIS','NANKANG','ATLAS','TRIANGLE','UNIROYAL','SAILUN'];
  const up = desc.toUpperCase().trim();
  const primerWord = up.split(/[\s\/\d]/)[0];
  const exacta = conocidas.find(m => m === primerWord);
  if (exacta) return exacta.charAt(0) + exacta.slice(1).toLowerCase();
  const encontrada = conocidas.find(m => up.includes(m));
  if (encontrada) return encontrada.charAt(0) + encontrada.slice(1).toLowerCase();
  const primera = desc.trim().split(' ')[0];
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase();
}

async function getAuth() {
  return new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function leerBotWhatsApp() {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });
  const rows = (res.data.values || []).slice(1);
  const set = new Set();
  for (const row of rows) {
    const codArt = (row[0] || '').toString().trim();
    if (codArt) set.add(codArt);
  }
  return set;
}

function leerInventarioCompleto() {
  const wb = XLSX.readFile('C:/Users/juani/Desktop/INV 160626 actualizado.xlsx');
  const ws = wb.Sheets['Sheet1'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1);

  const productos = new Map(); // codArt -> { codArt, codAlt, desc, cantidad, precioUnit }

  for (const row of data) {
    const codArt = (row[2] || '').toString().trim();
    if (!codArt) continue;
    const cantidad = parseInt(row[6]) || 0;
    const precioUnit = parseFloat(row[12]) || 0;
    const codAlt = (row[24] || '').toString().trim();
    const desc = (row[36] || '').toString().replace(/^N\.\s*/i, '').trim();

    if (!productos.has(codArt)) {
      productos.set(codArt, {
        codArt,
        codAlt,
        desc,
        cantidad: 0,
        precioUnit: 0,
      });
    }
    const p = productos.get(codArt);
    p.cantidad += cantidad;
    if (precioUnit > p.precioUnit) p.precioUnit = precioUnit;
    if (!p.codAlt && codAlt) p.codAlt = codAlt;
    if (!p.desc && desc) p.desc = desc;
  }

  return productos;
}

async function main() {
  console.log('Leyendo Bot WhatsApp sheet...');
  const botSet = await leerBotWhatsApp();
  console.log(`Cod.Art en Bot WhatsApp: ${botSet.size}`);

  console.log('Leyendo inventario completo...');
  const productos = leerInventarioCompleto();
  console.log(`Productos en inventario (todos los depositos): ${productos.size}`);

  const faltantes = [];
  for (const p of productos.values()) {
    if (p.cantidad > 0 && !botSet.has(p.codArt)) {
      faltantes.push({
        codArt: p.codArt,
        codAlt: p.codAlt,
        desc: p.desc,
        marca: parseMarca(p.desc),
        medida: extraerMedida(p.desc),
        cantidad: p.cantidad,
        precioUnit: p.precioUnit,
      });
    }
  }

  console.log(`Faltantes con stock real: ${faltantes.length}`);

  const outPath = path.join(__dirname, 'faltantes-todos-depositos.json');
  fs.writeFileSync(outPath, JSON.stringify(faltantes, null, 2));
  console.log('Archivo generado:', outPath);

  const porMarca = {};
  for (const f of faltantes) {
    porMarca[f.marca] = (porMarca[f.marca] || 0) + 1;
  }
  console.log('Breakdown por marca:', porMarca);
}

main().catch(console.error);
