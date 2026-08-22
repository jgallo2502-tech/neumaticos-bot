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
  { usuario: 'romina',     password: 'romina123', nombre: 'Romina',        rol: 'adm',       sucursal: null },
  { usuario: 'mara',       password: 'mara123',   nombre: 'Mara',          rol: 'adm',       sucursal: null },
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
  const token = jwt.sign({ usuario: user.usuario, nombre: user.nombre, rol: user.rol, sucursal: user.sucursal }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, nombre: user.nombre, rol: user.rol, sucursal: user.sucursal });
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
        const stockPropios = (depositos.victoria ? p.stockVic : 0) + (depositos.nordelta ? p.stockNor : 0);
        if (stockPropios >= minStock) return true;
        if (depositos.express  && p.stockExpr > 0) return true;
        return false;
      });
    }
    resultado[norm] = prods;
  }
  res.json(resultado);
});

// --- Buscar filtros (aceite/aire/combustible/habitáculo) por vehículo ---
router.get('/filtros', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    if (!q) return res.json([]);
    const palabras = q.split(/\s+/).filter(Boolean);

    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: GOOGLE_CREDS }
        : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Filtros!A:G',
    });
    const rows = (r.data.values || []).slice(1);

    const resultados = [];
    for (const row of rows) {
      const [codArt, descripcion, codAlternativo, stockVic, stockNor, , precio] = row;
      if (!descripcion || !precio) continue;
      const haystack = (descripcion + ' ' + (codAlternativo || '')).toLowerCase();
      if (!palabras.every(p => haystack.includes(p))) continue;

      const stockVictoria = parseInt(stockVic) || 0;
      const stockNordelta = parseInt(stockNor) || 0;
      resultados.push({
        codArt,
        descripcion,
        codAlternativo: codAlternativo || '',
        precio: parseInt(precio) || 0,
        stockVictoria,
        stockNordelta,
        stockPropio: stockVictoria + stockNordelta,
      });
    }

    resultados.sort((a, b) => b.stockPropio - a.stockPropio);
    res.json(resultados);
  } catch (err) {
    console.error('Error buscando filtros:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Catálogo Fram: marcas/modelos/versiones/búsqueda por vehículo ---
const FRAM_MARCAS = ['ACURA','AGRALE','ALFA ROMEO','ASIA MOTORS','AUDI','BAIC','BMW','CATERPILLAR','CHERY',
  'CHEVROLET','CHRYSLER','CITROEN','DACIA','DAEWOO','DAIHATSU','DEUTZ AGRALE','DFM','DFSK','DIMEX','DODGE',
  'DS','EL DETALLE','FIAT','FORD','GEELY','GMC CHEVETTE','HAVAL','HONDA','HUMMER','HYUNDAI','IKA',
  'INTERNATIONAL','ISUZU','IVECO','JAC','JAGUAR','JEEP','JMC','KIA','LADA','LAND ROVER','LEXUS','LIFAN',
  'MARUTI','MAZDA','MERCEDES BENZ','MG','MINI','MITSUBISHI','NISSAN','OPEL','PEUGEOT','PORSCHE',
  'PUMA DE TAT','RAM','RENAULT','ROVER','SAAB','SCANIA','SEAT','SHINERAY','SMART','SSANGYONG','SUBARU',
  'SUZUKI','TOYOTA','VOLKSWAGEN','VOLVO'];

router.get('/fram/marcas', authMiddleware, (req, res) => {
  res.json(FRAM_MARCAS);
});

router.get('/fram/modelos', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString();
    const r = await fetch('https://catalogofram.com.ar/json/vehicle/model/?brand_id=' + encodeURIComponent(marca));
    const data = await r.json();
    res.json((data.result || []).map(x => x.model_master));
  } catch (err) {
    console.error('Error fram/modelos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const decodeEntitiesFram = s => s.replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// Fram exige una cookie de sesión + un token CSRF para /resultado. El token que pide
// como query param "_token" es el mismo valor que manda en la cookie XSRF-TOKEN.
async function framIniciarSesion() {
  const rSesion = await fetch('https://catalogofram.com.ar/buscar/vehiculo');
  const setCookies = [...rSesion.headers].filter(h => h[0].toLowerCase() === 'set-cookie').map(h => h[1]);
  const cookieMap = {};
  for (const c of setCookies) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookieMap[k] = v; }
  const xsrf = cookieMap['XSRF-TOKEN'] ? decodeURIComponent(cookieMap['XSRF-TOKEN']) : '';
  const cookieHeader = Object.entries(cookieMap).map(([k, v]) => k + '=' + v).join('; ');
  if (!xsrf) throw new Error('No se pudo iniciar sesión con catalogofram.com.ar');
  return { xsrf, cookieHeader };
}

async function framFetchResultado({ marca, modelo, version }) {
  const { xsrf, cookieHeader } = await framIniciarSesion();
  const params = { _token: xsrf, brand_id: marca, model_id: modelo, tipo: 'vehiculo_sidebar' };
  if (version) params.version_id = version;
  const url = 'https://catalogofram.com.ar/resultado?' + new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { Cookie: cookieHeader } });
  const html = await r.text();
  // Quitar TODOS los comentarios HTML: el template de Fram trae un result-item de
  // ejemplo comentado (además de comentarios sueltos normales en el <head>) que
  // contamina el parseo si no se descarta.
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

router.get('/fram/versiones', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString();
    const modelo = (req.query.modelo || '').toString();
    // El endpoint real de Fram tiene "version}" en la ruta (bug de su template, pero funciona)
    const url = 'https://catalogofram.com.ar/json/vehicle/version%7D/?brand_id=' + encodeURIComponent(marca) + '&model_id=' + encodeURIComponent(modelo);
    const r = await fetch(url);
    const data = await r.json();
    const versiones = data.result || [];

    // Fram no da el rango de años en este endpoint. Traemos una vez la lista sin
    // versión (más liviana que consultar cada versión una por una) y le pegamos el
    // rango a las que tengan una coincidencia única y sin ambigüedad; si una versión
    // tiene varios rangos posibles (distintas carrocerías) no se le agrega nada para
    // no mostrar un año que podría ser incorrecto.
    try {
      const zona = await framFetchResultado({ marca, modelo });
      const carModels = [...zona.matchAll(/<div class="car-model">([^<]+)<\/div>/g)].map(m => decodeEntitiesFram(m[1]));
      for (const v of versiones) {
        const rangos = new Set();
        for (const cm of carModels) {
          if (!cm.toUpperCase().includes(v.version.toUpperCase())) continue;
          const rangoMatch = cm.match(/(\d{4}\s+a\s+\d{4})\s*$/);
          if (rangoMatch) rangos.add(rangoMatch[1]);
        }
        if (rangos.size === 1) v.anios = [...rangos][0];
      }
    } catch (e) {
      // Si falla el enriquecimiento, se devuelven las versiones igual, sin años.
      console.error('Error enriqueciendo años fram/versiones:', e.message);
    }

    res.json(versiones);
  } catch (err) {
    console.error('Error fram/versiones:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Consulta catalogofram.com.ar/resultado para un vehículo exacto y devuelve {vehiculo, items:[{codigo,categoria}]}
async function framObtenerCodigosPorVehiculo(marca, modelo, version) {
  const zona = await framFetchResultado({ marca, modelo, version });

  const vehiculoMatch = zona.match(/<div class="car-model">([^<]+)<\/div>/);
  const vehiculo = vehiculoMatch ? decodeEntitiesFram(vehiculoMatch[1].trim()) : '';

  const items = [];
  const re = /<div class="code">([^<]+)<\/div>\s*<div class="category">([^<]+)<\/div>/g;
  let m;
  while ((m = re.exec(zona))) {
    items.push({ codigo: m[1].trim(), categoria: decodeEntitiesFram(m[2].trim()) });
  }
  return { vehiculo, items };
}

router.get('/fram/buscar', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString();
    const modelo = (req.query.modelo || '').toString();
    const version = (req.query.version || '').toString();
    if (!marca || !modelo || !version) return res.status(400).json({ error: 'Faltan marca/modelo/version' });

    const { vehiculo, items } = await framObtenerCodigosPorVehiculo(marca, modelo, version);
    if (items.length === 0) return res.json({ vehiculo, items: [] });

    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: GOOGLE_CREDS }
        : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Filtros!A:G',
    });
    const filas = (r.data.values || []).slice(1);
    const filaAStock = row => {
      const stockVictoria = parseInt(row[3]) || 0;
      const stockNordelta = parseInt(row[4]) || 0;
      return {
        codArt: row[0],
        descripcion: row[1],
        codAlternativo: row[2] || '',
        precio: parseInt(row[6]) || 0,
        stockVictoria,
        stockNordelta,
        stockPropio: stockVictoria + stockNordelta,
      };
    };

    // Entre las filas que matchean, preferir la que tenga stock real en Victoria/Nordelta
    const mejorMatch = filasMatch => filasMatch.reduce((mejor, row) => {
      const s = filaAStock(row);
      if (!mejor || s.stockPropio > mejor.stockPropio) return s;
      return mejor;
    }, null);

    // Palabra clave por tipo de filtro, para el fallback por marca+modelo (ej: encontrar el
    // equivalente Wix aunque el código Fram exacto no esté cargado en el stock)
    const categoriaAKeywords = categoria => {
      const c = categoria.toUpperCase();
      if (c.includes('ACEITE')) return ['ACEITE'];
      if (c.includes('HABIT') || c.includes('CABINA')) return ['HABIT', 'CABINA'];
      if (c.includes('COMBUSTIBLE')) return ['COMB'];
      if (c.includes('AIRE')) return ['AIRE'];
      return [];
    };
    const cilindradaMatch = version.match(/(\d)[.,](\d)/);
    const cilindrada = cilindradaMatch ? cilindradaMatch[1] + cilindradaMatch[2] : null; // ej "28" para 2.8

    const resultado = items.map(it => {
      const codigoUpper = it.codigo.toUpperCase();
      const porCodigo = filas.filter(row => {
        const desc = (row[1] || '').toUpperCase();
        const codAlt = (row[2] || '').toUpperCase();
        return desc.includes(codigoUpper) || codAlt.includes(codigoUpper);
      });
      let stock = mejorMatch(porCodigo);

      if (!stock || stock.stockPropio === 0) {
        // Fallback: buscar por marca + modelo + tipo de filtro (pesca el equivalente Wix
        // aunque no tenga cargado el código exacto que dio Fram)
        const keywords = categoriaAKeywords(it.categoria);
        if (keywords.length > 0) {
          const marcaUpper = marca.toUpperCase();
          const modeloUpper = modelo.toUpperCase();
          const porTexto = filas.filter(row => {
            const desc = (row[1] || '').toUpperCase();
            if (!desc.includes(marcaUpper) && !desc.includes(modeloUpper)) return false;
            if (!desc.includes(modeloUpper)) return false;
            if (!keywords.some(k => desc.includes(k))) return false;
            return true;
          });
          // Si hay pistas de cilindrada, priorizar filas que la mencionen
          const conCilindrada = cilindrada
            ? porTexto.filter(row => (row[1] || '').replace(/[.,]/g, '').includes(cilindrada))
            : [];
          const candidatos = conCilindrada.length > 0 ? conCilindrada : porTexto;
          const fallback = mejorMatch(candidatos);
          if (fallback && (!stock || fallback.stockPropio > stock.stockPropio)) stock = fallback;
        }
      }

      return { ...it, stock: stock || null };
    });

    // A veces Fram lista 2 códigos distintos (ej: combustible primario + secundario) que
    // resuelven al mismo producto en el stock. Fusionarlos para no duplicar el precio.
    const porCodArt = new Map();
    const sinStock = [];
    for (const it of resultado) {
      if (!it.stock) { sinStock.push(it); continue; }
      const existente = porCodArt.get(it.stock.codArt);
      if (existente) {
        if (!existente.categoria.includes(it.categoria)) existente.categoria += ' / ' + it.categoria;
        if (!existente.codigo.includes(it.codigo)) existente.codigo += ' / ' + it.codigo;
      } else {
        porCodArt.set(it.stock.codArt, { ...it });
      }
    }
    const resultadoFinal = [...porCodArt.values(), ...sinStock];

    res.json({ vehiculo, items: resultadoFinal });
  } catch (err) {
    console.error('Error fram/buscar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Catálogo Moura: marcas/modelos/búsqueda de batería por vehículo ---
// API pública de "Moura Ya" (moura-search-argentina.herokuapp.com). El mapeo
// vehículo -> batería no depende de la ciudad (sólo el precio/stats sí), así que
// se consulta una vez con una ciudad fija y se cachea en memoria.
const MOURA_CIUDAD_ID = '64e8f7d652c3ce0002405679'; // Gran Buenos Aires
let mouraCache = { data: null, ts: 0 };

async function mouraObtenerDataset() {
  const ahora = Date.now();
  if (mouraCache.data && ahora - mouraCache.ts < 12 * 60 * 60 * 1000) return mouraCache.data;
  const url = 'https://moura-search-argentina.herokuapp.com/api/v1/topcarro?' + new URLSearchParams({
    cidade: MOURA_CIUDAD_ID, limit: '10000', offset: '0', vehicleType: 'CARRO,CAMINHAO',
    from: '2015-01-01', to: '2026-12-31',
  }).toString();
  const r = await fetch(url);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('Respuesta inesperada de Moura');
  mouraCache = { data, ts: ahora };
  return data;
}

router.get('/moura/marcas', authMiddleware, async (req, res) => {
  try {
    const data = await mouraObtenerDataset();
    const marcas = [...new Set(data.map(v => v.car_brand).filter(Boolean))].sort();
    res.json(marcas);
  } catch (err) {
    console.error('Error moura/marcas:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/moura/modelos', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString();
    const data = await mouraObtenerDataset();
    const vistos = new Set();
    const modelos = [];
    for (const v of data) {
      if (v.car_brand !== marca) continue;
      if (vistos.has(v.id)) continue;
      vistos.add(v.id);
      modelos.push({
        id: v.id,
        modelo: v.car_model,
        anioDesde: v.car_year_from,
        anioHasta: v.car_year_to,
        battery: v.battery || '',
        batteryAlt: v.battery_alt || '',
      });
    }
    modelos.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.anioDesde - b.anioDesde);
    res.json(modelos);
  } catch (err) {
    console.error('Error moura/modelos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/moura/buscar', authMiddleware, async (req, res) => {
  try {
    const vehiculo = (req.query.vehiculo || '').toString();
    const battery = (req.query.battery || '').toString().toUpperCase();
    const batteryAlt = (req.query.batteryAlt || '').toString().toUpperCase();
    if (!battery) return res.status(400).json({ error: 'Falta el código de batería' });

    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: GOOGLE_CREDS }
        : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Baterias!A:G',
    });
    const filas = (r.data.values || []).slice(1);

    const filaAStock = row => {
      const stockVictoria = parseInt(row[3]) || 0;
      const stockNordelta = parseInt(row[4]) || 0;
      return {
        codArt: row[0], descripcion: row[1], codAlternativo: row[2] || '',
        precio: parseInt(row[6]) || 0, stockVictoria, stockNordelta,
        stockPropio: stockVictoria + stockNordelta,
      };
    };
    const buscarCodigo = codigo => {
      if (!codigo) return null;
      const matches = filas.filter(row => {
        const desc = (row[1] || '').toUpperCase();
        const codAlt = (row[2] || '').toUpperCase();
        return codAlt === codigo || desc.includes(codigo);
      });
      return matches.reduce((mejor, row) => {
        const s = filaAStock(row);
        if (!mejor || s.stockPropio > mejor.stockPropio) return s;
        return mejor;
      }, null);
    };

    let stock = buscarCodigo(battery);
    let codigoUsado = battery;
    if ((!stock || stock.stockPropio === 0) && batteryAlt) {
      const stockAlt = buscarCodigo(batteryAlt);
      if (stockAlt && (!stock || stockAlt.stockPropio > stock.stockPropio)) {
        stock = stockAlt;
        codigoUsado = batteryAlt;
      }
    }

    res.json({ vehiculo, battery, batteryAlt, codigoUsado, stock: stock || null });
  } catch (err) {
    console.error('Error moura/buscar:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Catálogo Auto Experts (Fras-le): pastillas de freno por vehículo ---
// API pública de autoexperts.parts (Frasle Mobility). Requiere el header
// "x-region" (no es un campo del body) y devuelve, por cada producto, el
// array completo de vehículos donde aplica (marca/nombre/motor/año desde-hasta).
const AUTOEXPERTS_API = 'https://api.autoexperts.parts/autexp/bff/v1/catalog/products';
const AUTOEXPERTS_PASTILLA_FRENO_ID = 'c33fa8a0-ea3d-489e-9657-b1271e67d6c9';
const AUTOEXPERTS_FRASLE_BRAND_ID = '817d687b-ff60-4266-bf84-8045a33ae67f';

router.get('/frasle/marcas', authMiddleware, (req, res) => {
  res.json(FRAM_MARCAS);
});

async function autoexpertsBuscarProductos(body) {
  const r = await fetch(AUTOEXPERTS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-region': 'ar' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('autoexperts.parts respondió ' + r.status);
  return r.json();
}

// Trae TODAS las páginas (la API limita "take" a 50 por página) para un filtro de vehículo dado
async function autoexpertsBuscarTodosLosProductos(vehiclesFiltro) {
  let productos = [];
  let skip = 0;
  for (let pagina = 0; pagina < 5; pagina++) {
    const data = await autoexpertsBuscarProductos({
      productGroups: [AUTOEXPERTS_PASTILLA_FRENO_ID],
      brands: [AUTOEXPERTS_FRASLE_BRAND_ID],
      vehicles: vehiclesFiltro,
      skip,
    });
    productos = productos.concat(data.data || []);
    if (!data.total || productos.length >= data.total) break;
    skip += (data.data || []).length || 50;
  }
  return productos;
}

// Caché de modelos por marca: no hay un endpoint de "listar modelos", así que se arma
// trayendo todos los productos de la marca y sacando los nombres únicos de vehicles[].
let frasleModelosCache = {};

async function frasleObtenerModelos(marca) {
  const ahora = Date.now();
  const cache = frasleModelosCache[marca];
  if (cache && ahora - cache.ts < 12 * 60 * 60 * 1000) return cache.data;

  const productos = await autoexpertsBuscarTodosLosProductos({ brands: marca });
  const modelos = new Set();
  for (const p of productos) {
    for (const v of (p.vehicles || [])) {
      if (v.brand === marca && v.name) modelos.add(v.name);
    }
  }
  const lista = [...modelos].sort();
  frasleModelosCache[marca] = { data: lista, ts: ahora };
  return lista;
}

router.get('/frasle/modelos', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString().trim().toUpperCase();
    if (!marca) return res.json([]);
    const modelos = await frasleObtenerModelos(marca);
    res.json(modelos);
  } catch (err) {
    console.error('Error frasle/modelos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/frasle/buscar', authMiddleware, async (req, res) => {
  try {
    const marca = (req.query.marca || '').toString().trim().toUpperCase();
    const modelo = (req.query.modelo || '').toString().trim().toUpperCase();
    if (!marca || !modelo) return res.status(400).json({ error: 'Faltan marca/modelo' });

    const productos = await autoexpertsBuscarTodosLosProductos({ brands: marca, names: modelo });

    // Extraer, por cada producto que aplica a esta marca+modelo, la versión/motor y el rango de años
    const versiones = new Map();
    for (const p of productos) {
      for (const v of (p.vehicles || [])) {
        if (v.brand !== marca || v.name !== modelo) continue;
        const key = [v.model, v.startYear, v.endYear, p.partNumber].join('|');
        if (versiones.has(key)) continue;
        versiones.set(key, {
          version: v.model || '', anioDesde: v.startYear, anioHasta: v.endYear,
          partNumber: p.partNumber, descripcion: p.applicationDescription,
        });
      }
    }
    const lista = [...versiones.values()].sort((a, b) =>
      (a.version || '').localeCompare(b.version || '') || (a.anioDesde || 0) - (b.anioDesde || 0));

    if (lista.length === 0) return res.json([]);

    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS
        ? { credentials: GOOGLE_CREDS }
        : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Frasle!A:G',
    });
    const filas = (r.data.values || []).slice(1);

    const filaAStock = row => {
      const stockVictoria = parseInt(row[3]) || 0;
      const stockNordelta = parseInt(row[4]) || 0;
      return {
        codArt: row[0], descripcion: row[1], codAlternativo: row[2] || '',
        precio: parseInt(row[6]) || 0, stockVictoria, stockNordelta,
        stockPropio: stockVictoria + stockNordelta,
      };
    };
    const buscarCodigo = partNumber => {
      const codigo = partNumber.toUpperCase();
      const codigoBase = codigo.split('-')[0]; // ej "PD/1699-CMAXX" -> "PD/1699"
      const matches = filas.filter(row => {
        const desc = (row[1] || '').toUpperCase();
        const codAlt = (row[2] || '').toUpperCase();
        return codAlt === codigo || codAlt === codigoBase || desc.includes(codigo) || desc.includes(codigoBase);
      });
      return matches.reduce((mejor, row) => {
        const s = filaAStock(row);
        if (!mejor || s.stockPropio > mejor.stockPropio) return s;
        return mejor;
      }, null);
    };

    const resultado = lista.map(v => ({ ...v, stock: buscarCodigo(v.partNumber) }));
    res.json(resultado);
  } catch (err) {
    console.error('Error frasle/buscar:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// --- Clientes de campaña del vendedor (proxy hacia Gallo app) ---
router.get('/campana/vendedor', authMiddleware, async (req, res) => {
  try {
    const usuario  = req.user.usuario; // ej: "nruiz"
    const semanas  = req.query.semanas || '25';
    const galloUrl = process.env.GALLO_API_URL || 'https://web-production-f7777.up.railway.app';
    const apiKey   = process.env.CAMPANA_API_KEY || 'gallo-campana-2026';
    const params   = new URLSearchParams({ usuario, semanas, neu_min: '2', balanceo: '1', alineacion: '1' });
    const r = await fetch(`${galloUrl}/api/campana/por-vendedor?${params}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    if (!r.ok) { return res.status(r.status).json({ error: 'Error en Gallo API' }); }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('Error campana/vendedor:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Guardar presupuesto en Google Sheets ---
router.post('/guardar-presupuesto', express.json(), authMiddleware, async (req, res) => {
  try {
    const { cliente, tel, num, fecha, items, servicios } = req.body;
    const vendedor = req.user.nombre;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    // Si no hay neumáticos (presupuesto solo de servicios/filtros), usar el resumen como descripción
    const productos = items.length > 0
      ? items.map(i => i.descripcion).join(' | ')
      : (servicios && servicios.resumen ? servicios.resumen : '');
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
  } else if (productos) {
    productosHtml = productos.split(' | ').map(p => `<div style="padding:8px 0;border-bottom:1px solid #eee">${p}</div>`).join('');
  }

  let tablaUnitarios = '';
  let tablaResumen = '';
  if (datos && datos.items && datos.items.length > 0) {
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
  }

  if (datos && datos.servicios && Array.isArray(datos.servicios.filtros) && datos.servicios.filtros.length > 0) {
    const s = datos.servicios;
    let filas = '';
    if (s.vehiculo) filas += `<tr><td colspan="2" style="padding:0 0 10px;font-weight:700;font-size:14px;color:#1a1a2e">${s.vehiculo}</td></tr>`;
    for (const f of s.filtros) {
      filas += `<tr><td style="padding:8px 0;border-bottom:1px solid #dbe7f5">${f.descripcion}</td><td style="padding:8px 0;border-bottom:1px solid #dbe7f5;text-align:right;white-space:nowrap">${fmt(f.precio)}</td></tr>`;
    }
    if (s.manoDeObra > 0) {
      filas += `<tr><td style="padding:8px 0;border-bottom:1px solid #dbe7f5">Mano de obra</td><td style="padding:8px 0;border-bottom:1px solid #dbe7f5;text-align:right;white-space:nowrap">${fmt(s.manoDeObra)}</td></tr>`;
    }
    filas += `<tr><td style="padding:10px 0 0;font-weight:700;font-size:15px">Total aprox.</td><td style="padding:10px 0 0;font-weight:700;font-size:15px;text-align:right;color:#e63946;white-space:nowrap">${fmt(s.total)}</td></tr>`;
    tablaResumen += `<div style="background:#f0f7ff;padding:14px 16px;border-radius:8px;margin-top:8px">
      🔧 <strong>${s.titulo || 'Cambio de aceite y filtros'}</strong>
      <table style="width:100%;border-collapse:collapse;margin-top:8px">${filas}</table>
    </div>`;
  } else if (datos && datos.servicios && datos.servicios.resumen) {
    tablaResumen += `<div style="background:#f0f7ff;padding:12px;border-radius:8px;font-size:13px;margin-top:8px">🔧 <strong>Servicios:</strong> ${datos.servicios.resumen}</div>`;
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
// ÓRDENES DE SERVICIO
// ============================================================

function googleAuth(scopes) {
  return new google.auth.GoogleAuth({
    ...(process.env.GOOGLE_CREDENTIALS ? { credentials: GOOGLE_CREDS } : { keyFile: require('path').join(__dirname, 'credentials.json') }),
    scopes,
  });
}

// Generar número de OS: OS-YYYYMM-NNN
async function generarNumeroOS(sheets) {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const prefix = `OS-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}-`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Ordenes!A:A' });
  const nums = (res.data.values || []).map(r => r[0] || '').filter(n => n.startsWith(prefix)).map(n => parseInt(n.replace(prefix,''))||0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return prefix + String(next).padStart(3,'0');
}

// Traer items de un presupuesto por token
router.get('/orden/presupuesto', authMiddleware, async (req, res) => {
  const ptoken = (req.query.token || '').trim();
  if (!ptoken) return res.json({ ok: false });
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Presupuestos!A:J' });
    const fila = (r.data.values || []).slice(1).find(row => (row[8]||'') === ptoken);
    if (!fila) return res.json({ ok: false });
    let datos = null;
    try { datos = JSON.parse(fila[9] || 'null'); } catch(e) {}
    res.json({ ok: true, datos, numero: fila[1], cliente: fila[3], tel: fila[4], total: fila[6] });
  } catch(e) { res.json({ ok: false }); }
});

// Buscar cliente por DNI/CUIT
router.get('/orden/cliente', authMiddleware, async (req, res) => {
  const doc = (req.query.doc || '').replace(/\D/g,'');
  if (!doc) return res.json({ encontrado: false });
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Clientes!A:H' });
    const fila = (r.data.values || []).find(row => (row[0]||'').replace(/\D/g,'') === doc);
    if (!fila) return res.json({ encontrado: false });
    res.json({ encontrado: true, doc: fila[0], nombre: fila[1], apellido: fila[2], direccion: fila[3], localidad: fila[4], provincia: fila[5], tel: fila[6], mail: fila[7] });
  } catch(e) { res.json({ encontrado: false }); }
});

// Consulta AFIP por CUIT
router.get('/orden/afip', authMiddleware, async (req, res) => {
  const cuit = (req.query.cuit || '').replace(/\D/g,'');
  if (!cuit || cuit.length !== 11) return res.json({});
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const r = await fetch(`https://afip.tangofactura.com/Rest/GetContribuyenteFull?cuit=${cuit}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    const c = d.Contribuyente || d.contribuyente || {};
    const domicilio = c.domicilioFiscal || c.DomicilioFiscal || {};
    res.json({
      razonSocial: c.razonSocial || c.RazonSocial || '',
      domicilio: [domicilio.direccion || domicilio.Direccion, domicilio.localidad || domicilio.Localidad].filter(Boolean).join(', '),
      localidad: domicilio.localidad || domicilio.Localidad || '',
      provincia: domicilio.descripcionProvincia || domicilio.DescripcionProvincia || '',
    });
  } catch(e) { res.json({}); }
});

// Buscar vehículo por patente
router.get('/orden/vehiculo', authMiddleware, async (req, res) => {
  const patente = (req.query.patente || '').toUpperCase().replace(/\s/g,'');
  if (!patente) return res.json({ encontrado: false });
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Vehiculos!A:E' });
    const fila = (r.data.values || []).find(row => (row[0]||'').toUpperCase() === patente);
    if (!fila) return res.json({ encontrado: false });
    res.json({ encontrado: true, patente: fila[0], doc: fila[1], marca: fila[2], modelo: fila[3], anio: fila[4] });
  } catch(e) { res.json({ encontrado: false }); }
});

// Guardar orden
router.post('/orden/guardar', express.json(), authMiddleware, async (req, res) => {
  try {
    const { doc, nombre, apellido, tel, mail, direccion, localidad, provincia,
            patente, marcaVeh, modeloVeh, anio, km, trabajos,
            total, formaPago, observaciones, pToken, pNumero } = req.body;
    const vendedor = req.user.nombre;
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const fecha = `${now.getDate()}/${now.getMonth()+1}/${now.getFullYear()}`;
    const clienteNombre = [nombre, apellido].filter(Boolean).join(' ');

    const auth = googleAuth(['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });
    const numero = await generarNumeroOS(sheets);

    // Guardar/actualizar cliente
    if (doc) {
      const rc = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Clientes!A:A' });
      const docs = (rc.data.values || []).map(r => (r[0]||'').replace(/\D/g,''));
      const idx = docs.indexOf(doc.replace(/\D/g,''));
      if (idx === -1) {
        await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Clientes!A:H', valueInputOption: 'RAW',
          requestBody: { values: [[doc, nombre, apellido, direccion, localidad, provincia, tel, mail]] } });
      } else {
        const fila = idx + 1;
        await sheets.spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `Clientes!A${fila}:H${fila}`, valueInputOption: 'RAW',
          requestBody: { values: [[doc, nombre, apellido, direccion, localidad, provincia, tel, mail]] } });
      }
    }

    // Guardar/actualizar vehículo
    if (patente) {
      const rv = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Vehiculos!A:A' });
      const pats = (rv.data.values || []).map(r => (r[0]||'').toUpperCase());
      const idx = pats.indexOf(patente.toUpperCase());
      if (idx === -1) {
        await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Vehiculos!A:E', valueInputOption: 'RAW',
          requestBody: { values: [[patente, doc||'', marcaVeh, modeloVeh, anio||'']] } });
      } else {
        const fila = idx + 1;
        await sheets.spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `Vehiculos!A${fila}:E${fila}`, valueInputOption: 'RAW',
          requestBody: { values: [[patente, doc||'', marcaVeh, modeloVeh, anio||'']] } });
      }
    }

    // Calcular total desde items si no se pasó
    const totalFinal = parseInt(total) || trabajos.reduce((s, t) => s + (t.precio || 0), 0) || 0;

    // Guardar orden — A=Numero B=Fecha C=Vendedor D=PToken E=PNumero F=Doc G=ClienteNombre H=Tel I=Mail J=Direccion K=Localidad L=Provincia M=Patente N=MarcaVeh O=ModeloVeh P=Anio Q=KM R=Trabajos S=Total T=FormaPago U=Observaciones V=Estado
    await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Ordenes!A:V', valueInputOption: 'RAW',
      requestBody: { values: [[numero, fecha, vendedor, pToken||'', pNumero||'', doc||'', clienteNombre, tel||'', mail||'', direccion||'', localidad||'', provincia||'', patente||'', marcaVeh||'', modeloVeh||'', anio||'', km||'', JSON.stringify(trabajos), totalFinal, formaPago||'', observaciones||'', 'Ingresada']] } });

    res.json({ ok: true, id: numero });
  } catch(e) {
    console.error('Error guardar orden:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Ver orden
router.get('/orden/ver', authMiddleware, async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) return res.json({ ok: false });
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Ordenes!A:V' });
    const fila = (r.data.values || []).find(row => row[0] === id);
    if (!fila) return res.json({ ok: false });
    let trabajos = [];
    try { trabajos = JSON.parse(fila[17] || '[]'); } catch(e) { trabajos = [fila[17]]; }
    res.json({ ok: true, orden: {
      numero: fila[0], fecha: fila[1], vendedor: fila[2], presupuestoToken: fila[3], presupuestoNum: fila[4],
      doc: fila[5], clienteNombre: fila[6], tel: fila[7], mail: fila[8],
      direccion: fila[9], localidad: fila[10], provincia: fila[11],
      patente: fila[12], marcaVeh: fila[13], modeloVeh: fila[14], anio: fila[15], km: fila[16],
      trabajos, total: fila[18], formaPago: fila[19], observaciones: fila[20], estado: fila[21] || 'Ingresada'
    }});
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Actualizar estado de orden
router.post('/orden/estado', express.json(), authMiddleware, async (req, res) => {
  const { id, estado } = req.body;
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Ordenes!A:A' });
    const idx = (r.data.values || []).findIndex(row => row[0] === id);
    if (idx === -1) return res.json({ ok: false });
    await sheets.spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: `Ordenes!V${idx+1}`, valueInputOption: 'RAW', requestBody: { values: [[estado]] } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Listar órdenes
router.get('/ordenes/listar', authMiddleware, async (req, res) => {
  try {
    const sheets = google.sheets({ version: 'v4', auth: googleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Ordenes!A:V' });
    const rows = (r.data.values || []);
    const esAdmin = req.user.rol === 'admin';
    const vendedor = req.user.nombre;
    const ordenes = rows
      .filter(row => row[0] && (esAdmin || row[2] === vendedor))
      .map(row => ({
        numero: row[0], fecha: row[1], vendedor: row[2],
        doc: row[5], clienteNombre: row[6], tel: row[7],
        patente: row[12], marcaVeh: row[13], modeloVeh: row[14], anio: row[15],
        total: row[18], formaPago: row[19], estado: row[21] || 'Ingresada'
      }))
      .reverse();
    res.json({ ordenes });
  } catch(e) { res.status(500).json({ ordenes: [] }); }
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

// ─── OFICINA ADM. ────────────────────────────────────────────────────────────

// Traer todos los presupuestos para reconciliación ARCA
router.get('/oficina/presupuestos', authMiddleware, async (req, res) => {
  if (!['admin', 'adm'].includes(req.user.rol)) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:J',
    });
    const rows = (result.data.values || []).slice(1).filter(r => r[1]);
    const presupuestos = rows.map(r => ({
      fecha:    r[0] || '',
      numero:   r[1] || '',
      vendedor: r[2] || '',
      cliente:  r[3] || '',
      tel:      r[4] || '',
      productos:r[5] || '',
      total:    parseFloat((r[6]||'0').replace(/[^0-9.-]/g,'')) || 0,
      estado:   r[7] || '',
      token:    r[8] || '',
    }));
    res.json({ ok: true, presupuestos });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── OFICINA: PERSISTENCIA DE DATOS ──────────────────────────────────────────
// Hoja OficinaDatos: A=tipo B=periodo C=fecha D=tipo_comp E=puntoNum F=denom G=cuit H=neto I=iva J=total

async function ensureOficinaDatosSheet(sheets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === 'OficinaDatos');
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'OficinaDatos' } } }] }
      });
    }
  } catch(e) { console.error('ensureOficinaDatosSheet:', e.message); }
}

async function getOficinaDatos(sheets) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'OficinaDatos!A:J',
    });
    return r.data.values || [];
  } catch(e) { return []; }
}

// Guardar (reemplaza ese tipo+periodo)
router.post('/oficina/datos/guardar', express.json({ limit: '10mb' }), authMiddleware, async (req, res) => {
  if (!['admin','adm'].includes(req.user.rol)) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const { tipo, periodo, rows } = req.body;
    if (!tipo || !periodo || !rows) return res.json({ ok: false, error: 'Datos incompletos' });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    await ensureOficinaDatosSheet(sheets);
    const existing = await getOficinaDatos(sheets);
    const header = ['tipo','periodo','fecha','tipo_comp','puntoNum','denom','cuit','neto','iva','total'];
    // Conservar filas de otros tipo+periodo, reemplazar este
    const keep = existing.filter(r => !(r[0] === tipo && r[1] === periodo) && r[0] !== 'tipo');
    const newRows = rows.map(r => [
      tipo, periodo,
      r.fecha||'', r.tipo_comp||r.tipo||'', r.puntoNum||'',
      r.denom||r.proveedor||r.cliente||'', r.cuit||'',
      r.neto||0, r.iva||0, r.total||0
    ]);
    const allRows = [header, ...keep, ...newRows];

    await sheets.spreadsheets.values.clear({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'OficinaDatos!A:J' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'OficinaDatos!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: allRows },
    });
    res.json({ ok: true, guardados: newRows.length });
  } catch(err) {
    console.error('Error oficina/datos/guardar:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Listar períodos disponibles por tipo
router.get('/oficina/periodos', authMiddleware, async (req, res) => {
  if (!['admin','adm'].includes(req.user.rol)) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const existing = await getOficinaDatos(sheets);
    const periodos = { rec: new Set(), emi: new Set(), gal: new Set() };
    existing.filter(r=>r[0]!=='tipo').forEach(r=>{ if(periodos[r[0]]) periodos[r[0]].add(r[1]); });
    res.json({ ok: true, periodos: {
      rec: [...periodos.rec].sort().reverse(),
      emi: [...periodos.emi].sort().reverse(),
      gal: [...periodos.gal].sort().reverse(),
    }});
  } catch(err) {
    res.json({ ok: true, periodos: { rec:[], emi:[], gal:[] } });
  }
});

// Obtener datos de un tipo+periodo
router.get('/oficina/datos', authMiddleware, async (req, res) => {
  if (!['admin','adm'].includes(req.user.rol)) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const { tipo, periodo } = req.query;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const existing = await getOficinaDatos(sheets);
    const filtered = existing
      .filter(r => r[0] !== 'tipo' && (!tipo||r[0]===tipo) && (!periodo||r[1]===periodo))
      .map(r => ({
        tipo_origen:r[0], periodo:r[1],
        fecha:r[2], tipo_comp:r[3], puntoNum:r[4],
        denom:r[5], cuit:r[6],
        neto:parseFloat(r[7])||0, iva:parseFloat(r[8])||0, total:parseFloat(r[9])||0,
      }));
    res.json({ ok: true, rows: filtered });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Eliminar tipo+periodo (o solo tipo dentro de un periodo)
router.delete('/oficina/datos', express.json(), authMiddleware, async (req, res) => {
  if (!['admin','adm'].includes(req.user.rol)) return res.status(403).json({ error: 'Sin acceso' });
  try {
    const { tipo, periodo } = req.query;
    if (!periodo) return res.status(400).json({ ok: false, error: 'Falta periodo' });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const existing = await getOficinaDatos(sheets);
    const header = existing.find(r => r[0] === 'tipo') || ['tipo','periodo','fecha','tipo_comp','puntoNum','denom','cuit','neto','iva','total'];
    const keep = existing.filter(r => {
      if (r[0] === 'tipo') return false; // se pone el header de nuevo
      if (tipo) return !(r[0] === tipo && r[1] === periodo);
      return r[1] !== periodo; // sin tipo: borra todo el periodo
    });
    await sheets.spreadsheets.values.clear({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'OficinaDatos!A:J' });
    if (keep.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'OficinaDatos!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [header, ...keep] },
      });
    }
    res.json({ ok: true, eliminados: existing.length - keep.length - 1 });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── ÓRDENES DE SERVICIO ─────────────────────────────────────────────────────

// Traer datos del presupuesto por token (para pre-cargar en orden.html)
router.get('/orden/presupuesto', authMiddleware, async (req, res) => {
  try {
    const { token: pToken } = req.query;
    if (!pToken) return res.json({ ok: false, error: 'Sin token' });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Presupuestos!A:J',
    });
    const rows = result.data.values || [];
    const row = rows.find(r => r[8] === pToken);
    if (!row) return res.json({ ok: false, error: 'No encontrado' });
    let datos = null;
    try { datos = row[9] ? JSON.parse(row[9]) : null; } catch(e) {}
    res.json({ ok: true, numero: row[1], cliente: row[3], tel: row[4], productos: row[5], total: row[6], datos });
  } catch (err) {
    console.error('Error orden/presupuesto:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Buscar cliente por DNI/CUIT en historial de presupuestos
router.get('/orden/cliente', authMiddleware, async (req, res) => {
  try {
    const doc = (req.query.doc || '').replace(/\D/g, '');
    if (!doc) return res.json({ encontrado: false });
    // Por ahora no hay tabla de clientes con DNI, devolver no encontrado
    res.json({ encontrado: false });
  } catch (err) {
    res.json({ encontrado: false });
  }
});

// Buscar vehículo por patente en historial de órdenes
router.get('/orden/vehiculo', authMiddleware, async (req, res) => {
  try {
    const patente = (req.query.patente || '').toUpperCase().trim();
    if (!patente) return res.json({ encontrado: false });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!A:Z',
    });
    const rows = (result.data.values || []).slice(1);
    // Columna G = patente en la hoja Ordenes
    const row = rows.filter(r => (r[6]||'').toUpperCase() === patente).pop();
    if (!row) return res.json({ encontrado: false });
    res.json({ encontrado: true, marca: row[7]||'', modelo: row[8]||'', anio: row[9]||'', km: row[10]||'' });
  } catch (err) {
    res.json({ encontrado: false });
  }
});

// Columnas hoja Ordenes (A→V):
// A:fecha  B:hora  C:nroOrden  D:vendedor
// E:clienteNombre  F:tel  G:doc  H:mail
// I:direccion  J:localidad  K:provincia  L:patente
// M:marcaVeh  N:modeloVeh  O:anio  P:km
// Q:total  R:estado  S:presupuestoNum  T:presupuestoToken
// U:observaciones  V:trabajosJSON

function parseOrdenRow(r, i) {
  return {
    fila: i + 2,
    fecha: r[0]||'', hora: r[1]||'', numero: r[2]||'', vendedor: r[3]||'',
    clienteNombre: r[4]||'', tel: r[5]||'', doc: r[6]||'', mail: r[7]||'',
    direccion: r[8]||'', localidad: r[9]||'', provincia: r[10]||'', patente: r[11]||'',
    marcaVeh: r[12]||'', modeloVeh: r[13]||'', anio: r[14]||'', km: r[15]||'',
    total: r[16]||'', estado: r[17]||'Ingresada',
    presupuestoNum: r[18]||'', presupuestoToken: r[19]||'',
    observaciones: r[20]||'',
    trabajos: (() => { try { return JSON.parse(r[21]||'[]'); } catch(e) { return []; } })()
  };
}

// Guardar orden de servicio en hoja Ordenes
router.post('/orden/guardar', express.json(), authMiddleware, async (req, res) => {
  try {
    const vendedor = req.user.nombre;
    const {
      pNumero, pToken,
      doc, nombre, apellido, tel, mail, direccion, localidad, provincia,
      patente, marcaVeh, modeloVeh, anio, km,
      trabajos, total, observaciones
    } = req.body;

    const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const fecha = ahora.toLocaleDateString('es-AR');
    const hora  = ahora.toTimeString().slice(0, 5);

    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });

    // Generar número de orden: OS-YYYYMMDD-XXX
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!A:A',
    });
    const existingRows = existing.data.values || [];
    // Crear encabezado si el sheet está vacío
    if (existingRows.length === 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Ordenes!A:V',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Fecha','Hora','Número','Vendedor','Cliente','Tel','Doc','Mail','Dirección','Localidad','Provincia','Patente','Marca','Modelo','Año','KM','Total','Estado','Pres.Num','Pres.Token','Observaciones','Trabajos']] },
      });
    }
    const countRows = existingRows.length; // sin header la primera OS es -001
    const nroOrden = 'OS-' + ahora.toISOString().slice(0,10).replace(/-/g,'') + '-' + String(countRows).padStart(3,'0');

    const clienteNombre = [apellido, nombre].filter(Boolean).join(' ');
    const trabajosJSON  = JSON.stringify(trabajos || []);
    const totalNum = parseInt(total) || (trabajos||[]).reduce((s, t) => s + (t.precio || 0), 0);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!A:V',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          fecha, hora, nroOrden, vendedor,
          clienteNombre, tel||'', doc||'', mail||'',
          direccion||'', localidad||'', provincia||'', (patente||'').toUpperCase(),
          marcaVeh||'', modeloVeh||'', anio||'', km||'',
          totalNum, 'Ingresada',
          pNumero||'', pToken||'',
          observaciones||'', trabajosJSON
        ]],
      },
    });

    res.json({ ok: true, id: nroOrden });
  } catch (err) {
    console.error('Error orden/guardar:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ver orden individual por número
router.get('/orden/ver', authMiddleware, async (req, res) => {
  try {
    const id = (req.query.id || '').trim();
    if (!id) return res.json({ ok: false });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!A:V',
    });
    const rows = (result.data.values || []).slice(1);
    const idx  = rows.findIndex(r => r[2] === id);
    if (idx === -1) return res.json({ ok: false });
    res.json({ ok: true, orden: parseOrdenRow(rows[idx], idx) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cambiar estado de una orden
router.post('/orden/estado', express.json(), authMiddleware, async (req, res) => {
  try {
    const { id, estado } = req.body;
    if (!id || !estado) return res.json({ ok: false });
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!C:C',
    });
    const rows = (result.data.values || []);
    const rowIdx = rows.findIndex(r => r[0] === id);
    if (rowIdx === -1) return res.json({ ok: false, error: 'No encontrada' });
    const sheetRow = rowIdx + 1; // 1-indexed, no header offset needed (incluye fila 1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `Ordenes!R${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[estado]] },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Listar todas las órdenes
router.get('/ordenes/listar', authMiddleware, async (req, res) => {
  try {
    const esAdmin = req.user.rol === 'admin';
    const vendedorActual = req.user.nombre;
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Ordenes!A:V',
    });
    const rows = (result.data.values || []).slice(1);
    const ordenes = rows
      .map((r, i) => parseOrdenRow(r, i))
      .filter(o => esAdmin || o.vendedor === vendedorActual)
      .reverse();
    res.json({ ordenes, esAdmin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN — solo rol admin
// ============================================================
const multer = require('multer');
const { spawn } = require('child_process');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function adminMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'No autorizado' });
  }
}

const DRIVE_FOLDER_ID = '11Ham__W-bVOJtaMsZQHRap-orDV6cpek';

// Keywords para encontrar cada tipo de fuente en Drive (mismo criterio que sincronizar-fuentes.js)
const DRIVE_KEYWORDS = {
  gallo:    { include: [['inv', 'gallo'], ['inventario'], ['gallo']], exclude: [['michelin'], ['lista'], ['precio'], ['baterias'], ['filtros'], ['frasle'], ['pastillas']] },
  celsur:   { include: [['celsur'], ['stock_disponible'], ['stock disponible']], exclude: [] },
  hankook:  { include: [['hankook']], exclude: [] },
  yokohama: { include: [['yokohama']], exclude: [] },
  linglong:    { include: [['ling']], exclude: [] },
  michelin:    { include: [['michelin', 'con descripcion'], ['michelin', 'bfgoodrich']], exclude: [] },
  sjysprecios: { include: [['sjys', 'precio'], ['sjys', 'lista'], ['giti', 'pmg'], ['gtradial', 'pmg'], ['lista', 'giti'], ['lista', 'gtradial']], exclude: [] },
  sjysstock:   { include: [['sjys', 'stock'], ['giti', 'stock'], ['gtradial', 'stock'], ['stock_cotiz'], ['cotiz_arg']], exclude: [['precio'], ['lista'], ['pmg']] },
  baterias:    { include: [['baterias'], ['bateria']], exclude: [] },
  filtros:     { include: [['filtros'], ['filtro']], exclude: [] },
  frasle:      { include: [['frasle'], ['pastillas'], ['freno']], exclude: [] },
};

function detectarTipoFuente(nombre) {
  const n = nombre.toLowerCase();
  if (n.includes('baterias') || n.includes('bateria')) return 'baterias';
  if (n.includes('filtros') || n.includes('filtro')) return 'filtros';
  if (n.includes('frasle') || n.includes('pastillas') || n.includes('freno')) return 'frasle';
  if (n.includes('celsur') || n.includes('stock_disponible') || n.includes('stock disponible')) return 'celsur';
  if (n.includes('hankook')) return 'hankook';
  if (n.includes('yokohama')) return 'yokohama';
  if (n.includes('ling')) return 'linglong';
  if (n.includes('michelin') || n.includes('bfgoodrich')) return 'michelin';
  if ((n.includes('giti') || n.includes('gtradial')) && (n.includes('pmg') || n.includes('precio') || n.includes('lista'))) return 'sjysprecios';
  if (n.includes('stock_cotiz') || n.includes('cotiz_arg') || ((n.includes('giti') || n.includes('gtradial')) && n.includes('stock'))) return 'sjysstock';
  if (n.includes('gallo') || n.includes('inv ') || n.startsWith('inv')) return 'gallo';
  return null;
}

function getAdminAuth(scopes) {
  return new google.auth.GoogleAuth({
    ...(process.env.GOOGLE_CREDENTIALS ? { credentials: GOOGLE_CREDS } : { keyFile: path.join(__dirname, 'credentials.json') }),
    scopes,
  });
}

async function listarDrive() {
  const auth = getAdminAuth(['https://www.googleapis.com/auth/drive']);
  const drive = google.drive({ version: 'v3', auth });
  const r = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name, size, modifiedTime)',
    orderBy: 'modifiedTime desc',
  });
  return { drive, archivos: r.data.files || [] };
}

function encontrarEnDrive(archivos, keywords) {
  for (const { include, exclude } of [keywords]) {
    for (const inc of include) {
      const matches = archivos.filter(f => {
        const n = f.name.toLowerCase();
        return inc.every(k => n.includes(k)) && (exclude.length === 0 || exclude.every(ex => !ex.every(e => n.includes(e))));
      });
      if (matches.length > 0) return matches[0];
    }
  }
  return null;
}

// Estado de archivos en Drive
router.get('/admin/fuentes', adminMiddleware, async (req, res) => {
  try {
    const { archivos } = await listarDrive();
    const resultado = {};
    for (const [tipo, kw] of Object.entries(DRIVE_KEYWORDS)) {
      const f = encontrarEnDrive(archivos, kw);
      if (f) {
        resultado[tipo] = { existe: true, nombre: f.name, tamaño: parseInt(f.size) || 0, modificado: f.modifiedTime };
      } else {
        resultado[tipo] = { existe: false };
      }
    }
    res.json(resultado);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Subir archivo → actualiza el archivo correspondiente en Drive
router.post('/admin/upload', adminMiddleware, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Sin archivo' });
  const tipo = detectarTipoFuente(req.file.originalname);
  if (!tipo) return res.status(400).json({ ok: false, error: `No reconozco el archivo: ${req.file.originalname}` });
  try {
    const { Readable } = require('stream');
    const { drive, archivos } = await listarDrive();
    const archivo = encontrarEnDrive(archivos, DRIVE_KEYWORDS[tipo]);
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    if (archivo) {
      // Archivo ya existe en Drive → actualizar contenido
      await drive.files.update({
        fileId: archivo.id,
        media: { mimeType, body: Readable.from(req.file.buffer) },
      });
      res.json({ ok: true, accion: 'actualizado en Drive', nombre: archivo.name, tipo });
    } else {
      // Archivo nuevo → crear en la carpeta Drive
      const created = await drive.files.create({
        requestBody: {
          name: req.file.originalname,
          parents: [DRIVE_FOLDER_ID],
        },
        media: { mimeType, body: Readable.from(req.file.buffer) },
        fields: 'id, name',
      });
      res.json({ ok: true, accion: 'creado en Drive', nombre: created.data.name, tipo });
    }
  } catch(e) {
    console.error('Admin upload Drive error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Correr sincronización y devolver output via SSE (token por query param para EventSource)
router.get('/admin/sync', (req, res, next) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.rol !== 'admin') return res.status(403).end();
    req.user = user; next();
  } catch { res.status(401).end(); }
}, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  send({ tipo: 'inicio', texto: 'Iniciando sincronización...' });

  const scriptPath = path.join(__dirname, 'scripts', 'sincronizar-fuentes.js');
  const proc = spawn(process.execPath, [scriptPath], { env: process.env });

  proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send({ tipo: 'log', texto: l })));
  proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send({ tipo: 'err', texto: l })));
  proc.on('close', code => {
    send({ tipo: 'fin', texto: code === 0 ? '✅ Sincronización completa' : `❌ Terminó con código ${code}`, ok: code === 0 });
    res.end();
  });
});

// ─── Upload accesorios con tipo explícito ────────────────────────────────────
router.post('/admin/upload-accesorio', adminMiddleware, upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Sin archivo' });
  const tipo = req.body.tipo;
  if (!['baterias', 'filtros', 'frasle'].includes(tipo))
    return res.status(400).json({ ok: false, error: 'Tipo inválido: ' + tipo });
  try {
    const { Readable } = require('stream');
    const { drive, archivos } = await listarDrive();
    const archivo = encontrarEnDrive(archivos, DRIVE_KEYWORDS[tipo]);
    const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (archivo) {
      await drive.files.update({ fileId: archivo.id, media: { mimeType, body: Readable.from(req.file.buffer) } });
      res.json({ ok: true, accion: 'actualizado en Drive', nombre: archivo.name, tipo });
    } else {
      const created = await drive.files.create({
        requestBody: { name: req.file.originalname, parents: [DRIVE_FOLDER_ID] },
        media: { mimeType, body: Readable.from(req.file.buffer) },
        fields: 'id, name',
      });
      res.json({ ok: true, accion: 'creado en Drive', nombre: created.data.name, tipo });
    }
  } catch(e) {
    console.error('Upload accesorio Drive error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Sync accesorios: baterías, filtros, pastillas ───────────────────────────
router.get('/admin/sync-accesorios', (req, res, next) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (user.rol !== 'admin') return res.status(403).end();
    req.user = user; next();
  } catch { res.status(401).end(); }
}, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const os = require('os');
  const fs = require('fs');

  try {
    const { drive, archivos } = await listarDrive();
    // El inventario de accesorios es el mismo archivo Gallo general
    const f = encontrarEnDrive(archivos, DRIVE_KEYWORDS['gallo']);
    if (!f) {
      send({ tipo: 'fin', texto: '⚠️  No se encontró el inventario Gallo en Drive', ok: false });
      return res.end();
    }

    send({ tipo: 'log', texto: `📥 Descargando inventario Gallo (${f.name})...` });
    const ext = f.name.endsWith('.xls') ? '.xls' : '.xlsx';
    const tmpPath = path.join(os.tmpdir(), `sync_accesorios${ext}`);

    const dest = fs.createWriteStream(tmpPath);
    const dlRes = await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
      dlRes.data.pipe(dest);
      dlRes.data.on('end', resolve);
      dlRes.data.on('error', reject);
    });

    send({ tipo: 'log', texto: '⚙️  Sincronizando Filtros, Pastillas y Baterías...' });

    await new Promise(resolve => {
      const scriptPath = path.join(__dirname, 'scripts', 'sincronizar-accesorios.js');
      const proc = spawn(process.execPath, [scriptPath, tmpPath], { env: process.env });
      proc.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send({ tipo: 'log', texto: l })));
      proc.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => send({ tipo: 'err', texto: l })));
      proc.on('close', code => { try { fs.unlinkSync(tmpPath); } catch {} resolve(code); });
    });

    send({ tipo: 'fin', texto: '✅ Accesorios sincronizados (Filtros, Pastillas, Baterías)', ok: true });
  } catch(e) {
    send({ tipo: 'err', texto: '❌ Error: ' + e.message });
    send({ tipo: 'fin', texto: '❌ Falló la sincronización', ok: false });
  }
  res.end();
});

// ─── Tienda Nube: actualizar precios y stock desde CSV ───────────────────────
function parsearMedidaTN(medida) {
  // "195/50R16" → { ancho: 195, perfil: 50, rodado: 16 }
  const m = medida.match(/(\d{3})[\/ ](\d{2})[Rr][Cc]?(\d{2})/);
  if (m) return { ancho: m[1], perfil: m[2], rodado: m[3] };
  const am = medida.match(/(\d{2})[Xx](\d+\.?\d*)[Rr](\d{2})/);
  if (am) return { ancho: am[1], perfil: am[2], rodado: am[3] };
  return null;
}

function formatTNNum(n) {
  // 129000 → "129,000.00"
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Abreviaciones técnicas de neumáticos que siempre van en mayúsculas
const ABREV_NEUMA = new Set([
  'XL','TL','SL','RWL','RBL','RFT','RF','AO','MO','VOL','SSR','GRNX','ST','CAI',
  'HP','AT','SUV','CV','SP','XT','ES','AT70','HP010','HP300','SU4','SH9I',
  'F22','F50','VP1','ES32','G015','G058','AE61','LX2','R1','FM800','EC300+',
  'N0','N1','N2','MO1','RO1','RO2','4X4','LTX','PMG',
]);

function toTitleCaseNeuma(str) {
  if (!str) return str;
  return str.split(' ').map(word => {
    if (!word) return word;
    if (/^\d+\/\d+[A-Z]\d+/i.test(word)) return word;          // medida 205/55R16
    if (/^\d+[A-Z]{1,2}$/i.test(word)) return word.toUpperCase(); // índice 91V, 112H
    if (/^\([A-Z0-9]+\)$/i.test(word)) return word.toUpperCase(); // (J), (N0)
    if (word.toUpperCase() === 'BFGOODRICH') return 'BFGoodrich';
    if (ABREV_NEUMA.has(word.toUpperCase())) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

function splitCSVLine(line) {
  // Split by ; respetando campos entre comillas
  const parts = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; cur += c; }
    else if (c === ';' && !inQ) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

router.post('/admin/tiendanube', adminMiddleware, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Sin archivo CSV' });
  try {
    const auth = new google.auth.GoogleAuth({
      ...(process.env.GOOGLE_CREDENTIALS ? { credentials: GOOGLE_CREDS } : { keyFile: path.join(__dirname, 'credentials.json') }),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Bot WhatsApp!A:J' });
    const sheetRows = r.data.values || [];

    // Mapa codArt → datos
    const sheetMap = {};
    for (let i = 1; i < sheetRows.length; i++) {
      const row = sheetRows[i];
      const codArt = (row[0] || '').trim();
      if (!codArt) continue;
      sheetMap[codArt] = {
        codAlt:   (row[1] || '').trim(),
        desc:     (row[2] || '').trim(),
        marca:    (row[3] || '').trim(),
        medida:   (row[5] || '').trim(),
        stockVic: parseInt(row[6]) || 0,
        stockNor: parseInt(row[7]) || 0,
        stockExpr:parseInt(row[8]) || 0,
        precio:   parseInt(row[9]) || 0,
      };
    }

    const content = req.file.buffer.toString('latin1');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const header = lines[0];
    const headerParts = splitCSVLine(header);
    // Detectar columnas de descripción e imagen dinámicamente
    const COL_NOMBRE = headerParts.findIndex(h => /nombre/i.test(h.replace(/"/g,'')));
    const COL_DESC   = headerParts.findIndex(h => /descripci/i.test(h.replace(/"/g,'')));
    const COL_IMG    = headerParts.findIndex(h => /imagen/i.test(h.replace(/"/g,'')));

    const tnCodArts = new Set();   // códigos que ya existen en TN (col 0)
    const updatedLines = [header];
    let actualizados = 0, sinDatos = 0;
    const cambios = [];
    const sinFoto = [], sinDesc = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = splitCSVLine(lines[i]);
      const codArt = parts[0].replace(/^"|"$/g, '').trim();
      tnCodArts.add(codArt);
      // También registrar el codAlt (col 16) para no duplicar por CAI
      const codAltTN = (parts[16] || '').replace(/^"|"$/g, '').trim();
      if (codAltTN) tnCodArts.add(codAltTN);

      // Auditoría: detectar productos sin foto ni descripción
      const nombre = COL_NOMBRE >= 0 ? (parts[COL_NOMBRE] || '').replace(/"/g,'').trim() : '';
      const desc   = COL_DESC  >= 0 ? (parts[COL_DESC]   || '').replace(/"/g,'').trim() : '';
      const img    = COL_IMG   >= 0 ? (parts[COL_IMG]    || '').replace(/"/g,'').trim() : '';
      if (!img)  sinFoto.push({ codArt, nombre });
      if (!desc) sinDesc.push({ codArt, nombre });

      const prod = sheetMap[codArt];
      if (!prod || prod.precio <= 0) { sinDatos++; updatedLines.push(lines[i]); continue; }

      const isExpress = (parts[2] || '').replace(/"/g, '').includes('Pedido Express');
      const precioPromo = prod.precio;
      const precio = Math.round(precioPromo / 0.8);
      const stockVic = isExpress ? 0 : (prod.stockVic + prod.stockNor);
      const stockCD  = isExpress ? String(prod.stockExpr > 0 ? prod.stockExpr : 0) : 'ND';

      const precioAnt = parseInt((parts[9] || '').replace(/[^0-9]/g, '')) || 0;
      const stockAnt  = parseInt(parts[15]) || 0;
      const precioCambio = precioAnt !== precio;
      const stockCambio  = stockAnt  !== stockVic;

      if (COL_NOMBRE >= 0) parts[COL_NOMBRE] = `"${toTitleCaseNeuma((parts[COL_NOMBRE] || '').replace(/"/g,'').trim())}"`;
      parts[9]  = formatTNNum(precio);
      parts[10] = formatTNNum(precioPromo);
      parts[15] = String(stockVic);
      parts[16] = stockCD;
      updatedLines.push(parts.join(';'));
      actualizados++;

      if (precioCambio || stockCambio) {
        cambios.push({
          codArt,
          desc: prod.desc,
          precioAnt,
          precioNuevo: precio,
          stockAnt,
          stockNuevo: stockVic,
          precioCambio,
          stockCambio,
        });
      }
    }

    // Marcas que no se suben a Tienda Nube
    const MARCAS_EXCLUIR_TN = ['FATE', 'PIRELLI', 'BRIDGESTONE', 'GOODYEAR'];
    // Marcas que se suben como Pedido Especial (solo Express/Celsur)
    const MARCAS_PEDIDO_ESPECIAL = ['MICHELIN', 'BFGOODRICH'];

    // Helper para construir fila CSV de producto nuevo
    function buildTNRow(codArt, prod, categoria, stockPropio, stockExpr) {
      const dim = parsearMedidaTN(prod.medida);
      const precioPromo = prod.precio;
      const precio = Math.round(precioPromo / 0.8);
      const marca = prod.marca.toUpperCase();
      return [
        codArt,
        `"${toTitleCaseNeuma(prod.desc)}"`,
        `"${categoria}"`,
        'Ancho', dim ? dim.ancho : '',
        'Perfil', dim ? dim.perfil : '',
        'Rodado', dim ? dim.rodado : '',
        formatTNNum(precio),
        formatTNNum(precioPromo),
        '', '', '', '',
        String(stockPropio),
        stockExpr !== null ? String(stockExpr) : 'ND',
        prod.codAlt,
        '',
        'SI', 'NO',
        '', '', '', '',
        marca,
        'SI',
        '', '', '', '',
        'Visible',
      ].join(';');
    }

    // Productos nuevos: en sheet con stock propio >= 4 y no en TN
    const nuevos = [];
    for (const [codArt, prod] of Object.entries(sheetMap)) {
      if (tnCodArts.has(codArt) || prod.precio <= 0) continue;
      const totalStock = prod.stockVic + prod.stockNor;
      if (totalStock < 4) continue;
      if (/^Z\./i.test(prod.desc)) continue;
      if (MARCAS_EXCLUIR_TN.includes(prod.marca.toUpperCase())) continue;
      nuevos.push({ codArt, ...prod, totalStock });
      updatedLines.push(buildTNRow(codArt, prod, prod.marca.toUpperCase(), totalStock, null));
    }

    // Pedidos especiales: Celsur (Michelin/BFGoodrich) con stock Express > 0 y no en TN
    // Usa codAlt (CAI de Celsur) como código de producto, igual que los productos Express existentes
    const nuevosEspeciales = [];
    for (const [codArt, prod] of Object.entries(sheetMap)) {
      if (prod.precio <= 0) continue;
      const marca = prod.marca.toUpperCase();
      if (!MARCAS_PEDIDO_ESPECIAL.includes(marca)) continue;
      if (prod.stockExpr <= 0) continue;
      if (/^Z\./i.test(prod.desc)) continue;
      // El código en TN para Michelin/BFG es el CAI (codAlt), no el codArt interno
      const codigoTN = prod.codAlt || codArt;
      if (tnCodArts.has(codigoTN) || tnCodArts.has(codArt)) continue;
      nuevosEspeciales.push({ codArt: codigoTN, ...prod });
      updatedLines.push(buildTNRow(codigoTN, prod, 'Pedido Especial', 0, prod.stockExpr));
    }

    const csvOutput = updatedLines.join('\n');

    // Generar txt resumen de cambios
    const fecha = new Date().toLocaleString('es-AR');
    const lineasTxt = [
      `CAMBIOS TIENDA NUBE — ${fecha}`,
      `${'='.repeat(60)}`,
      `Total productos: ${lines.length - 1} | Actualizados: ${actualizados} | Sin datos: ${sinDatos} | Nuevos: ${nuevos.length} | Pedidos especiales: ${nuevosEspeciales.length}`,
      '',
    ];
    const soloPrecio   = cambios.filter(c => c.precioCambio && !c.stockCambio);
    const soloStock    = cambios.filter(c => c.stockCambio && !c.precioCambio);
    const ambos        = cambios.filter(c => c.precioCambio && c.stockCambio);
    const sinCambioReal = actualizados - cambios.length;

    lineasTxt.push(`CAMBIOS DETECTADOS (${cambios.length} productos con diferencias):`);
    lineasTxt.push(`  Precio y stock: ${ambos.length} | Solo precio: ${soloPrecio.length} | Solo stock: ${soloStock.length} | Sin cambio real: ${sinCambioReal}`);
    lineasTxt.push('');

    if (ambos.length > 0) {
      lineasTxt.push(`--- PRECIO Y STOCK CAMBIARON (${ambos.length}) ---`);
      for (const c of ambos) {
        lineasTxt.push(`  ${c.codArt} | ${c.desc.substring(0, 45).padEnd(45)} | Precio: $${c.precioAnt.toLocaleString('es-AR')} → $${c.precioNuevo.toLocaleString('es-AR')} | Stock: ${c.stockAnt} → ${c.stockNuevo}`);
      }
      lineasTxt.push('');
    }
    if (soloPrecio.length > 0) {
      lineasTxt.push(`--- SOLO PRECIO CAMBIÓ (${soloPrecio.length}) ---`);
      for (const c of soloPrecio) {
        lineasTxt.push(`  ${c.codArt} | ${c.desc.substring(0, 45).padEnd(45)} | $${c.precioAnt.toLocaleString('es-AR')} → $${c.precioNuevo.toLocaleString('es-AR')}`);
      }
      lineasTxt.push('');
    }
    if (soloStock.length > 0) {
      lineasTxt.push(`--- SOLO STOCK CAMBIÓ (${soloStock.length}) ---`);
      for (const c of soloStock) {
        lineasTxt.push(`  ${c.codArt} | ${c.desc.substring(0, 45).padEnd(45)} | Stock: ${c.stockAnt} → ${c.stockNuevo}`);
      }
      lineasTxt.push('');
    }
    if (nuevos.length > 0) {
      lineasTxt.push(`--- PRODUCTOS NUEVOS (${nuevos.length}) ---`);
      for (const p of nuevos) {
        lineasTxt.push(`  ${p.codArt} | ${p.desc.substring(0, 45).padEnd(45)} | Stock: ${p.totalStock} | Precio: $${p.precio.toLocaleString('es-AR')}`);
      }
    }
    const txtOutput = lineasTxt.join('\n');

    res.json({
      ok: true,
      stats: { actualizados, sinDatos, nuevos: nuevos.length, especiales: nuevosEspeciales.length, total: lines.length - 1, cambios: cambios.length, sinFoto: sinFoto.length, sinDesc: sinDesc.length },
      nuevos: nuevos.map(p => ({ codArt: p.codArt, desc: p.desc, medida: p.medida, marca: p.marca, stock: p.totalStock, precio: p.precio })),
      especiales: nuevosEspeciales.map(p => ({ codArt: p.codArt, desc: p.desc, medida: p.medida, marca: p.marca, stockExpr: p.stockExpr, precio: p.precio })),
      sinFoto,
      sinDesc,
      csv: Buffer.from(csvOutput, 'latin1').toString('base64'),
      txt: Buffer.from(txtOutput, 'utf8').toString('base64'),
    });
  } catch(e) {
    console.error('TN update error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
