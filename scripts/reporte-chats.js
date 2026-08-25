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

// ── Registro de recuperos enviados ────────────────────────────────────────────
const RECUPERO_LOG = path.join(__dirname, '../data/recupero-enviados.json');

function leerRecuperoLog() {
  try {
    if (!fs.existsSync(RECUPERO_LOG)) return {};
    return JSON.parse(fs.readFileSync(RECUPERO_LOG, 'utf8'));
  } catch { return {}; }
}

function guardarRecuperoLog(log) {
  try {
    const dir = path.dirname(RECUPERO_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RECUPERO_LOG, JSON.stringify(log, null, 2));
  } catch(e) { console.error('Error guardando recupero log:', e.message); }
}

// Devuelve Set de números a los que ya se mandó recupero en las últimas 70hs
function numerosYaEnviados() {
  const log = leerRecuperoLog();
  const hace70h = Date.now() - 70*60*60*1000;
  const activos = new Set();
  for (const [num, entry] of Object.entries(log)) {
    if (entry.ts > hace70h) activos.add(num);
  }
  return activos;
}

// Devuelve Set de números que recibieron el primer recupero hace entre 68 y 76hs (listos para segundo)
function numerosParaSegundoRecupero() {
  const log = leerRecuperoLog();
  const ahora = Date.now();
  const listos = new Set();
  for (const [num, entry] of Object.entries(log)) {
    if (entry.tipo !== 1) continue;
    const hs = (ahora - entry.ts) / (60*60*1000);
    if (hs >= 68 && hs <= 76) listos.add(num);
  }
  return listos;
}

function registrarEnvios(numeros, tipo = 1) {
  const log = leerRecuperoLog();
  const ahora = Date.now();
  for (const num of numeros) log[num] = { ts: ahora, tipo };
  // Limpiar entradas viejas (> 96hs)
  const limite = ahora - 96*60*60*1000;
  for (const [num, entry] of Object.entries(log)) {
    if (entry.ts < limite) delete log[num];
  }
  guardarRecuperoLog(log);
}

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
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Revendedores!A:C' });
    const rows = res.data.values || [];
    const mapa = new Map();
    for (const r of rows.slice(1)) {
      const num = (r[0] || '').toString().replace(/\D/g, '');
      if (num.length > 5) mapa.set(num, (r[2] || '').trim());
    }
    return mapa;
  } catch (e) {
    console.warn('⚠️  No se pudo leer hoja Revendedores:', e.message);
    return new Map();
  }
}

// ── Generar HTML del reporte ──────────────────────────────────────────────────
function generarHTML(mensajes, targetFecha, revendedores) {
  const rev = revendedores || new Map();
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
    const nombre = esRev ? rev.get(num) : '';
    const headerColor = esRev ? '#e37400' : '#1a73e8';
    const label = esRev ? `${nombre ? nombre + ' — ' : ''}📱 +${num} 🏪 Revendedor` : `📱 +${num}`;
    const filas = msgs.map(({ hora, rol, texto }) => `
      <tr>
        <td style="width:55px;color:#888;font-size:11px;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${hora}</td>
        <td style="width:85px;color:${colorRol(rol)};font-size:11px;font-weight:700;vertical-align:top;padding:4px 8px 4px 0;white-space:nowrap">${labelRol(rol)}</td>
        <td style="font-size:13px;padding:4px 0;color:#202124;white-space:pre-wrap;word-break:break-word">${(texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
      </tr>`).join('');
    return `
    <div style="margin-bottom:20px;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);overflow:hidden">
      <div style="background:${headerColor};color:#fff;padding:9px 16px;font-size:13px;font-weight:600">
        ${label} &nbsp;·&nbsp; ${msgs.length} mensajes
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

// ── Generar HTML de recuperación de ventas (solo particulares) ───────────────
const MSG_RECUPERACION = encodeURIComponent('Hola, soy Juan de Neumáticos Gallo, vi que estuviste consultando y te atendió el bot, queria saber si tenias alguna duda, que quizas el bot no te asesoro, y de paso que te parecio la atención del bot? Muchas Graciasss');
const MSG_RECUPERACION_2 = encodeURIComponent('Hola! Soy Juan de Neumáticos Gallo 👋 Quería saber si pudiste conseguir lo que necesitabas, y cómo fue tu experiencia con nosotros. ¿Hay algo que creas que podemos mejorar? Tu opinión nos ayuda un montón. ¡Gracias!');

function generarHTMLRecuperacion(mensajes, targetFecha, revendedores, labelVentana, mensajes2) {
  const rev = revendedores || new Map();
  const del_dia = targetFecha ? mensajes.filter(m => m.fecha === targetFecha) : mensajes;

  // Grupos segundo recupero
  const grupos2 = {};
  if (mensajes2 && mensajes2.length > 0) {
    const del_dia2 = mensajes2; // ya vienen filtrados
    for (const m of del_dia2) {
      if (!m.numero || rev.has(m.numero)) continue;
      if (!grupos2[m.numero]) grupos2[m.numero] = [];
      grupos2[m.numero].push(m);
    }
  }

  const grupos = {};
  for (const m of del_dia) {
    if (!m.numero || rev.has(m.numero)) continue;
    if (!grupos[m.numero]) grupos[m.numero] = [];
    grupos[m.numero].push(m);
  }

  const numeros = Object.keys(grupos).sort();
  if (numeros.length === 0) return null;

  let fechaLabel = targetFecha || 'Todos los mensajes';
  let fechaDisplay = fechaLabel;
  if (targetFecha) {
    const [d, mo, a] = targetFecha.split('/');
    try { fechaDisplay = formatFecha(new Date(Number(a), Number(mo)-1, Number(d))); } catch(e) {}
  }

  function bloqueCliente(num, msgsCliente, waMsg) {
    const waNum = num.startsWith('549') ? num : `549${num.replace(/^54/, '')}`;
    const waLink = `https://wa.me/${waNum}?text=${waMsg}`;
    const filas = msgsCliente.map(({ hora, rol, texto }) => {
      const bg = rol === 'bot' ? '#f8f9fa' : '#fff';
      const color = rol === 'bot' ? '#34a853' : '#1a73e8';
      const label = rol === 'bot' ? '🤖 Bot' : '👤 Cliente';
      return `
      <tr style="background:${bg}">
        <td style="width:50px;color:#888;font-size:11px;vertical-align:top;padding:5px 8px;white-space:nowrap">${hora}</td>
        <td style="width:70px;color:${color};font-size:11px;font-weight:700;vertical-align:top;padding:5px 8px;white-space:nowrap">${label}</td>
        <td style="font-size:13px;padding:5px 8px;color:#202124;white-space:pre-wrap;word-break:break-word">${(texto || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td>
      </tr>`;
    }).join('');
    return `
    <div style="margin-bottom:24px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.14);overflow:hidden">
      <div style="background:#1a73e8;color:#fff;padding:10px 16px;font-size:13px;font-weight:600">
        <span>📱 +${num} &nbsp;·&nbsp; ${msgsCliente.length} mensajes</span>
      </div>
      <div style="padding:0 0 12px">
        <table style="border-collapse:collapse;width:100%">${filas}</table>
      </div>
      <div style="padding:0 16px 14px">
        <a href="${waLink}" target="_blank"
           style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;padding:9px 20px;border-radius:6px;font-size:13px;font-weight:700">
          💬 Enviar WhatsApp
        </a>
      </div>
    </div>`;
  }

  const seccionHeader = (titulo, subtitulo, color) => `
  <div style="background:${color};color:#fff;border-radius:8px 8px 0 0;padding:16px 24px;margin-top:24px">
    <div style="font-size:17px;font-weight:700">${titulo}</div>
    <div style="font-size:13px;opacity:.85;margin-top:3px">${subtitulo}</div>
  </div>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f3f4;font-family:Arial,sans-serif">
<div style="max-width:720px;margin:24px auto;padding:0 16px">
  <div style="background:#34a853;color:#fff;border-radius:8px 8px 0 0;padding:20px 24px">
    <div style="font-size:20px;font-weight:700">🔁 Recuperación de Ventas — Neumáticos Gallo</div>
    <div style="font-size:14px;opacity:.85;margin-top:4px">${fechaDisplay}${labelVentana || ''} &nbsp;·&nbsp; ${numeros.length} clientes</div>
  </div>
  ${numeros.length > 0 ? `
  ${seccionHeader('📲 Primer contacto', 'Clientes que consultaron en esta ventana — primer seguimiento', '#1a73e8')}
  <div style="background:#fff;padding:10px 24px 6px;font-size:13px;color:#444;margin-bottom:8px">
    Hacé click en <strong>Enviar WhatsApp</strong> para contactarlos.
  </div>
  <div style="padding-top:4px">
    ${numeros.map(n => bloqueCliente(n, grupos[n], MSG_RECUPERACION)).join('')}
  </div>` : ''}
  ${grupos2 && Object.keys(grupos2).length > 0 ? `
  ${seccionHeader('🔄 Segundo contacto (72hs)', 'Clientes que ya fueron contactados hace 3 días — seguimiento de cierre', '#7c3aed')}
  <div style="background:#fff;padding:10px 24px 6px;font-size:13px;color:#444;margin-bottom:8px">
    Preguntales si pudieron comprar y cómo fue su experiencia.
  </div>
  <div style="padding-top:4px">
    ${Object.keys(grupos2).sort().map(n => bloqueCliente(n, grupos2[n], MSG_RECUPERACION_2)).join('')}
  </div>` : ''}
  <div style="text-align:center;padding:16px;font-size:11px;color:#999">Generado automáticamente por el bot de Neumáticos Gallo</div>
</div></body></html>`;

  return { html, numeros: numeros.length, numeros2: grupos2 ? Object.keys(grupos2).length : 0, fechaLabel, grupos };
}

// ── Enviar email via Gmail API OAuth2 (evita bloqueo SMTP de Railway) ────────
async function enviarEmail(html, { numeros, numerosRev, numerosParticular, totalMensajes, fechaLabel }, asunto = null) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const from = EMAIL_FROM || 'j.gallo2502@gmail.com';
  const subject = asunto || `📊 Chats ${fechaLabel} — ${numeros} convs (🏪${numerosRev} rev · 👤${numerosParticular} part)`;

  const boundary = 'boundary_gallo_' + Date.now();
  const raw = [
    `From: "Bot Neumáticos Gallo" <${from}>`,
    `To: ${EMAIL_TO}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
  console.log(`✅ Email enviado a ${EMAIL_TO}: ${subject.slice(0, 60)}`);
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
  const soloRecupero = args.includes('--recupero-only');
  const ventanaArg = args.find(a => a.startsWith('--ventana='))?.split('=')[1]; // '8am'|'1pm'|'6pm'

  for (const arg of args) {
    if (arg === '--recupero-only' || arg.startsWith('--ventana=')) continue;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(arg)) targetFecha = arg;
    else if (arg.endsWith('.csv')) csvPath = arg;
  }

  // Ventana horaria para recupero (ART)
  // 8am  → ayer 18:00 – hoy 08:00
  // 1pm  → hoy  08:00 – hoy 13:00
  // 6pm  → hoy  13:00 – hoy 18:00
  const VENTANAS = { '8am': [18, 8], '1pm': [8, 13], '6pm': [13, 18] };
  const ventana = ventanaArg ? VENTANAS[ventanaArg] : null;

  // Si no hay fecha: recupero usa hoy, reporte diario usa ayer
  if (!targetFecha) {
    const offset = soloRecupero ? 0 : 24*60*60*1000;
    const d = new Date(Date.now() - 3*60*60*1000 - offset); // ART
    targetFecha = `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
  }

  // Calcular fecha de ayer (para ventana 8am que incluye desde ayer 18hs)
  const [dd, mm, aaaa] = targetFecha.split('/').map(Number);
  const hoyDate = new Date(aaaa, mm-1, dd);
  const ayerDate = new Date(hoyDate.getTime() - 24*60*60*1000);
  const targetFechaAyer = `${String(ayerDate.getDate()).padStart(2,'0')}/${String(ayerDate.getMonth()+1).padStart(2,'0')}/${ayerDate.getFullYear()}`;

  console.log(`📊 Generando reporte${soloRecupero ? ' de recupero' : ''}${ventana ? ` (ventana ${ventanaArg})` : ''} para ${targetFecha}...`);

  let mensajes;
  if (csvPath) {
    const csvAbs = path.resolve(csvPath);
    if (!fs.existsSync(csvAbs)) { console.error('❌ No se encontró el archivo:', csvAbs); process.exit(1); }
    const contenido = fs.readFileSync(csvAbs, 'utf8');
    mensajes = parsearCSV(contenido);
    console.log(`📄 CSV: ${mensajes.length} mensajes cargados`);
  } else {
    console.log('📡 Consultando API de Twilio...');
    // Para ventana 8am necesitamos también los mensajes de ayer desde las 18hs
    if (ventana && ventanaArg === '8am') {
      const [msgsAyer, msgsHoy] = await Promise.all([
        leerDesdeTwilio(targetFechaAyer),
        leerDesdeTwilio(targetFecha),
      ]);
      mensajes = [...msgsAyer, ...msgsHoy];
    } else {
      mensajes = await leerDesdeTwilio(targetFecha);
    }
    console.log(`📄 Twilio: ${mensajes.length} mensajes cargados`);
  }

  console.log('👥 Cargando lista de revendedores...');
  const revendedores = await leerRevendedores();
  console.log(`   ${revendedores.size} revendedores en la lista`);

  if (!soloRecupero) {
    const { html, ...stats } = generarHTML(mensajes, targetFecha, revendedores);
    await enviarEmail(html, stats);
  }

  // Aplicar filtro de ventana horaria si corresponde
  let mensajesFiltrados = mensajes;
  let labelVentana = '';
  if (ventana) {
    const [desdeH, hastaH] = ventana;
    if (ventanaArg === '8am') {
      // ayer >= 18:00 OR hoy < 08:00
      mensajesFiltrados = mensajes.filter(m => {
        const h = parseInt((m.hora || '00:00').split(':')[0]);
        if (m.fecha === targetFechaAyer) return h >= desdeH;
        if (m.fecha === targetFecha) return h < hastaH;
        return false;
      });
      labelVentana = ` (ayer 18hs – hoy 8hs)`;
    } else {
      mensajesFiltrados = mensajes.filter(m => {
        if (m.fecha !== targetFecha) return false;
        const h = parseInt((m.hora || '00:00').split(':')[0]);
        return h >= desdeH && h < hastaH;
      });
      labelVentana = ` (${desdeH}hs – ${hastaH}hs)`;
    }
    console.log(`⏱ Ventana ${ventanaArg}${labelVentana}: ${mensajesFiltrados.length} mensajes`);
  }

  // Excluir clientes que ya recibieron recupero en las últimas 70hs (evita repetir primer contacto)
  const yaEnviados = numerosYaEnviados();
  if (yaEnviados.size > 0) {
    const antes = mensajesFiltrados.length;
    mensajesFiltrados = mensajesFiltrados.filter(m => !yaEnviados.has(m.numero));
    console.log(`🔁 Excluidos ${yaEnviados.size} clientes ya contactados (quedan ${mensajesFiltrados.length} de ${antes} msgs)`);
  }

  // Cargar mensajes de hace 72hs para segundo recupero
  let mensajes2Filtrados = [];
  if (soloRecupero && ventana) {
    const listos = numerosParaSegundoRecupero();
    if (listos.size > 0) {
      console.log(`🔄 Buscando segundo recupero para ${listos.size} clientes (72hs)...`);
      // Fecha de hace 3 días
      const fecha72h = new Date(hoyDate.getTime() - 3*24*60*60*1000);
      const tf72 = `${String(fecha72h.getDate()).padStart(2,'0')}/${String(fecha72h.getMonth()+1).padStart(2,'0')}/${fecha72h.getFullYear()}`;
      let msgs72;
      if (ventanaArg === '8am') {
        const fecha72hAyer = new Date(fecha72h.getTime() - 24*60*60*1000);
        const tf72Ayer = `${String(fecha72hAyer.getDate()).padStart(2,'0')}/${String(fecha72hAyer.getMonth()+1).padStart(2,'0')}/${fecha72hAyer.getFullYear()}`;
        const [a, b] = await Promise.all([leerDesdeTwilio(tf72Ayer), leerDesdeTwilio(tf72)]);
        msgs72 = [...a, ...b];
      } else {
        msgs72 = await leerDesdeTwilio(tf72);
      }
      // Aplicar misma ventana horaria
      const [desdeH, hastaH] = ventana;
      if (ventanaArg === '8am') {
        const tf72Ayer = new Date(fecha72h.getTime() - 24*60*60*1000);
        const tf72AyerStr = `${String(tf72Ayer.getDate()).padStart(2,'0')}/${String(tf72Ayer.getMonth()+1).padStart(2,'0')}/${tf72Ayer.getFullYear()}`;
        mensajes2Filtrados = msgs72.filter(m => {
          const h = parseInt((m.hora || '00:00').split(':')[0]);
          if (m.fecha === tf72AyerStr) return h >= desdeH;
          if (m.fecha === tf72) return h < hastaH;
          return false;
        });
      } else {
        mensajes2Filtrados = msgs72.filter(m => {
          if (m.fecha !== tf72) return false;
          const h = parseInt((m.hora || '00:00').split(':')[0]);
          return h >= desdeH && h < hastaH;
        });
      }
      // Solo los clientes que están listos para segundo recupero
      mensajes2Filtrados = mensajes2Filtrados.filter(m => listos.has(m.numero));
      console.log(`🔄 Segundo recupero: ${new Set(mensajes2Filtrados.map(m=>m.numero)).size} clientes`);
    }
  }

  const recuperacion = generarHTMLRecuperacion(mensajesFiltrados, ventanaArg === '8am' ? null : targetFecha, revendedores, labelVentana, mensajes2Filtrados);
  if (recuperacion && (recuperacion.numeros > 0 || recuperacion.numeros2 > 0)) {
    const { html: htmlRec, numeros: nRec, numeros2: nRec2, fechaLabel: fl, grupos } = recuperacion;
    await enviarEmail(htmlRec,
      { numeros: nRec + nRec2, numerosRev: 0, numerosParticular: nRec + nRec2, totalMensajes: 0, fechaLabel: fl },
      `🔁 Recuperación${labelVentana} — ${nRec} nuevos${nRec2 > 0 ? ` + ${nRec2} seguimiento` : ''}`
    );
    if (nRec > 0) registrarEnvios(Object.keys(grupos || {}), 1);
    if (nRec2 > 0) registrarEnvios([...new Set(mensajes2Filtrados.map(m=>m.numero))], 2);
  } else if (soloRecupero) {
    console.log('ℹ️ No hay clientes para recuperar en este momento');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
