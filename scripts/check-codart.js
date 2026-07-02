require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: path.join(__dirname, '../credentials.json'), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const list = await drive.files.list({ q: `'11Ham__W-bVOJtaMsZQHRap-orDV6cpek' in parents`, fields: 'files(id,name)' });
  const inv = list.data.files.find(f => f.name.toLowerCase().includes('gallo'));
  const res = await drive.files.get({ fileId: inv.id, alt: 'media' }, { responseType: 'arraybuffer' });
  const wb = XLSX.read(Buffer.from(res.data));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], { header: 1 });
  rows.forEach(r => {
    if ((r[2]||'').toString().trim() === '10110405') {
      console.log('Col 1 (desc corta):', r[1]);
      console.log('Col 36 (desc larga):', r[36]);
      console.log('Col 24 (codAlt):', r[24]);
    }
  });
}
main().catch(console.error);
