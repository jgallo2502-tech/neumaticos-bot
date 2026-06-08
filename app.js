const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const { google } = require('googleapis');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'neumaticos-gallo-2026';

// --- Usuarios (en producción esto podría ir en Google Sheets) ---
const USUARIOS = [
  { usuario: 'admin',      password: 'gallo2026', nombre: 'Administrador', rol: 'admin' },
  { usuario: 'rgallo',     password: '12345',     nombre: 'R. Gallo',      rol: 'vendedor' },
  { usuario: 'lmoreno',    password: '12345',     nombre: 'L. Moreno',     rol: 'vendedor' },
  { usuario: 'ifukushima', password: '12345',     nombre: 'I. Fukushima',  rol: 'vendedor' },
  { usuario: 'rgonzalez',  password: '12345',     nombre: 'R. Gonzalez',   rol: 'vendedor' },
  { usuario: 'nruiz',      password: '12345',     nombre: 'N. Ruiz',       rol: 'vendedor' },
  { usuario: 'hvillalobos',password: '12345',     nombre: 'H. Villalobos', rol: 'vendedor' },
  { usuario: 'prueba',     password: '12345',     nombre: 'Prueba',        rol: 'vendedor' },
];

// --- Middleware de auth ---
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'No autorizado' });
  }
}

// --- Servir archivos estáticos sin caché ---
router.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

// --- Login ---
router.post('/login', express.json(), (req, res) => {
  const { usuario, password } = req.body;
  const user = USUARIOS.find(u => u.usuario === usuario && u.password === password);
  if (!user) return res.status(401).json({ error: 'Inválido' });
  const token = jwt.sign({ usuario: user.usuario, nombre: user.nombre, rol: user.rol }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, nombre: user.nombre });
});

// --- Buscar precios (reutiliza lógica del bot) ---
router.post('/precios', express.json(), authMiddleware, async (req, res) => {
  const { medidas } = req.body;
  const { obtenerPrecios, normalizarMedida } = require('./index');
  const resultado = {};
  for (const medida of medidas) {
    const norm = normalizarMedida(medida);
    if (!norm) { resultado[medida] = []; continue; }
    resultado[norm] = await obtenerPrecios(norm, null, false);
  }
  res.json(resultado);
});

// --- Guardar presupuesto en Google Sheets ---
router.post('/guardar-presupuesto', express.json(), authMiddleware, async (req, res) => {
  try {
    const { cliente, tel, num, fecha, items } = req.body;
    const vendedor = req.user.nombre;
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const productos = items.map(i => i.descripcion).join(' | ');
    const total = items.reduce((s, i) => s + Math.round(i.precio * 0.80) * 4, 0);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[fecha, num, vendedor, cliente, tel, productos, total, 'Enviado']],
      },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error guardar presupuesto:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Enviar presupuesto por WhatsApp ---
router.post('/enviar-presupuesto', express.json(), authMiddleware, async (req, res) => {
  try {
    const { cliente, tel, num, items } = req.body;
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const fmt = n => Math.round(n).toLocaleString('es-AR');
    let msg = `🔴 *Neumáticos Gallo* — Presupuesto ${num}\n`;
    msg += `👤 ${cliente}\n📅 ${new Date().toLocaleDateString('es-AR')}\n\n`;

    for (const p of items) {
      const contado = Math.round(p.precio * 0.80);
      const c6 = Math.round(p.precio * 0.90);
      const c3 = Math.round(p.precio * 0.85);
      msg += `🔹 *${p.descripcion}*\n`;
      msg += `   💳 12 pagos: $${fmt(p.precio)}/und.\n`;
      msg += `   💳 6 cuotas (-10%): $${fmt(c6)}/und.\n`;
      msg += `   💳 3 cuotas (-15%): $${fmt(c3)}/und.\n`;
      msg += `   💵 Contado (-20%): $${fmt(contado)}/und.\n`;
      msg += `   _Precio por juego de 4: $${fmt(contado * 4)} contado_\n\n`;
    }

    msg += `✅ Garantía 5 años por defecto de fabricación.\n`;
    msg += `🔧 Colocación sin cargo en nuestros locales.\n\n`;
    msg += `📍 Victoria: Pres. Perón 3479 | 11-3773-5246\n`;
    msg += `📍 Nordelta: Agustín García 6318, Tigre | 11-5734-7692\n`;
    msg += `🌐 tienda.neumaticosgallo.com.ar`;

    let telLimpio = tel.replace(/\D/g, '');
    // Normalizar número argentino: agregar 549 para celulares
    if (telLimpio.startsWith('549')) {
      // ya está bien
    } else if (telLimpio.startsWith('54')) {
      telLimpio = '549' + telLimpio.slice(2);
    } else if (telLimpio.startsWith('0')) {
      telLimpio = '549' + telLimpio.slice(1);
    } else {
      telLimpio = '549' + telLimpio;
    }
    const telWA = telLimpio;

    await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${telWA}`,
      body: msg,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviar WA:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Broadcast: listar plantillas aprobadas ---
router.get('/broadcast/plantillas', authMiddleware, async (req, res) => {
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const templates = await twilio.content.v1.contents.list({ limit: 50 });
    const aprobadas = templates
      .filter(t => t.approvalRequests?.status === 'approved' || true) // mostrar todas
      .map(t => ({
        sid: t.sid,
        nombre: t.friendlyName,
        body: t.types?.['twilio/text']?.body || t.types?.['twilio/quick-reply']?.body || JSON.stringify(t.types)
      }));
    res.json(aprobadas);
  } catch (err) {
    console.error('Error plantillas:', err.message);
    res.json([]);
  }
});

// --- Broadcast: cantidad de revendedores ---
router.get('/broadcast/revendedores', authMiddleware, async (req, res) => {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Revendedores!A:A',
    });
    const rows = (result.data.values || []).slice(1).flat().filter(n => n && n.length > 5);
    res.json({ total: rows.length, numeros: rows });
  } catch (err) {
    res.json({ total: 0, numeros: [] });
  }
});

// --- Broadcast: enviar mensajes con streaming ---
router.post('/broadcast/enviar', express.json(), authMiddleware, async (req, res) => {
  const { templateSid, tipo, numeros: numerosManual } = req.body;
  const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  let numeros = [];
  if (tipo === 'revendedores') {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Revendedores!A:A',
    });
    numeros = (result.data.values || []).slice(1).flat().filter(n => n && n.length > 5);
  } else {
    numeros = numerosManual || [];
  }

  // Streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (data) => res.write(`data:${JSON.stringify(data)}\n\n`);

  for (const numero of numeros) {
    let tel = numero.toString().replace(/\D/g, '');
    if (!tel.startsWith('549')) {
      tel = tel.startsWith('54') ? '549' + tel.slice(2) : '549' + tel;
    }

    try {
      await twilio.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: `whatsapp:+${tel}`,
        contentSid: templateSid,
        contentVariables: '{}',
      });
      send({ tipo: 'ok', numero: tel, total: numeros.length });
    } catch (err) {
      send({ tipo: 'error', numero: tel, msg: err.message, total: numeros.length });
    }

    // Pausa de 2 segundos entre mensajes
    await new Promise(r => setTimeout(r, 2000));
  }

  res.end();
});

module.exports = router;
