/**
 * Inspecciona el archivo SJYS precios en Drive:
 * muestra nombres de hojas, headers de cada hoja, y ejemplos de filas.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const XLSX = require('xlsx');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '11Ham__W-bVOJtaMsZQHRap-orDV6cpek';

function getAuth() {
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  }
  return new google.auth.GoogleAuth({
    keyFile: require('path').join(__dirname, '../credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

async function descargarXlsx(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return XLSX.read(Buffer.from(res.data), { type: 'buffer' });
}

async function main() {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const { data } = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 50,
  });

  const archivos = data.files || [];
  console.log('Archivos en Drive:');
  archivos.forEach(f => console.log(`  ${f.name}`));

  // Buscar archivo SJYS precios
  const n = name => name.toLowerCase();
  const sjysFile = archivos.find(f =>
    (n(f.name).includes('giti') || n(f.name).includes('gtradial') || n(f.name).includes('sjys'))
    && (n(f.name).includes('pmg') || n(f.name).includes('precio') || n(f.name).includes('lista'))
  );

  if (!sjysFile) { console.error('❌ No se encontró el archivo SJYS precios'); return; }
  console.log(`\n📄 Archivo SJYS precios: "${sjysFile.name}"`);

  const wb = await descargarXlsx(drive, sjysFile.id);
  console.log(`\nHojas: ${wb.SheetNames.join(', ')}`);

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    const nonEmpty = rows.filter(r => r.some(c => c));
    console.log(`\n--- Hoja: "${sheetName}" (${nonEmpty.length} filas no vacías) ---`);

    // Mostrar primeras 5 filas no vacías
    nonEmpty.slice(0, 5).forEach((r, i) => {
      console.log(`  Fila ${i}: ${JSON.stringify(r).substring(0, 150)}`);
    });

    // Buscar header PMG
    const pmgRowIdx = nonEmpty.findIndex(r =>
      r.some(c => /^pmg$/i.test((c || '').toString()))
    );
    if (pmgRowIdx !== -1) {
      console.log(`  ✅ Header PMG encontrado en fila ${pmgRowIdx}: ${JSON.stringify(nonEmpty[pmgRowIdx]).substring(0, 200)}`);
      // Mostrar 3 filas de datos
      nonEmpty.slice(pmgRowIdx + 1, pmgRowIdx + 4).forEach((r, i) => {
        console.log(`  Dato ${i + 1}: ${JSON.stringify(r).substring(0, 200)}`);
      });

      // Buscar filas con "adventuro" o "gtradial"
      const adventuro = nonEmpty.filter(r =>
        r.some(c => /adventuro|gtradial/i.test((c || '').toString()))
      );
      if (adventuro.length) {
        console.log(`  🔍 Filas con "adventuro" o "gtradial" (primeras 3):`);
        adventuro.slice(0, 3).forEach(r => console.log(`    ${JSON.stringify(r).substring(0, 200)}`));
      } else {
        console.log('  ⚠️  No se encontraron filas con "adventuro" o "gtradial"');
      }
    } else {
      console.log('  ⚠️  No se encontró header PMG en esta hoja');
    }
  }
}

main().catch(console.error);
