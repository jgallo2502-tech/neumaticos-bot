const { google } = require('googleapis');
const path = require('path');

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await drive.files.list({
    q: "'1anE-HOp-5V7oqql5raZp101dZw9xIAxD' in parents and trashed=false",
    fields: 'files(id, name)',
  });

  console.log('Archivos en carpeta:');
  for (const f of res.data.files) {
    console.log(' -', f.name, '|', f.id);
  }

  // Leer el primero que no sea inv ni Stock_Disponible
  const nuevo = res.data.files.find(f => !f.name.includes('inv0') && !f.name.includes('Stock_Disp'));
  if (nuevo) {
    console.log('\nLeyendo:', nuevo.name);
    const data = await sheets.spreadsheets.values.get({ spreadsheetId: nuevo.id, range: 'A:Z' });
    const rows = data.data.values || [];
    console.log('Encabezados:', rows[0]?.join(' | '));
    console.log('Fila 2:', rows[1]?.join(' | '));
    console.log('Fila 3:', rows[2]?.join(' | '));
  }
}
main().catch(console.error);
