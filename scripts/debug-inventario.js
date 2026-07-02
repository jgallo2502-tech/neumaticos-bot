require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const FOLDER_ID = '11Ham__W-bVOJtaMsZQHRap-orDV6cpek';

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: path.join(__dirname, '../credentials.json'), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const list = await drive.files.list({ q: `'${FOLDER_ID}' in parents`, fields: 'files(id,name)' });
  const archivos = list.data.files;
  const inv = archivos.filter(f => f.name.toLowerCase().includes('inv') && f.name.toLowerCase().includes('gallo'))[0];
  console.log('Archivo inventario:', inv.name, '| id:', inv.id);
  // Ver mimeType
  const meta = await drive.files.get({ fileId: inv.id, fields: 'mimeType,size' });
  console.log('mimeType:', meta.data.mimeType, '| size:', meta.data.size);

  const res = await drive.files.get({ fileId: inv.id, alt: 'media' }, { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data);
  console.log('Tamaño buffer:', buf.length, 'bytes');
  console.log('Primeros bytes (hex):', buf.slice(0,8).toString('hex'));
  const wb = XLSX.read(buf, { type: 'buffer' });
  console.log('Hojas:', wb.SheetNames);

  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  console.log('Sheet ref:', ws['!ref']);
  console.log('Sheet keys (primeras 10):', Object.keys(ws).slice(0, 10));
  console.log('Total filas array:', rows.length);
  if (rows.length > 0) {
    console.log('Fila 0:', JSON.stringify(rows[0]));
    console.log('Fila 1:', JSON.stringify(rows[1]));
  }
  // Intentar con raw
  const rows2 = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
  console.log('Total filas (raw:false):', rows2.length);
  if (rows2.length > 0) console.log('Fila 0 raw:false:', JSON.stringify(rows2[0]));
}
main().catch(console.error);
