require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const EMAIL_TO    = process.env.REPORTE_EMAIL    || 'j.gallo2502@gmail.com';
const EMAIL_FROM  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASS;

function getAuth() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
}

function formatFecha(d) {
  return d.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
}

function formatHora(h) {
  return h || '';
}

function colorRol(rol) {
  return rol === 'usuario' ? '#1a73e8' : '#34a853';
}

function labelRol(rol) {
  return rol === 'usuario' ? '👤 Cliente' : '🤖 Bot';
}

async function generarReporte(fechaStr) {
  // fechaStr = "DD/MM/YYYY" o undefined (ayer)
  let targetFecha;
  if (fechaStr) {
    targetFecha = fechaStr;
  } else {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const d = ayer.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' });
    targetFecha = d; // "DD/MM/YYYY"
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Mensajes!A:E',
  });

  const rows = (res.data.values || []).slice(1); // skip header
  const del_dia = rows.filter(r => (r[0] || '') === targetFecha);

  // Agrupar por número
  const grupos = {};
  for (const [fecha, hora, numero, rol, texto] of del_dia) {
    if (!numero) continue;
    if (!grupos[numero]) grupos[numero] = [];
    grupos[numero].push({ hora, rol, texto });
  }

  const numeros = Object.keys(grupos);
  const totalMensajes = del_dia.length;
  const totalUsuario  = del_dia.filter(r => r[3] === 'usuario').length;

  // ── Armar HTML ────────────────────────────────────────────────────────────────
  const bloques = numeros.map(num => {
    const msgs = grupos[num];
    const filas = msgs.map(({ hora, rol, texto }) => `
      <tr>
        <td style="width:70px;color:#666;font-size:12px;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${formatHora(hora)}</td>
        <td style="width:90px;color:${colorRol(rol)};font-size:12px;font-weight:600;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${labelRol(rol)}</td>
        <td style="font-size:13px;padding:4px 0;color:#202124;white-space:pre-wrap">${(texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
      </tr>`).join('');
    return `
    <div style="margin-bottom:24px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:hidden">
      <div style="background:#1a73e8;color:#fff;padding:10px 16px;font-size:13px;font-weight:600">
        📱 ${num} &nbsp;·&nbsp; ${msgs.length} mensajes
      </div>
      <div style="padding:12px 16px">
        <table style="border-collapse:collapse;width:100%">${filas}</table>
      </div>
    </div>`;
  }).join('');

  const [dia, mes, anio] = targetFecha.split('/');
  const fechaObj = new Date(Number(anio), Number(mes) - 1, Number(dia));

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f3f4;font-family:Arial,sans-serif">
<div style="max-width:700px;margin:24px auto;padding:0 16px">

  <div style="background:#1a73e8;color:#fff;border-radius:8px 8px 0 0;padding:20px 24px">
    <div style="font-size:20px;font-weight:700">💬 Reporte de Chats — Neumáticos Gallo</div>
    <div style="font-size:14px;opacity:.85;margin-top:4px">${formatFecha(fechaObj)}</div>
  </div>

  <div style="background:#fff;padding:16px 24px;border-left:4px solid #1a73e8;margin-bottom:24px;display:flex;gap:32px">
    <div><div style="font-size:28px;font-weight:700;color:#1a73e8">${numeros.length}</div><div style="font-size:12px;color:#666">Conversaciones</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#34a853">${totalUsuario}</div><div style="font-size:12px;color:#666">Mensajes de clientes</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#fbbc04">${totalMensajes}</div><div style="font-size:12px;color:#666">Mensajes totales</div></div>
  </div>

  ${numeros.length === 0
    ? '<div style="text-align:center;padding:40px;color:#666;background:#fff;border-radius:8px">Sin conversaciones este día</div>'
    : bloques}

  <div style="text-align:center;padding:16px;font-size:11px;color:#999">Generado automáticamente por el bot de Neumáticos Gallo</div>
</div>
</body></html>`;

  return { html, numeros: numeros.length, totalMensajes, targetFecha };
}

async function enviarEmail(html, { numeros, totalMensajes, targetFecha }) {
  if (!EMAIL_FROM || !GMAIL_PASS) {
    console.error('❌ Faltan GMAIL_USER o GMAIL_APP_PASS en .env');
    process.exit(1);
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_FROM, pass: GMAIL_PASS },
  });

  const [dia, mes, anio] = targetFecha.split('/');
  await transporter.sendMail({
    from: `"Bot Neumáticos Gallo" <${EMAIL_FROM}>`,
    to: EMAIL_TO,
    subject: `📊 Chats del ${dia}/${mes}/${anio} — ${numeros} conversaciones, ${totalMensajes} mensajes`,
    html,
  });
  console.log(`✅ Reporte enviado a ${EMAIL_TO} (${numeros} conversaciones, ${totalMensajes} mensajes)`);
}

async function main() {
  const fechaArg = process.argv[2]; // opcional: "DD/MM/YYYY"
  console.log('📊 Generando reporte de chats...');
  const { html, ...stats } = await generarReporte(fechaArg);
  await enviarEmail(html, stats);
}

main().catch(e => { console.error(e); process.exit(1); });
