require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const EMAIL_TO    = process.env.REPORTE_EMAIL   || 'j.gallo2502@gmail.com';
const EMAIL_FROM  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASS;
const BOT_NUMBER  = (process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE || '').replace('whatsapp:', '').replace('+', '');
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOK  = process.env.TWILIO_AUTH_TOKEN;

// ── Helpers ───────────────────────────────────────────────────────────────────

function limpiarNumero(n) {
  return (n || '').replace(/^whatsapp:\+?/i, '').replace(/^\+/, '');
}

function formatFecha(d) {
  return d.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
}

function colorRol(rol) { return rol === 'bot' ? '#34a853' : '#1a73e8'; }
function labelRol(rol) { return rol === 'bot' ? '🤖 Bot' : '👤 Cliente'; }

// ── Parsear CSV de Twilio ─────────────────────────────────────────────────────
function parsearCSV(contenido) {
  const lineas = contenido.split('\n');
  const headers = lineas[0].split(',');
  const idx = h => headers.indexOf(h);

  const iFrom   = idx('From');
  const iTo     = idx('To');
  const iBody   = idx('Body');
  const iDate   = idx('SentDate');
  const iDir    = idx('Direction');

  const botNum = limpiarNumero(BOT_NUMBER);
  const mensajes = [];

  let i = 1;
  while (i < lineas.length) {
    if (!lineas[i].trim()) { i++; continue; }

    // Detectar inicio de campo con comillas (body multilínea)
    let linea = lineas[i];
    // Contar comillas para detectar si el campo body abre comilla sin cerrar
    while (i < lineas.length - 1) {
      const comillas = (linea.match(/"/g) || []).length;
      if (comillas % 2 === 0) break;
      i++;
      linea += '\n' + lineas[i];
    }
    i++;

    // Parsear campos respetando comillas
    const campos = [];
    let j = 0, dentro = false, campo = '';
    while (j < linea.length) {
      const c = linea[j];
      if (c === '"') {
        if (dentro && linea[j+1] === '"') { campo += '"'; j += 2; continue; }
        dentro = !dentro;
      } else if (c === ',' && !dentro) {
        campos.push(campo); campo = ''; j++; continue;
      } else {
        campo += c;
      }
      j++;
    }
    campos.push(campo);

    const from    = limpiarNumero(campos[iFrom] || '');
    const to      = limpiarNumero(campos[iTo]   || '');
    const body    = (campos[iBody] || '').trim();
    const dateRaw = campos[iDate] || '';
    const dir     = (campos[iDir] || '').trim();

    if (!body || !dateRaw) continue;

    // SentDate ya viene con offset Argentina: "2026-08-19T14:23:02-03:00"
    // Parsear directo del string para evitar diferencias de locale en Windows
    const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) continue;
    const fecha = `${m[3]}/${m[2]}/${m[1]}`;
    const hora  = `${m[4]}:${m[5]}`;

    const esBot    = dir.startsWith('outbound');
    const cliente  = esBot ? to : from;

    if (!cliente || cliente === botNum) continue;

    mensajes.push({ fecha, hora, numero: cliente, rol: esBot ? 'bot' : 'cliente', texto: body, ts: new Date(dateRaw).getTime() });
  }

  // Ordenar por timestamp
  mensajes.sort((a, b) => a.ts - b.ts);
  return mensajes;
}

// ── Leer desde Google Sheets ──────────────────────────────────────────────────
function getSheetsClient() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return google.sheets({ version: 'v4', auth });
}

async function leerDesdeSheets() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Mensajes!A:E' });
  return (res.data.values || []).slice(1).map(r => ({
    fecha: r[0] || '', hora: r[1] || '', numero: r[2] || '', rol: r[3] === 'bot' ? 'bot' : 'cliente', texto: r[4] || '', ts: 0,
  }));
}

// ── Leer desde API de Twilio ──────────────────────────────────────────────────
async function leerDesdeTwilio(fechaDD_MM_YYYY) {
  if (!TWILIO_SID || !TWILIO_TOK) throw new Error('Faltan TWILIO_ACCOUNT_SID o TWILIO_AUTH_TOKEN en .env');

  // Convertir DD/MM/YYYY → YYYY-MM-DD para la API
  const [d, mo, a] = fechaDD_MM_YYYY.split('/');
  const fechaISO = `${a}-${mo}-${d}`;

  // Twilio filtra por DateSent >= fecha y < fecha+1
  const fechaSig = new Date(Number(a), Number(mo)-1, Number(d)+1);
  const fechaSigISO = `${fechaSig.getFullYear()}-${String(fechaSig.getMonth()+1).padStart(2,'0')}-${String(fechaSig.getDate()).padStart(2,'0')}`;

  const base = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOK}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  const mensajes = [];
  let nextUrl = `${base}?DateSent>=${fechaISO}&DateSent<${fechaSigISO}&PageSize=1000`;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers });
    if (!res.ok) throw new Error(`Twilio API error: ${res.status} ${await res.text()}`);
    const data = await res.json();

    for (const msg of (data.messages || [])) {
      const from = limpiarNumero(msg.from || '');
      const to   = limpiarNumero(msg.to   || '');
      const esBot = msg.direction === 'outbound-api' || msg.direction === 'outbound-reply';
      const cliente = esBot ? to : from;
      if (!cliente || cliente === BOT_NUMBER) continue;

      // Fecha/hora en Argentina desde msg.date_sent (viene en UTC)
      const dt = new Date(msg.date_sent);
      const iso = new Date(dt.getTime() - 3*60*60*1000).toISOString();
      const fecha = `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`;
      const hora  = iso.slice(11,16);

      mensajes.push({ fecha, hora, numero: cliente, rol: esBot ? 'bot' : 'cliente', texto: msg.body || '', ts: dt.getTime() });
    }

    // Paginación
    nextUrl = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
  }

  mensajes.sort((a, b) => a.ts - b.ts);
  return mensajes;
}

async function leerRevendedores() {
  try {
    const sheets = getSheetsClient();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Revendedores!A:A' });
    const rows = res.data.values || [];
    return new Set(rows.slice(1).flat().map(n => n.toString().replace(/\D/g, '')).filter(n => n.length > 5));
  } catch (e) {
    console.warn('⚠️  No se pudo leer hoja Revendedores:', e.message);
    return new Set();
  }
}

// ── Generar HTML del reporte ──────────────────────────────────────────────────
function generarHTML(mensajes, targetFecha, revendedores) {
  const rev = revendedores || new Set();
  const del_dia = targetFecha ? mensajes.filter(m => m.fecha === targetFecha) : mensajes;

  const grupos = {};
  for (const m of del_dia) {
    if (!m.numero) continue;
    if (!grupos[m.numero]) grupos[m.numero] = [];
    grupos[m.numero].push(m);
  }

  const numeros = Object.keys(grupos).sort();
  const totalMensajes  = del_dia.length;
  const totalMsgCliente = del_dia.filter(m => m.rol !== 'bot').length;

  const numerosRev  = numeros.filter(n => rev.has(n));
  const numerosParticular = numeros.filter(n => !rev.has(n));

  function bloqueConversacion(num) {
    const msgs = grupos[num];
    const esRev = rev.has(num);
    const headerColor = esRev ? '#e37400' : '#1a73e8';
    const tag = esRev ? ' 🏪 Revendedor' : '';
    const filas = msgs.map(({ hora, rol, texto }) => `
      <tr>
        <td style="width:55px;color:#888;font-size:11px;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${hora}</td>
        <td style="width:85px;color:${colorRol(rol)};font-size:11px;font-weight:700;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${labelRol(rol)}</td>
        <td style="font-size:13px;padding:4px 0;color:#202124;white-space:pre-wrap;word-break:break-word">${(texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
      </tr>`).join('');
    return `
    <div style="margin-bottom:20px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:hidden">
      <div style="background:${headerColor};color:#fff;padding:9px 16px;font-size:13px;font-weight:600">
        📱 +${num}${tag} &nbsp;·&nbsp; ${msgs.length} mensajes
      </div>
      <div style="padding:10px 16px">
        <table style="border-collapse:collapse;width:100%">${filas}</table>
      </div>
    </div>`;
  }

  function seccion(titulo, color, lista) {
    if (lista.length === 0) return '';
    return `
    <div style="margin:24px 0 12px;font-size:15px;font-weight:700;color:${color};border-left:4px solid ${color};padding-left:10px">${titulo}</div>
    ${lista.map(bloqueConversacion).join('')}`;
  }

  let fechaLabel = targetFecha || 'Todos los mensajes';
  let fechaDisplay = fechaLabel;
  if (targetFecha) {
    const [d, mo, a] = targetFecha.split('/');
    try { fechaDisplay = formatFecha(new Date(Number(a), Number(mo)-1, Number(d))); } catch(e) {}
  }

  return {
    html: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f3f4;font-family:Arial,sans-serif">
<div style="max-width:720px;margin:24px auto;padding:0 16px">
  <div style="background:#1a73e8;color:#fff;border-radius:8px 8px 0 0;padding:20px 24px">
    <div style="font-size:20px;font-weight:700">💬 Reporte de Chats — Neumáticos Gallo</div>
    <div style="font-size:14px;opacity:.85;margin-top:4px">${fechaDisplay}</div>
  </div>
  <div style="background:#fff;padding:16px 24px;margin-bottom:8px;display:flex;gap:24px;flex-wrap:wrap">
    <div><div style="font-size:26px;font-weight:700;color:#1a73e8">${numeros.length}</div><div style="font-size:12px;color:#666">Conversaciones totales</div></div>
    <div><div style="font-size:26px;font-weight:700;color:#e37400">${numerosRev.length}</div><div style="font-size:12px;color:#666">🏪 Revendedores</div></div>
    <div><div style="font-size:26px;font-weight:700;color:#34a853">${numerosParticular.length}</div><div style="font-size:12px;color:#666">👤 Particulares</div></div>
    <div><div style="font-size:26px;font-weight:700;color:#888">${totalMsgCliente}</div><div style="font-size:12px;color:#666">Mensajes de clientes</div></div>
  </div>
  ${numeros.length === 0
    ? '<div style="text-align:center;padding:40px;color:#666;background:#fff;border-radius:8px">Sin conversaciones</div>'
    : seccion('🏪 Revendedores', '#e37400', numerosRev) + seccion('👤 Particulares', '#1a73e8', numerosParticular)}
  <div style="text-align:center;padding:16px;font-size:11px;color:#999">Generado automáticamente por el bot de Neumáticos Gallo</div>
</div></body></html>`,
    numeros: numeros.length, numerosRev: numerosRev.length, numerosParticular: numerosParticular.length, totalMensajes, fechaLabel,
  };
}

// ── Enviar email ──────────────────────────────────────────────────────────────
async function enviarEmail(html, { numeros, numerosRev, numerosParticular, totalMensajes, fechaLabel }) {
  if (!EMAIL_FROM || !GMAIL_PASS) { console.error('❌ Faltan GMAIL_USER o GMAIL_APP_PASS en .env'); process.exit(1); }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_FROM, pass: GMAIL_PASS } });
  await transporter.sendMail({
    from: `"Bot Neumáticos Gallo" <${EMAIL_FROM}>`,
    to: EMAIL_TO,
    subject: `📊 Chats ${fechaLabel} — ${numeros} convs (🏪${numerosRev} rev · 👤${numerosParticular} part)`,
    html,
  });
  console.log(`✅ Reporte enviado a ${EMAIL_TO} (${numeros} conversaciones: ${numerosRev} revendedores, ${numerosParticular} particulares)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Uso:
  //   node reporte-chats.js                          ← ayer, desde Twilio API (automático)
  //   node reporte-chats.js 19/08/2026               ← fecha específica, desde Twilio API
  //   node reporte-chats.js archivo.csv              ← todos los días del CSV
  //   node reporte-chats.js 19/08/2026 archivo.csv   ← fecha específica del CSV
  const args = process.argv.slice(2);
  let csvPath = null, targetFecha = null;

  for (const arg of args) {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(arg)) targetFecha = arg;
    else if (arg.endsWith('.csv')) csvPath = arg;
  }

  // Si no hay fecha, usar ayer
  if (!targetFecha) {
    const ayer = new Date(Date.now() - 3*60*60*1000 - 24*60*60*1000); // ayer en ART
    targetFecha = `${String(ayer.getUTCDate()).padStart(2,'0')}/${String(ayer.getUTCMonth()+1).padStart(2,'0')}/${ayer.getUTCFullYear()}`;
  }

  console.log(`📊 Generando reporte de chats para ${targetFecha}...`);

  let mensajes;
  if (csvPath) {
    const csvAbs = path.resolve(csvPath);
    if (!fs.existsSync(csvAbs)) { console.error('❌ No se encontró el archivo:', csvAbs); process.exit(1); }
    const contenido = fs.readFileSync(csvAbs, 'utf8');
    mensajes = parsearCSV(contenido);
    console.log(`📄 CSV: ${mensajes.length} mensajes cargados`);
  } else {
    console.log('📡 Consultando API de Twilio...');
    mensajes = await leerDesdeTwilio(targetFecha);
    console.log(`📄 Twilio: ${mensajes.length} mensajes cargados`);
  }

  console.log('👥 Cargando lista de revendedores...');
  const revendedores = await leerRevendedores();
  console.log(`   ${revendedores.size} revendedores en la lista`);

  const { html, ...stats } = generarHTML(mensajes, targetFecha, revendedores);
  await enviarEmail(html, stats);
}

main().catch(e => { console.error(e); process.exit(1); });
