const express = require('express');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');

let GOOGLE_CREDS;
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (GOOGLE_CREDS && GOOGLE_CREDS.private_key) {
    GOOGLE_CREDS.private_key = GOOGLE_CREDS.private_key.replace(/\\n/g, '\n');
  }
} catch(e) {}

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'neumaticos-gallo-2026';

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

function authMiddleware(req, res, next) {
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

router.get('/login', (req, res) => {
  res.send(LOGIN_HTML.replace('{{ERROR}}', ''));
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
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

router.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'reventa_token=; HttpOnly; Path=/reventa; Max-Age=0');
  res.redirect('/reventa/login');
});

router.get('/', authMiddleware, (req, res) => {
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
    .prod { border: 1.5px solid #eee; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color .15s; }
    .prod.selected { border-color: #e63946; background: #fff8f8; }
    .prod-header { display: flex; align-items: flex-start; gap: 10px; }
    .prod-check { width: 20px; height: 20px; accent-color: #e63946; flex-shrink: 0; margin-top: 2px; cursor: pointer; }
    .prod-desc { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
    .prod-precio { font-size: 22px; font-weight: 800; color: #e63946; }
    .prod-meta { font-size: 12px; color: #888; margin-top: 4px; }
    .stock-row { font-size: 12px; color: #555; margin-top: 6px; }
    .empty { text-align: center; color: #888; padding: 30px; font-size: 14px; }
    .dl-btn { display: inline-block; padding: 11px 20px; background: #1a1a2e; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600; }
    .dl-btn:hover { background: #2a2a4e; }
    #loading { display: none; text-align: center; padding: 20px; color: #888; }
    .marca-tag { display: inline-block; background: #f0f0f0; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #555; margin-left: 8px; }
    .copiar-bar { position: sticky; bottom: 16px; text-align: center; margin-top: 10px; }
    .copiar-btn { padding: 13px 28px; background: #e63946; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 16px rgba(230,57,70,0.35); }
    .copiar-btn:disabled { background: #ccc; box-shadow: none; cursor: default; }
    .copiado { background: #2a9d5c !important; }
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
      <div class="copiar-bar" id="copiarBar" style="display:none">
        <button class="copiar-btn" id="copiarBtn" onclick="copiarSeleccionados()">📋 Copiar seleccionados</button>
      </div>
    </div>
    <div class="card">
      <h2>Lista de precios completa</h2>
      <p style="font-size:13px;color:#555;margin-bottom:14px">Descargá la lista completa con precios de reventa en Excel.</p>
      <a class="dl-btn" href="/reventa/lista">⬇️ Descargar lista Excel</a>
    </div>
  </div>
  <script>
    let productosActuales = [];

    document.getElementById('medida').addEventListener('keydown', e => { if (e.key === 'Enter') buscar(); });

    async function buscar() {
      const medida = document.getElementById('medida').value.trim();
      if (!medida) return;
      document.getElementById('loading').style.display = 'block';
      document.getElementById('resultado').innerHTML = '';
      document.getElementById('copiarBar').style.display = 'none';
      productosActuales = [];
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
        productosActuales = data.productos;
        let html = '';
        data.productos.forEach((p, i) => {
          const stockParts = [];
          if (p.stockVic > 0) stockParts.push('Victoria: ' + p.stockVic);
          if (p.stockNor > 0) stockParts.push('Nordelta: ' + p.stockNor);
          if (p.stockExpr > 0) stockParts.push('Express (' + p.stockExpr + ')');
          const stockStr = stockParts.length ? stockParts.join(' | ') : 'Sin stock local';
          html += \`<div class="prod" id="prod-\${i}" onclick="toggleProd(\${i})">
            <div class="prod-header">
              <input type="checkbox" class="prod-check" id="chk-\${i}" onclick="event.stopPropagation();toggleProd(\${i})">
              <div style="flex:1">
                <div class="prod-desc">\${p.descripcion}<span class="marca-tag">\${p.marca}</span></div>
                <div class="prod-precio">\${p.precioReventa}</div>
                <div class="prod-meta">Precio de lista: \${p.precioLista} · Descuento: \${p.descuento}%</div>
                <div class="stock-row">Stock: \${stockStr}</div>
              </div>
            </div>
          </div>\`;
        });
        document.getElementById('resultado').innerHTML = html;
        document.getElementById('copiarBar').style.display = 'block';
      } catch(e) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('resultado').innerHTML = '<div class="empty">Error al buscar. Intentá de nuevo.</div>';
      }
    }

    function toggleProd(i) {
      const el = document.getElementById('prod-' + i);
      const chk = document.getElementById('chk-' + i);
      chk.checked = !chk.checked;
      el.classList.toggle('selected', chk.checked);
      const alguno = productosActuales.some((_, j) => document.getElementById('chk-' + j)?.checked);
      document.getElementById('copiarBtn').disabled = !alguno;
    }

    function copiarSeleccionados() {
      const medida = document.getElementById('medida').value.trim();
      const seleccionados = productosActuales.filter((_, i) => document.getElementById('chk-' + i)?.checked);
      if (!seleccionados.length) return;

      let texto = '🔴 *Neumáticos Gallo — Precios Reventa*\\n';
      if (medida) texto += '📐 Medida: ' + medida + '\\n';
      texto += '\\n';

      for (const p of seleccionados) {
        texto += '🔹 *' + p.descripcion + '*\\n';
        texto += '   💲 Precio reventa: ' + p.precioReventa + '\\n';
        const stockParts = [];
        if (p.stockVic > 0) stockParts.push('Victoria: ' + p.stockVic);
        if (p.stockNor > 0) stockParts.push('Nordelta: ' + p.stockNor);
        if (p.stockExpr > 0) stockParts.push('Express: ' + p.stockExpr + ' unid. (48-72 hs hábiles)');
        if (stockParts.length) texto += '   📦 Stock: ' + stockParts.join(' | ') + '\\n';
        texto += '\\n';
      }

      navigator.clipboard.writeText(texto).then(() => {
        const btn = document.getElementById('copiarBtn');
        btn.textContent = '✅ ¡Copiado!';
        btn.classList.add('copiado');
        setTimeout(() => {
          btn.textContent = '📋 Copiar seleccionados';
          btn.classList.remove('copiado');
        }, 2500);
      });
    }
  </script>
</body>
</html>`);
});

router.post('/buscar', express.json(), authMiddleware, async (req, res) => {
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

router.get('/lista', authMiddleware, async (req, res) => {
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
      const pct = descuentoRevendedor(marca);
      const precioRev = Math.round(precio * (1 - pct));
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
