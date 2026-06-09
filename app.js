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

    // Generar token único para URL pública
    const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:I',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[fecha, num, vendedor, cliente, tel, productos, total, 'Enviado', token]],
      },
    });
    res.json({ ok: true, token });
  } catch (err) {
    console.error('Error guardar presupuesto:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Ver presupuesto público (link para cliente) ---
router.get('/ver/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:I',
    });
    const rows = result.data.values || [];
    const row = rows.find(r => r[8] === token);
    if (!row) return res.status(404).send('<h2>Presupuesto no encontrado</h2>');

    const [fecha, num, vendedor, cliente, tel, productos, total, estado] = row;
    const productosHtml = productos.split(' | ').map(p => `<li>${p}</li>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presupuesto ${num} — Neumáticos Gallo</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #222; }
    .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px; border-bottom: 3px solid #e63946; padding-bottom: 16px; }
    .logo { font-size: 22px; font-weight: 700; color: #1a1a2e; }
    .logo span { color: #e63946; }
    .num { text-align: right; font-size: 13px; color: #666; }
    .num strong { font-size: 20px; color: #1a1a2e; display: block; }
    .cliente { background: #f9f9f9; padding: 14px; border-radius: 8px; margin-bottom: 20px; }
    .productos { margin-bottom: 20px; }
    .productos li { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 14px; }
    .nota { font-size: 12px; color: #666; line-height: 1.6; background: #f0f7ff; padding: 12px; border-radius: 8px; }
    .sucursales { margin-top: 16px; font-size: 13px; }
    .sucursales a { color: #e63946; }
    .btn-print { display: block; width: 100%; padding: 14px; background: #e63946; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 20px; text-align: center; }
    @media print { .btn-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🔴 Neumáticos <span>Gallo</span></div>
    <div class="num"><strong>${num}</strong>${fecha}</div>
  </div>
  <div class="cliente">
    <strong>Cliente:</strong> ${cliente}<br>
    ${tel ? `<strong>WhatsApp:</strong> ${tel}` : ''}
  </div>
  <div class="productos">
    <p style="font-weight:600;margin-bottom:10px">Productos cotizados:</p>
    <ul style="padding-left:20px">${productosHtml}</ul>
  </div>
  <div class="nota">
    ✅ Garantía 5 años por defecto de fabricación<br>
    🔧 Colocación sin cargo en nuestros locales. Válvulas, balanceo y alineación se cobran aparte.<br>
    💳 Precio de lista en 12 pagos | 6 cuotas -10% | 3 cuotas -15% | Contado -20%<br>
    🌐 Compra online: <a href="https://tienda.neumaticosgallo.com.ar">tienda.neumaticosgallo.com.ar</a>
  </div>
  <div class="sucursales">
    📍 <strong>Victoria:</strong> Pres. Perón 3479 — <a href="https://wa.me/541137735246">11-3773-5246</a><br>
    📍 <strong>Nordelta:</strong> Agustín García 6318, Tigre — <a href="https://wa.me/541157347692">11-5734-7692</a><br>
    🕐 Lun-Vie 8 a 19 hs | Sáb 8 a 16 hs
  </div>
  <button class="btn-print" onclick="window.print()">🖨️ Guardar / Imprimir PDF</button>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('<h2>Error al cargar el presupuesto</h2>');
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

    console.log('Enviando WA a:', telWA, '| From:', process.env.TWILIO_WHATSAPP_NUMBER);
    const result = await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: `whatsapp:+${telWA}`,
      body: msg,
    });
    console.log('WA enviado OK. SID:', result.sid, '| Status:', result.status);
    res.json({ ok: true, sid: result.sid, status: result.status });
  } catch (err) {
    console.error('Error enviar WA:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Seguimiento: leer presupuestos ---
router.get('/seguimiento/presupuestos', authMiddleware, async (req, res) => {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:H',
    });
    const rows = result.data.values || [];
    const esAdmin = req.user.rol === 'admin';
    const vendedorActual = req.user.nombre;

    const presupuestos = rows.slice(1)
      .map((row, idx) => ({
        fila: idx + 2, // fila en sheet (1-indexed + header)
        fecha:     row[0] || '',
        numero:    row[1] || '',
        vendedor:  row[2] || '',
        cliente:   row[3] || '',
        tel:       row[4] || '',
        productos: row[5] || '',
        total:     row[6] || '',
        estado:    row[7] || 'Enviado',
      }))
      .filter(p => esAdmin || p.vendedor === vendedorActual)
      .reverse(); // más recientes primero

    res.json({ presupuestos, esAdmin });
  } catch (err) {
    console.error('Error seguimiento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Seguimiento: actualizar estado ---
router.post('/seguimiento/actualizar', express.json(), authMiddleware, async (req, res) => {
  try {
    const { fila, estado } = req.body;
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Presupuestos!H${fila}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[estado]] },
    });
    res.json({ ok: true });
  } catch (err) {
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

// --- Tiendanube OAuth callback ---
router.get('/tiendanube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Error: no se recibió el código de autorización');

  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const response = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '33802',
        client_secret: '6b1a1bf6e7266e6879d303966852d1a0014173e1835ab796',
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = await response.json();
    console.log('Tiendanube token response:', JSON.stringify(data));

    if (data.access_token) {
      res.send(`
        <h2>✅ Tiendanube conectado!</h2>
        <p><strong>Access Token:</strong> ${data.access_token}</p>
        <p><strong>User ID (Store ID):</strong> ${data.user_id}</p>
        <p>Copiá estos datos y pasáselos a Claude para configurar la integración.</p>
      `);
    } else {
      res.send(`<h2>❌ Error</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
    }
  } catch (err) {
    res.send(`<h2>❌ Error</h2><p>${err.message}</p>`);
  }
});

// --- Tiendanube: iniciar OAuth ---
router.get('/tiendanube/auth', (req, res) => {
  const url = `https://www.tiendanube.com/apps/33802/authorize`;
  res.redirect(url);
});

module.exports = router;
