const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const { google } = require('googleapis');

// Parsear credenciales Google UNA sola vez y corregir private_key
let GOOGLE_CREDS;
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (GOOGLE_CREDS && GOOGLE_CREDS.private_key) {
    GOOGLE_CREDS.private_key = GOOGLE_CREDS.private_key.replace(/\\n/g, '\n');
  }
} catch(e) {
  console.error('app.js ERROR al parsear GOOGLE_CREDENTIALS:', e.message);
}

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'neumaticos-gallo-2026';

// --- Usuarios (en producción esto podría ir en Google Sheets) ---
const USUARIOS = [
  { usuario: 'admin',      password: 'gallo2026', nombre: 'Administrador', rol: 'admin',     sucursal: null },
  { usuario: 'rgallo',     password: '12345',     nombre: 'R. Gallo',      rol: 'vendedor',  sucursal: 'Victoria' },
  { usuario: 'lmoreno',    password: '12345',     nombre: 'L. Moreno',     rol: 'vendedor',  sucursal: 'Nordelta' },
  { usuario: 'ifukushima', password: '12345',     nombre: 'I. Fukushima',  rol: 'vendedor',  sucursal: 'Victoria' },
  { usuario: 'rgonzalez',  password: '12345',     nombre: 'R. Gonzalez',   rol: 'vendedor',  sucursal: 'Victoria' },
  { usuario: 'nruiz',      password: '12345',     nombre: 'N. Ruiz',       rol: 'vendedor',  sucursal: 'Victoria' },
  { usuario: 'hvillalobos',password: '12345',     nombre: 'H. Villalobos', rol: 'vendedor',  sucursal: 'Victoria' },
  { usuario: 'prueba',     password: '12345',     nombre: 'Prueba',        rol: 'vendedor',  sucursal: 'Victoria' },
];

// Mapa vendedor -> sucursal
const SUCURSAL_MAP = Object.fromEntries(USUARIOS.filter(u => u.sucursal).map(u => [u.nombre, u.sucursal]));

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
  res.json({ token, nombre: user.nombre, rol: user.rol });
});

// --- Buscar precios (reutiliza lógica del bot) ---
router.post('/precios', express.json(), authMiddleware, async (req, res) => {
  const { medidas, depositos } = req.body;
  const { obtenerPrecios, normalizarMedida } = require('./index');
  const resultado = {};
  for (const medida of medidas) {
    const norm = normalizarMedida(medida);
    if (!norm) { resultado[medida] = []; continue; }
    const minStock = (depositos && depositos.pocoStock) ? 1 : 4;
    const soloRunFlat = !!(depositos && depositos.soloRunFlat);
    let prods = await obtenerPrecios(norm, null, soloRunFlat, minStock);
    if (depositos) {
      prods = prods.filter(p => {
        if (depositos.victoria && p.stockVic >= minStock) return true;
        if (depositos.nordelta && p.stockNor >= minStock) return true;
        if (depositos.express  && p.stockExpr > 0) return true;
        return false;
      });
    }
    resultado[norm] = prods;
  }
  res.json(resultado);
});

// --- Imágenes de productos ---
let imagenesCache = null;
let imagenesCacheTs = 0;

router.get('/imagenes', authMiddleware, async (req, res) => {
  try {
    const ahora = Date.now();
    if (imagenesCache && ahora - imagenesCacheTs < 5 * 60 * 1000) {
      return res.json(imagenesCache);
    }
    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: GOOGLE_CREDS }
        : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: '160e1dKlTch9gzOOxjhz7hKJKfbrMifAyTXE10aZRbgw',
      range: 'Imágenes!A:D',
    });
    const mapa = {};
    for (const row of (r.data.values || []).slice(1)) {
      const marca  = (row[0] || '').trim().toUpperCase();
      const modelo = (row[1] || '').trim().toUpperCase();
      const url    = (row[2] || '').trim();
      if (marca && modelo && url) mapa[marca + '|' + modelo] = url;
    }
    imagenesCache = mapa;
    imagenesCacheTs = ahora;
    res.json(mapa);
  } catch (e) {
    console.error('Error cargando imágenes:', e.message);
    res.json({});
  }
});

// --- Resumen de vendedores (solo admin) ---
router.get('/stats-vendedores', authMiddleware, async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:H',
    });
    const rows = (result.data.values || []).slice(1);

    const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hoy = ahora.toISOString().slice(0, 10);
    const hace7 = new Date(ahora); hace7.setDate(hace7.getDate() - 6);
    const hace30 = new Date(ahora); hace30.setDate(hace30.getDate() - 29);

    const parseDate = (f) => {
      if (!f) return null;
      if (f.includes('/')) { const [d,m,y] = f.split('/'); return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
      return f.slice(0, 10);
    };

    const stats = {};
    for (const row of rows) {
      const vend = row[2] || 'Sin asignar';
      const fecha = parseDate(row[0]);
      const estado = row[7] || '';
      if (!stats[vend]) stats[vend] = { hoy: 0, dias7: 0, dias30: 0, seguimiento: 0 };
      const s = stats[vend];
      if (fecha === hoy) s.hoy++;
      if (fecha >= hace7.toISOString().slice(0,10)) s.dias7++;
      if (fecha >= hace30.toISOString().slice(0,10)) s.dias30++;
      if (estado === 'En seguimiento') s.seguimiento++;
    }
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats de presupuestos del vendedor ---
router.get('/mis-stats', authMiddleware, async (req, res) => {
  try {
    const vendedor = req.user.nombre;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:C',
    });
    const rows = (result.data.values || []).slice(1);

    // Fecha actual en AR (UTC-3)
    const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hoy = ahora.toISOString().slice(0, 10); // YYYY-MM-DD

    const parseDate = (f) => {
      if (!f) return null;
      // Soporta DD/MM/YYYY y YYYY-MM-DD
      if (f.includes('/')) { const [d,m,y] = f.split('/'); return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
      return f.slice(0, 10);
    };

    let hoyCount = 0, mes30 = 0;
    const dias7 = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(ahora); d.setDate(d.getDate() - i);
      dias7[d.toISOString().slice(0,10)] = 0;
    }
    const hace30 = new Date(ahora); hace30.setDate(hace30.getDate() - 29);
    const hace30Str = hace30.toISOString().slice(0,10);

    for (const row of rows) {
      if ((row[2] || '') !== vendedor) continue;
      const fecha = parseDate(row[0]);
      if (!fecha) continue;
      if (fecha === hoy) hoyCount++;
      if (fecha >= hace30Str) mes30++;
      if (dias7.hasOwnProperty(fecha)) dias7[fecha]++;
    }

    res.json({ hoy: hoyCount, mes30, dias7 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Guardar presupuesto en Google Sheets ---
router.post('/guardar-presupuesto', express.json(), authMiddleware, async (req, res) => {
  try {
    const { cliente, tel, num, fecha, items } = req.body;
    const vendedor = req.user.nombre;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    const productos = items.map(i => i.descripcion).join(' | ');
    const total = items.reduce((s, i) => s + Math.round(i.precio * 0.80) * 4, 0);

    // Generar token único para URL pública
    const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    const datos = JSON.stringify(req.body); // guardar datos completos
    console.log('GUARDAR - items:', req.body?.items?.length, '| cant:', req.body?.cant, '| datos length:', datos.length, '| token:', token);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:J',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[fecha, num, vendedor, cliente, tel, productos, total, 'Enviado', token, datos]],
      },
    });
    res.json({ ok: true, token });
  } catch (err) {
    console.error('Error guardar presupuesto:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Helper para renderizar presupuesto ---
function renderPresupuestoPage(res, row, autoPrint) {
  const [fecha, num, vendedor, cliente, tel, productos, total, estado, , datosJSON] = row;
  let datos = null;
  try { datos = datosJSON ? JSON.parse(datosJSON) : null; } catch(e) {}

  function fmt(n) { return '$' + Math.round(n).toLocaleString('es-AR'); }

  let productosHtml = '';
  if (datos && datos.items && datos.items.length > 0) {
    const cant = datos.cant || 4;
    const fp12 = datos.fp12 !== false;
    const fp6  = datos.fp6 !== false;
    const fp3  = datos.fp3 !== false;
    const fp1  = datos.fp1 !== false;

    for (const p of datos.items) {
      const precio = p.precio || 0;
      const c12 = precio * cant;
      const c6t = Math.round(precio * 0.90) * cant;
      const c6c = Math.round(c6t / 6);
      const c3t = Math.round(precio * 0.85) * cant;
      const c3c = Math.round(c3t / 3);
      const c1  = Math.round(precio * 0.80) * cant;

      productosHtml += `<div style="border:1px solid #e8e8e8;border-radius:8px;padding:14px;margin-bottom:12px">
        <div style="font-weight:700;font-size:15px;margin-bottom:10px">${p.descripcion}</div>
        <div style="font-size:13px;color:#444;line-height:1.9">
          <div>Cantidad: <strong>${cant} unidades</strong></div>
          ${fp12 ? `<div>💳 12 pagos (lista): <strong>${fmt(c12)}</strong></div>` : ''}
          ${fp6  ? `<div>💳 6 cuotas (-10%): <strong>${fmt(c6t)}</strong> &nbsp;·&nbsp; ${fmt(c6c)}/cuota</div>` : ''}
          ${fp3  ? `<div>💳 3 cuotas (-15%): <strong>${fmt(c3t)}</strong> &nbsp;·&nbsp; ${fmt(c3c)}/cuota</div>` : ''}
          ${fp1  ? `<div>💵 Contado (-20%): <strong>${fmt(c1)}</strong></div>` : ''}
        </div>
      </div>`;
    }

    if (datos.servicios && datos.servicios.resumen) {
      productosHtml += `<div style="background:#f0f7ff;padding:12px;border-radius:8px;font-size:13px;margin-bottom:12px">
        🔧 <strong>Servicios:</strong> ${datos.servicios.resumen}
      </div>`;
    }
  } else {
    productosHtml = productos.split(' | ').map(p => `<div style="padding:8px 0;border-bottom:1px solid #eee">${p}</div>`).join('');
  }

  let tablaUnitarios = '';
  let tablaResumen = '';
  if (datos && datos.items) {
    const cant = datos.cant || 4;
    const fp12 = datos.fp12 !== false;
    const fp6  = datos.fp6 !== false;
    const fp3  = datos.fp3 !== false;
    const fp1  = datos.fp1 !== false;

    let headers1 = '<th style="text-align:left;padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">Producto</th>';
    if (fp12) headers1 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">12 pagos<br>(lista)</th>';
    if (fp6)  headers1 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">6 cuotas<br>(-10%)<br><small>c/cuota</small></th>';
    if (fp3)  headers1 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">3 cuotas<br>(-15%)<br><small>c/cuota</small></th>';
    if (fp1)  headers1 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">Contado<br>(-20%)</th>';

    let rows1 = '';
    for (const p of datos.items) {
      const precio = p.precio || 0;
      const c6t = Math.round(precio * 0.90); const c6c = Math.round(c6t / 6);
      const c3t = Math.round(precio * 0.85); const c3c = Math.round(c3t / 3);
      const c1  = Math.round(precio * 0.80);
      rows1 += `<tr>
        <td style="padding:12px;border-bottom:1px solid #eee;font-size:13px">${p.descripcion}</td>
        ${fp12 ? `<td style="padding:12px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${fmt(precio)}</td>` : ''}
        ${fp6  ? `<td style="padding:12px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${fmt(c6t)}<br><small style="color:#666">${fmt(c6c)}/cuota</small></td>` : ''}
        ${fp3  ? `<td style="padding:12px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${fmt(c3t)}<br><small style="color:#666">${fmt(c3c)}/cuota</small></td>` : ''}
        ${fp1  ? `<td style="padding:12px;border-bottom:1px solid #eee;font-size:13px;text-align:right;font-weight:700;color:#e63946">${fmt(c1)}</td>` : ''}
      </tr>`;
    }
    tablaUnitarios = `<table style="width:100%;border-collapse:collapse"><thead><tr>${headers1}</tr></thead><tbody>${rows1}</tbody></table>`;

    let headers2 = '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">Cant.</th>';
    if (fp12) headers2 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">12 pagos (lista)<br><small>total / c/cuota</small></th>';
    if (fp6)  headers2 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">6 cuotas (-10%)<br><small>total / c/cuota</small></th>';
    if (fp3)  headers2 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">3 cuotas (-15%)<br><small>total / c/cuota</small></th>';
    if (fp1)  headers2 += '<th style="padding:10px 12px;background:#1a1a2e;color:white;font-size:12px">Contado (-20%)<br><small>total</small></th>';

    for (const p of datos.items) {
      const precio = p.precio || 0;
      const r12 = precio * cant;
      const r6t = Math.round(precio * 0.90) * cant; const r6c = Math.round(r6t / 6);
      const r3t = Math.round(precio * 0.85) * cant; const r3c = Math.round(r3t / 3);
      const r1  = Math.round(precio * 0.80) * cant;
      const row2 = `<tr style="background:#f9f9f9">
        <td style="padding:12px;font-weight:700;font-size:14px">${cant} unid.</td>
        ${fp12 ? `<td style="padding:12px;text-align:right;font-size:13px"><strong>${fmt(r12)}</strong><br><small style="color:#666">${fmt(Math.round(r12/12))}/cuota</small></td>` : ''}
        ${fp6  ? `<td style="padding:12px;text-align:right;font-size:13px"><strong>${fmt(r6t)}</strong><br><small style="color:#666">${fmt(r6c)}/cuota</small></td>` : ''}
        ${fp3  ? `<td style="padding:12px;text-align:right;font-size:13px"><strong>${fmt(r3t)}</strong><br><small style="color:#666">${fmt(r3c)}/cuota</small></td>` : ''}
        ${fp1  ? `<td style="padding:12px;text-align:right;font-size:13px;font-weight:700;color:#e63946"><strong>${fmt(r1)}</strong></td>` : ''}
      </tr>`;
      tablaResumen += `<div style="margin-bottom:20px">
        <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#1a1a2e">◆ ${p.descripcion}</div>
        <table style="width:100%;border-collapse:collapse"><thead><tr>${headers2}</tr></thead><tbody>${row2}</tbody></table>
      </div>`;
    }

    if (datos.servicios && datos.servicios.resumen) {
      tablaResumen += `<div style="background:#f0f7ff;padding:12px;border-radius:8px;font-size:13px;margin-top:8px">🔧 <strong>Servicios:</strong> ${datos.servicios.resumen}</div>`;
    }
  }

  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presupuesto ${num} — Neumáticos Gallo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; color: #222; background: #f5f5f5; }
    .hoja { background: white; max-width: 750px; margin: 20px auto; padding: 28px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px; border-bottom: 3px solid #e63946; padding-bottom: 16px; }
    .logo { font-size: 20px; font-weight: 700; color: #1a1a2e; }
    .logo span { color: #e63946; }
    .logo-sub { font-size: 12px; color: #666; margin-top: 4px; line-height: 1.5; }
    .num { text-align: right; font-size: 13px; color: #666; }
    .num strong { font-size: 22px; color: #1a1a2e; display: block; }
    .cliente { margin-bottom: 16px; font-size: 14px; }
    .nota { font-size: 12px; color: #555; margin-top: 16px; padding: 10px 14px; background: #f9f9f9; border-radius: 6px; line-height: 1.7; }
    .btn-print { display: block; width: 100%; padding: 14px; background: #e63946; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin: 20px auto; max-width: 750px; }
    @media print { .btn-print { display: none !important; } body { background: white; } .hoja { box-shadow: none; margin: 0; border-radius: 0; } }
  </style>
</head>
<body>

  <!-- HOJA 1: Precios unitarios -->
  <div class="hoja">
    <div class="header">
      <div>
        <div class="logo">🔴 Neumáticos <span>Gallo</span></div>
        <div class="logo-sub">Suc. Victoria: Pres. Perón 3479 | <a href="https://wa.me/541137735246" style="color:#e63946">11-3773-5246</a><br>
        Suc. Nordelta: Agustín García 6318, Tigre | <a href="https://wa.me/541157347692" style="color:#e63946">11-5734-7692</a><br>
        tienda.neumaticosgallo.com.ar</div>
      </div>
      <div class="num"><strong>${num}</strong>${fecha}</div>
    </div>
    <div class="cliente"><strong>Cliente:</strong> ${cliente} &nbsp;|&nbsp; <strong>WhatsApp:</strong> ${tel || '-'}</div>
    <p style="font-size:13px;color:#666;margin-bottom:12px">Precios por unidad</p>
    ${tablaUnitarios}
    <div class="nota">
      ✅ Garantía 5 años por defecto de fabricación &nbsp;|&nbsp; 🔧 Colocación sin cargo &nbsp;|&nbsp; ⚠️ Promos presenciales por compra de 2+
    </div>
  </div>

  <!-- HOJA 2: Resumen de compra -->
  <div class="hoja" style="margin-top:0">
    <div class="header">
      <div>
        <div class="logo">🔴 Neumáticos <span>Gallo</span> — Resumen de compra</div>
        <div class="logo-sub">Suc. Victoria: Pres. Perón 3479 | 11-5734-7692<br>Suc. Nordelta: Agustín García 6318, Tigre | 11-5734-7692</div>
      </div>
      <div class="num"><strong>${num}</strong>${fecha}</div>
    </div>
    <p style="font-size:14px;margin-bottom:16px"><strong>Cliente:</strong> ${cliente}</p>
    ${tablaResumen}
    <div class="nota" style="margin-top:16px">
      🌐 Compra online: tienda.neumaticosgallo.com.ar — envíos sin cargo superando mínimo de compra.
    </div>
  </div>

  <button class="btn-print" onclick="window.print()">🖨️ Guardar / Imprimir PDF</button>
  <script>
    if (window.location.search.includes('print=1')) {
      window.print();
    }
  </script>
</body>
</html>`);
}

// --- Ver presupuesto público (link para cliente) ---
router.get('/ver/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:J',
    });
    const rows = result.data.values || [];
    const row = rows.find(r => r[8] === token);
    if (!row) return res.status(404).send('<h2>Presupuesto no encontrado</h2>');
    renderPresupuestoPage(res, row, req.query.print === '1');
  } catch (err) {
    res.status(500).send('<h2>Error al cargar el presupuesto</h2>');
  }
});

router.get('/ver/fila/:fila', async (req, res) => {
  try {
    const fila = parseInt(req.params.fila, 10);
    if (Number.isNaN(fila) || fila < 2) return res.status(404).send('<h2>Presupuesto no encontrado</h2>');
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:J',
    });
    const rows = result.data.values || [];
    const row = rows[fila - 1];
    if (!row) return res.status(404).send('<h2>Presupuesto no encontrado</h2>');
    renderPresupuestoPage(res, row, req.query.print === '1');
  } catch (err) {
    res.status(500).send('<h2>Error al cargar el presupuesto</h2>');
  }
});
// --- Enviar presupuesto por WhatsApp ---
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
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:I',
    });
    const rows = result.data.values || [];
    const esAdmin = req.user.rol === 'admin';
    const vendedorActual = req.user.nombre;

    const presupuestos = rows.slice(1)
      .map((row, idx) => ({
        fila: idx + 2,
        fecha:     row[0] || '',
        numero:    row[1] || '',
        vendedor:  row[2] || '',
        sucursal:  SUCURSAL_MAP[row[2]] || 'Victoria',
        cliente:   row[3] || '',
        tel:       row[4] || '',
        productos: row[5] || '',
        total:     row[6] || '',
        estado:    row[7] || 'Enviado',
        token:     row[8] || '',
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
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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

// --- Reporte diario ---
async function generarReporteDiario(fechaParam) {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:H',
    });
    const rows = result.data.values || [];

    // Fecha: parámetro o hoy (formato d/m/yyyy sin ceros)
    let hoy;
    if (fechaParam) {
      // Viene como yyyy-mm-dd desde el input date del HTML
      const [y, m, d] = fechaParam.split('-');
      hoy = `${parseInt(d)}/${parseInt(m)}/${y}`;
    } else {
      const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
      hoy = `${ahora.getUTCDate()}/${ahora.getUTCMonth()+1}/${ahora.getUTCFullYear()}`;
    }

    const presupuestosHoy = rows.slice(1).filter(r => r[0] === hoy);

    if (presupuestosHoy.length === 0) {
      return '📊 *Reporte del día* — ' + hoy + '\n\nNo se registraron presupuestos hoy.';
    }

    // Agrupar por sucursal y vendedor
    const porSucursal = {};
    for (const row of presupuestosHoy) {
      const vendedor = row[2] || 'Sin vendedor';
      const suc = SUCURSAL_MAP[vendedor] || 'Victoria';
      const estado = row[7] || 'Enviado';
      const total = parseInt((row[6]||'0').replace(/\D/g,'')) || 0;

      if (!porSucursal[suc]) porSucursal[suc] = {};
      if (!porSucursal[suc][vendedor]) porSucursal[suc][vendedor] = { total: 0, vendidos: 0, monto: 0 };
      porSucursal[suc][vendedor].total++;
      if (estado === 'Vendido') {
        porSucursal[suc][vendedor].vendidos++;
        porSucursal[suc][vendedor].monto += total;
      }
    }

    let msg = `📊 *Reporte del día — ${hoy}*\n`;
    msg += `Total presupuestos: *${presupuestosHoy.length}*\n`;
    const vendidosTotales = presupuestosHoy.filter(r => (r[7]||'') === 'Vendido').length;
    msg += `Vendidos: *${vendidosTotales}*\n\n`;

    for (const [suc, vendedores] of Object.entries(porSucursal)) {
      msg += `📍 *${suc}*\n`;
      for (const [vend, stats] of Object.entries(vendedores)) {
        msg += `  • ${vend}: ${stats.total} presup.`;
        if (stats.vendidos > 0) msg += ` | ${stats.vendidos} vendidos`;
        msg += '\n';
      }
      msg += '\n';
    }

    // Pendientes sin respuesta
    const sinRespuesta = rows.slice(1).filter(r => {
      if ((r[7]||'') !== 'Enviado') return false;
      const [d,m,y] = (r[0]||'').split('/');
      const fecha = new Date(y, m-1, d);
      const horas = (Date.now() - fecha.getTime()) / (1000*60*60);
      return horas >= 48;
    });
    if (sinRespuesta.length > 0) {
      msg += `⚠️ *Sin respuesta +48hs: ${sinRespuesta.length}* presupuestos pendientes de seguimiento`;
    }

    return msg;
  } catch (err) {
    console.error('Error reporte diario:', err.message);
    return null;
  }
}

router.get('/reporte-diario', authMiddleware, async (req, res) => {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const reporte = await generarReporteDiario(req.query.fecha || null);
  res.json({ reporte });
});

// Endpoint interno para trigger por cron/schedule
router.post('/reporte-diario/enviar', async (req, res) => {
  const key = req.headers['x-cron-key'];
  if (key !== (process.env.CRON_KEY || 'neumaticos-cron-2026')) return res.status(401).end();

  const reporte = await generarReporteDiario();
  if (!reporte) return res.json({ ok: false });

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: 'whatsapp:+5491132903238',
      contentSid: 'HXb3d37d3ffd461ca6a214ca9070012012',
      contentVariables: JSON.stringify({ '1': reporte }),
    });
    console.log('Reporte diario enviado');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando reporte:', err.message);
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
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
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
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
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
// --- Conversaciones del bot ---
router.get('/conversaciones/mensajes', authMiddleware, async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Mensajes!A:E',
    });
    const rows = (result.data.values || []).slice(1); // skip header if any
    // Agrupar por numero + fecha (una conversación por día por número)
    const grupos = {};
    for (const [fecha, hora, numero, rol, texto] of rows) {
      if (!numero) continue;
      const key = `${numero}||${fecha}`;
      if (!grupos[key]) grupos[key] = { numero, fecha, mensajes: [] };
      grupos[key].mensajes.push({ hora, rol, texto });
    }
    // Ordenar por fecha+hora del último mensaje (más reciente primero)
    const conversaciones = Object.values(grupos).sort((a, b) => {
      const toNum = (c) => {
        const [d, m, y] = c.fecha.split('/');
        const h = (c.mensajes.at(-1)?.hora || '00:00').replace(':', '');
        return parseInt(y + m + d + h);
      };
      return toNum(b) - toNum(a);
    });
    res.json({ conversaciones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Seguimiento Bot ---
router.get('/bot/seguimiento', authMiddleware, async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Consultas!A:I',
    });
    const rows = (result.data.values || []).slice(1);
    // Una consulta por número por día (la última)
    const map = {};
    rows.forEach((r, i) => {
      const numero = r[2];
      if (!numero) return;
      const key = `${r[0]}||${numero}`;
      map[key] = { fila: i + 2, fecha: r[0], hora: r[1], numero, medida: r[3], marca: r[4], estado: r[8] || 'Pendiente' };
    });
    const consultas = Object.values(map).sort((a, b) => {
      const fa = a.fecha.split('/').reverse().join('') + a.hora;
      const fb = b.fecha.split('/').reverse().join('') + b.hora;
      return fb.localeCompare(fa);
    });
    res.json({ consultas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/seguimiento/actualizar', express.json(), authMiddleware, async (req, res) => {
  const { fila, estado } = req.body;
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Consultas!I${fila}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[estado]] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alertas de ayuda humana ---
router.get('/conversaciones/alertas', authMiddleware, async (req, res) => {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Alertas!A:E',
    });
    const rows = (result.data.values || []).slice(1);
    const pendientes = rows
      .map((r, i) => ({ fila: i + 2, fecha: r[0], hora: r[1], numero: r[2], mensaje: r[3], atendido: r[4] }))
      .filter(a => a.atendido !== 'SI' && a.numero);
    res.json({ alertas: pendientes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversaciones/alertas/atender', express.json(), authMiddleware, async (req, res) => {
  const { fila } = req.body;
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Alertas!E${fila}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['SI']] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tiendanube/auth', (req, res) => {
  const url = `https://www.tiendanube.com/apps/33802/authorize`;
  res.redirect(url);
});

// ============================================================
// PORTAL DE REVENTA
// ============================================================

function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    list[k.trim()] = decodeURIComponent(v.join('='));
  });
  return list;
}

function reventaAuthMiddleware(req, res, next) {
  const cookies = parseCookies(req);
  try {
    req.revendedor = jwt.verify(cookies.reventa_token || '', JWT_SECRET);
    if (req.revendedor.tipo !== 'revendedor') throw new Error();
    next();
  } catch {
    res.redirect('/reventa/login');
  }
}

function descuentoRevendedor(marca) {
  const m = (marca || '').toLowerCase();
  if (['michelin', 'bfgoodrich'].includes(m)) return 0.35;
  if (['giti', 'gtradial'].includes(m)) return 0.33;
  if (['yokohama', 'nexen'].includes(m)) return 0.32;
  return 0.28;
}

function fmtPeso(n) { return '$' + Math.round(n).toLocaleString('es-AR'); }

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reventa — Neumáticos Gallo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 380px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    .logo { font-size: 22px; font-weight: 800; color: #1a1a2e; text-align: center; margin-bottom: 4px; }
    .logo span { color: #e63946; }
    .sub { text-align: center; font-size: 13px; color: #888; margin-bottom: 28px; }
    label { font-size: 13px; font-weight: 600; color: #444; display: block; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 16px; outline: none; transition: border-color .2s; }
    input:focus { border-color: #e63946; }
    button { width: 100%; padding: 13px; background: #e63946; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }
    .err { color: #e63946; font-size: 13px; text-align: center; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Neumáticos <span>Gallo</span></div>
    <div class="sub">Portal de Revendedores</div>
    <form method="POST" action="/reventa/login">
      <label>Teléfono</label>
      <input type="tel" name="telefono" placeholder="11 1234-5678" required autofocus>
      <label>Contraseña</label>
      <input type="password" name="password" required>
      <button type="submit">Ingresar</button>
      {{ERROR}}
    </form>
  </div>
</body>
</html>`;

router.get('/reventa/login', (req, res) => {
  res.send(LOGIN_HTML.replace('{{ERROR}}', ''));
});

router.post('/reventa/login', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { telefono, password } = req.body;
    const telClean = (telefono || '').replace(/\D/g, '');

    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Revendedores!A:C',
    });
    const rows = (result.data.values || []).slice(1);
    const fila = rows.find(r => {
      const t = (r[0] || '').replace(/\D/g, '');
      return t === telClean && (r[1] || '') === password;
    });

    if (!fila) {
      return res.send(LOGIN_HTML.replace('{{ERROR}}', '<div class="err">Teléfono o contraseña incorrectos</div>'));
    }

    const nombre = fila[2] || telClean;
    const token = jwt.sign({ tipo: 'revendedor', telefono: telClean, nombre }, JWT_SECRET, { expiresIn: '7d' });
    res.setHeader('Set-Cookie', `reventa_token=${token}; HttpOnly; Path=/reventa; Max-Age=604800`);
    res.redirect('/reventa');
  } catch (err) {
    console.error('Error login reventa:', err.message);
    res.send(LOGIN_HTML.replace('{{ERROR}}', '<div class="err">Error del servidor. Intentá de nuevo.</div>'));
  }
});

router.get('/reventa/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'reventa_token=; HttpOnly; Path=/reventa; Max-Age=0');
  res.redirect('/reventa/login');
});

router.get('/reventa', reventaAuthMiddleware, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Precios Reventa — Neumáticos Gallo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #f5f5f5; color: #222; }
    .topbar { background: #1a1a2e; color: white; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
    .topbar .logo { font-size: 17px; font-weight: 700; }
    .topbar .logo span { color: #e63946; }
    .topbar .user { font-size: 13px; color: #aaa; }
    .topbar a { color: #e63946; text-decoration: none; font-size: 13px; margin-left: 16px; }
    .main { max-width: 700px; margin: 30px auto; padding: 0 16px; }
    .card { background: white; border-radius: 10px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.07); }
    h2 { font-size: 16px; color: #1a1a2e; margin-bottom: 16px; }
    .search-row { display: flex; gap: 10px; }
    input[type=text] { flex: 1; padding: 12px 14px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 15px; outline: none; }
    input[type=text]:focus { border-color: #e63946; }
    button.buscar { padding: 12px 22px; background: #e63946; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }
    .tip { font-size: 12px; color: #888; margin-top: 8px; }
    .resultado { margin-top: 6px; }
    .prod { border: 1px solid #eee; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
    .prod-desc { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .prod-precio { font-size: 22px; font-weight: 800; color: #e63946; }
    .prod-meta { font-size: 12px; color: #888; margin-top: 4px; }
    .stock-row { font-size: 12px; color: #555; margin-top: 6px; }
    .empty { text-align: center; color: #888; padding: 30px; font-size: 14px; }
    .dl-btn { display: inline-block; padding: 11px 20px; background: #1a1a2e; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; }
    .dl-btn:hover { background: #2a2a4e; }
    #loading { display: none; text-align: center; padding: 20px; color: #888; }
    .marca-tag { display: inline-block; background: #f0f0f0; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #555; margin-left: 8px; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="logo">Neumáticos <span>Gallo</span> — Reventa</div>
    <div>
      <span class="user">Hola, ${req.revendedor.nombre}</span>
      <a href="/reventa/logout">Salir</a>
    </div>
  </div>
  <div class="main">
    <div class="card">
      <h2>Buscar por medida</h2>
      <div class="search-row">
        <input type="text" id="medida" placeholder="Ej: 205/55R16" autocomplete="off">
        <button class="buscar" onclick="buscar()">Buscar</button>
      </div>
      <div class="tip">Ingresá la medida del neumático (ej: 185/65R15, 225/45R17)</div>
      <div id="loading">Buscando...</div>
      <div class="resultado" id="resultado"></div>
    </div>
    <div class="card">
      <h2>Lista de precios completa</h2>
      <p style="font-size:13px;color:#555;margin-bottom:14px">Descargá la lista completa con precios de reventa en Excel.</p>
      <a class="dl-btn" href="/reventa/lista">⬇️ Descargar lista Excel</a>
    </div>
  </div>
  <script>
    document.getElementById('medida').addEventListener('keydown', e => { if (e.key === 'Enter') buscar(); });
    async function buscar() {
      const medida = document.getElementById('medida').value.trim();
      if (!medida) return;
      document.getElementById('loading').style.display = 'block';
      document.getElementById('resultado').innerHTML = '';
      try {
        const r = await fetch('/reventa/buscar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ medida })
        });
        const data = await r.json();
        document.getElementById('loading').style.display = 'none';
        if (!data.productos || data.productos.length === 0) {
          document.getElementById('resultado').innerHTML = '<div class="empty">No se encontraron productos para esa medida.</div>';
          return;
        }
        let html = '';
        for (const p of data.productos) {
          const stockParts = [];
          if (p.stockVic > 0) stockParts.push('Victoria: ' + p.stockVic);
          if (p.stockNor > 0) stockParts.push('Nordelta: ' + p.stockNor);
          if (p.stockExpr > 0) stockParts.push('Express: ' + p.stockExpr);
          html += \`<div class="prod">
            <div class="prod-desc">\${p.descripcion}<span class="marca-tag">\${p.marca}</span></div>
            <div class="prod-precio">\${p.precioReventa}</div>
            <div class="prod-meta">Precio de lista: \${p.precioLista} · Descuento: \${p.descuento}%</div>
            \${stockParts.length ? '<div class="stock-row">Stock: ' + stockParts.join(' | ') + '</div>' : ''}
          </div>\`;
        }
        document.getElementById('resultado').innerHTML = html;
      } catch(e) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('resultado').innerHTML = '<div class="empty">Error al buscar. Intentá de nuevo.</div>';
      }
    }
  </script>
</body>
</html>`);
});

router.post('/reventa/buscar', express.json(), reventaAuthMiddleware, async (req, res) => {
  try {
    const { obtenerPrecios, normalizarMedida } = require('./index');
    const medida = req.body.medida || '';
    const norm = normalizarMedida(medida);
    if (!norm) return res.json({ productos: [] });

    const prods = await obtenerPrecios(norm, null, false, 1);
    const productos = prods.map(p => {
      const desc = descuentoRevendedor(p.marca);
      const precioRev = Math.round(p.precio * (1 - desc));
      return {
        descripcion: p.descripcion,
        marca: p.marca,
        precioLista: fmtPeso(p.precio),
        precioReventa: fmtPeso(precioRev),
        descuento: Math.round(desc * 100),
        stockVic: p.stockVic || 0,
        stockNor: p.stockNor || 0,
        stockExpr: p.stockExpr || 0,
      };
    });
    res.json({ productos });
  } catch (err) {
    console.error('Error buscar reventa:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reventa/lista', reventaAuthMiddleware, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Bot WhatsApp!A:J',
    });
    const rows = (result.data.values || []).slice(1);

    const data = [['Descripción', 'Marca', 'Precio Lista', 'Precio Reventa', 'Stock Victoria', 'Stock Nordelta', 'Stock Express']];
    for (const r of rows) {
      const desc  = r[2] || '';
      const marca = r[3] || '';
      const precio = parseFloat(r[9]) || 0;
      if (!precio) continue;
      const vic  = parseInt(r[6]) || 0;
      const nor  = parseInt(r[7]) || 0;
      const expr = parseInt(r[8]) || 0;
      const desc_pct = descuentoRevendedor(marca);
      const precioRev = Math.round(precio * (1 - desc_pct));
      data.push([desc, marca, precio, precioRev, vic, nor, expr]);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Precios Reventa');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fecha = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="precios-reventa-${fecha}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('Error lista reventa:', err.message);
    res.status(500).send('Error generando la lista');
  }
});

module.exports = router;
