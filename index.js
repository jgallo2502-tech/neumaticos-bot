require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

// Parsear credenciales Google UNA sola vez y corregir private_key
// Railway guarda los \n como literales en env vars
let GOOGLE_CREDS;
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (GOOGLE_CREDS.private_key) {
    GOOGLE_CREDS.private_key = GOOGLE_CREDS.private_key.replace(/\\n/g, '\n');
  }
  console.log('Google credentials cargadas. client_email:', GOOGLE_CREDS.client_email);
  console.log('private_key starts with:', GOOGLE_CREDS.private_key ? GOOGLE_CREDS.private_key.substring(0, 40) : 'NULL');
} catch(e) {
  console.error('ERROR al parsear GOOGLE_CREDENTIALS:', e.message);
}

const express = require('express');
const twilio = require('twilio');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const appRouter = require('./app');
const reventaRouter = require('./reventa');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function buscarImagenNeumatico(descripcion) {
  try {
    const q = encodeURIComponent(`${descripcion} tire neumatico`);
    console.log(`[DDG] Buscando: ${descripcion}`);
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    // Paso 1: obtener vqd y cookies
    const r1 = await fetch(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const cookies = (r1.headers.get('set-cookie') || '').split(',').map(c => c.split(';')[0]).join('; ');
    const html = await r1.text();
    const vqdMatch = html.match(/vqd=([\d-]+)/);
    if (!vqdMatch) { console.log('[DDG] No se encontró vqd'); return null; }
    const vqd = vqdMatch[1];
    console.log(`[DDG] vqd=${vqd}`);
    // Paso 2: buscar imágenes con cookies
    const r2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${vqd}&f=,,,,,&p=1`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/', 'Cookie': cookies, 'Accept': 'application/json' }
    });
    const text = await r2.text();
    console.log(`[DDG] status=${r2.status} preview=${text.substring(0, 80)}`);
    const data = JSON.parse(text);
    const link = data.results?.[0]?.image || null;
    if (link) console.log(`[DDG] imagen: ${link.substring(0, 80)}`);
    return link;
  } catch (e) {
    console.error('[DDG] Error buscando imagen:', e.message);
    return null;
  }
}
// Número de WhatsApp del bot (sin prefijo whatsapp:)
const BOT_PHONE = (process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE || '').replace('whatsapp:', '');

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- App de presupuestos ---
app.use('/app', appRouter);

// --- Portal de reventa ---
app.use('/reventa', reventaRouter);

// --- Historial de conversaciones ---
// Guarda mensajes por número y cierra la sesión tras 30 min de inactividad
const sesiones = new Map(); // numero -> { mensajes: [], timer, inicio, productosExtra: [], ultimaMedida: null }
const INACTIVIDAD_SEGUIMIENTO_MS = 25 * 60 * 1000; // 25 min de inactividad → seguimiento conversacional
const INACTIVIDAD_CIERRE_MS      = 10 * 60 * 1000; // 10 min más sin respuesta → cerrar sesión

const WA_SUCURSALES = `📍 *Neumáticos Gallo — Sucursales:*\n• *Victoria:* wa.me/541137735246\n• *Nordelta (Tigre):* wa.me/541157347692\n\nUn asesor te va a atender por ahí. 😊`;

function registrarMensajeSesion(numero, rol, texto) {
  if (!sesiones.has(numero)) {
    sesiones.set(numero, {
      mensajes: [],
      timer: null,
      inicio: new Date(Date.now() - 3 * 60 * 60 * 1000),
      productosExtra: [],
      ultimaMedida: null,
      ultimosProductos: [],
      esperandoFoto: false,
      esperandoSeleccionFoto: false,
    });
  }
  const sesion = sesiones.get(numero);
  sesion.mensajes.push({ rol, texto });

  // Persistir mensaje en Google Sheets (fire & forget)
  guardarMensaje(numero, rol, texto).catch(() => {});

  // Reiniciar timer de inactividad
  if (sesion.timer) clearTimeout(sesion.timer);
  sesion.timer = setTimeout(() => enviarSeguimiento(numero).catch(e => console.error('enviarSeguimiento error:', e.message)), INACTIVIDAD_SEGUIMIENTO_MS);
}

async function guardarAlerta(numero, mensaje) {
  const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const fecha = ahora.toISOString().slice(0, 10).split('-').reverse().join('/');
  const hora  = ahora.toISOString().slice(11, 16);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Alertas!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, hora, numero, mensaje, 'NO']] },
  });
}

async function guardarMensaje(numero, rol, texto) {
  return guardarMensajes([[numero, rol, texto]]);
}

async function guardarMensajes(lista) {
  // lista = [[numero, rol, texto], ...]
  const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const fecha = ahora.toISOString().slice(0, 10).split('-').reverse().join('/');
  const hora  = ahora.toISOString().slice(11, 16);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Mensajes!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: lista.map(([numero, rol, texto]) => [fecha, hora, numero, rol, texto]) },
  });
}

async function enviarSeguimiento(numero) {
  const sesion = sesiones.get(numero);
  if (!sesion || sesion.mensajes.length === 0) {
    sesiones.delete(numero);
    return;
  }
  const msg = '¿Pudiste encontrar lo que buscabas? 😊 Si necesitás ayuda con algo más o querés consultar otra medida, estoy acá.';
  try {
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: msg });
    guardarMensaje(numero, 'bot', msg).catch(() => {});
    sesion.mensajes.push({ rol: 'bot', texto: msg });
  } catch(e) { console.error('Error enviando seguimiento:', e.message); }
  if (sesion.timer) clearTimeout(sesion.timer);
  sesion.timer = setTimeout(() => cerrarSesion(numero).catch(e => console.error('cerrarSesion error:', e.message)), INACTIVIDAD_CIERRE_MS);
}

async function cerrarSesion(numero) {
  const sesion = sesiones.get(numero);
  if (!sesion) return;
  sesiones.delete(numero);
  if (sesion.mensajes.length === 0) return;
  const resumen = generarResumen(sesion.mensajes, sesion.inicio);
  await guardarResumenSesion(numero, sesion.inicio, resumen);
  console.log('Sesión cerrada para', numero, '| Resumen guardado');

  // Programar seguimiento 4 horas después si hubo medidas consultadas
  const medidas = new Set();
  const marcas = new Set();
  for (const m of sesion.mensajes) {
    if (m.rol === 'cliente') {
      const med = normalizarMedida(m.texto);
      if (med) medidas.add(med);
      const marc = extraerMarca(m.texto);
      if (marc) marcas.add(marc);
    }
  }
  if (medidas.size > 0) {
    programarSeguimiento(numero, [...medidas], [...marcas]).catch(e =>
      console.error('Error programando seguimiento:', e.message)
    );
  }
}

async function programarSeguimiento(numero, medidas, marcas) {
  const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000); // hora Argentina
  const programado = new Date(ahora.getTime() + 4 * 60 * 60 * 1000); // +4 horas
  const fecha = ahora.toISOString().slice(0, 10).split('-').reverse().join('/');
  const horaProg = programado.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Seguimientos!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[fecha, numero, medidas.join(', '), marcas.join(', '), horaProg, 'PENDIENTE']] },
  });
  console.log(`[seguimiento] Programado para ${numero} a las ${horaProg}`);
}

function generarResumen(mensajes, inicio) {
  const medidas = new Set();
  const marcas = new Set();
  let pidioPersona = false;
  let pidioTurno = false;

  for (const m of mensajes) {
    if (m.rol === 'cliente') {
      const med = normalizarMedida(m.texto);
      if (med) medidas.add(med);
      const marc = extraerMarca(m.texto);
      if (marc) marcas.add(marc);
      const lower = m.texto.toLowerCase();
      if (lower.includes('hablar') || lower.includes('persona') || lower.includes('alguien')) pidioPersona = true;
      if (lower.includes('turno') || lower.includes('cita') || lower.includes('instalar')) pidioTurno = true;
    }
  }

  const partes = [];
  if (medidas.size > 0) partes.push(`Medidas consultadas: ${[...medidas].join(', ')}`);
  if (marcas.size > 0) partes.push(`Marcas de interés: ${[...marcas].join(', ')}`);
  if (pidioPersona) partes.push('Solicitó atención humana');
  if (pidioTurno) partes.push('Consultó sobre turno/instalación');
  partes.push(`Total mensajes: ${mensajes.length}`);

  return partes.join(' | ');
}

async function guardarResumenSesion(numero, inicio, resumen) {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const fecha = ahora.toISOString().slice(0, 10).split('-').reverse().join('/');
    const hora  = ahora.toISOString().slice(11, 16);
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Consultas!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[fecha, hora, numero, '', '', '', '', resumen]] },
    });
  } catch (err) {
    console.error('Error al guardar resumen sesión:', err.message);
  }
}

// --- Normalizar medida de neumático ---
// Acepta: 185/65R15, 185-65-15, 18565r15, 205 55 16, 33x12.50R15, 31x10.5 r15, etc.
function normalizarMedida(texto) {
  // Quitar prefijo RF de run flat (ej: RF205/45RF17 → 205/45R17)
  const t = texto.replace(/\s+/g, ' ').trim().replace(/^RF\s*/i, '');

  // Formato americano/flotación: 33x12.50R15, 35X12.50R17LT, etc.
  // Sufijo LT (Light Truck) se descarta para normalizar
  const mAm = t.match(/(\d{2})\s*[xX]\s*(\d{2}\.?\d*)\s*[rR]\s*(\d{2})(?:LT)?\b/i);
  if (mAm) {
    // Normalizar ancho: 10.50 → 10.50, 10.5 → 10.50 (siempre 2 decimales para consistencia)
    const ancho = parseFloat(mAm[2]).toFixed(2);
    return `${mAm[1]}X${ancho}R${mAm[3]}`.toUpperCase();
  }

  // Formato métrico: 205/55R16, RF205/45RF17, 205-55-16, etc.
  // El sufijo "C" indica neumático de carga/comercial (Sprinter, Master, Transit)
  const m1 = t.match(/(\d{3})\s*[\/\-\s]\s*(\d{2})\s*(?:[rR][fF]?|[\/\-\s])\s*(\d{2})(C)?\b/i);
  if (m1) return `${m1[1]}/${m1[2]}R${m1[3]}${m1[4] ? 'C' : ''}`;

  // Sin separadores: 2055516, 20555r16, 20555RF16
  const m2 = t.match(/(\d{3})(\d{2})[rR][fF]?(\d{2})(C)?\b/i);
  if (m2) return `${m2[1]}/${m2[2]}R${m2[3]}${m2[4] ? 'C' : ''}`;

  // Formato sin perfil: 195 R14 o 195 R14C (furgonetas/camionetas)
  const m3 = t.match(/(\d{3})\s*[rR]\s*(\d{2})(C)?\b/i);
  if (m3) return `${m3[1]}R${m3[2]}${m3[3] ? 'C' : ''}`;

  return null;
}

// --- Extraer marca del texto ---
const MARCAS_PREMIUM       = ['michelin', 'yokohama', 'falken', 'continental', 'dunlop', 'bfgoodrich', 'goodyear', 'pirelli', 'bridgestone'];
const MARCAS_PRECIO_CALIDAD = ['giti', 'gtradial', 'hankook', 'nexen'];
const MARCAS_ECONOMICAS     = ['tracmax', 'linglong', 'atlas', 'laufenn', 'westlake', 'windforce', 'lavigator', 'wanli', 'sunny'];
const TODAS_MARCAS = [...MARCAS_PREMIUM, ...MARCAS_PRECIO_CALIDAD, ...MARCAS_ECONOMICAS];

// Marcas que NO se ofrecen a revendedores
const MARCAS_EXCLUIDAS_REVENTA = ['pirelli', 'bridgestone'];


function extraerMarca(texto) {
  const lower = texto.toLowerCase();
  return TODAS_MARCAS.find(m => lower.includes(m)) || null;
}

function categoriaYEmoji(marca) {
  const m = marca.toLowerCase();
  if (MARCAS_PREMIUM.includes(m)) return { cat: '⭐ Premium', orden: 1 };
  if (MARCAS_PRECIO_CALIDAD.includes(m)) return { cat: '✅ Precio-Calidad', orden: 2 };
  if (MARCAS_ECONOMICAS.includes(m)) return { cat: '💰 Económicas', orden: 3 };
  return { cat: '📦 Otras', orden: 4 };
}

function descuentoRevendedor(marca) {
  const m = marca.toLowerCase();
  if (['michelin', 'bfgoodrich'].includes(m)) return 0.35;
  if (['giti', 'gtradial'].includes(m)) return 0.33;
  if (['yokohama', 'linglong', 'hankook', 'atlas'].includes(m)) return 0.32;
  if (m === 'tracmax') return 0.45;
  return 0.28;
}

// --- Cache de revendedores ---
let revendedoresCache = null;
let revendedoresCacheTime = 0;

async function esRevendedor(numero) {
  try {
    const ahora = Date.now();
    // Refrescar cache cada 5 minutos
    if (!revendedoresCache || ahora - revendedoresCacheTime > 5 * 60 * 1000) {
      const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      const sheets = google.sheets({ version: 'v4', auth });
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Revendedores!A:A',
      });
      const rows = res.data.values || [];
      revendedoresCache = new Set(rows.slice(1).flat().map(n => n.toString().replace(/\D/g, '')).filter(n => n.length > 5));
      revendedoresCacheTime = ahora;
    }
    const numLimpio = numero.replace(/\D/g, '');
    console.log('Verificando revendedor:', numLimpio, '| Lista:', [...revendedoresCache]);
    return revendedoresCache.has(numLimpio);
  } catch (err) {
    console.error('Error al leer revendedores:', err.message);
    return false;
  }
}

// --- Registrar consulta en Google Sheets ---
async function registrarConsulta(numero, medida, marca, productos) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Hora Argentina (UTC-3)
    const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const fecha = ahora.toISOString().slice(0, 10).split('-').reverse().join('/');
    const hora  = ahora.toISOString().slice(11, 16);

    // Resumen de productos encontrados
    let detalles = '';
    if (productos.length === 0) {
      detalles = 'Sin stock disponible';
    } else {
      detalles = productos.slice(0, 5).map(p => `${p.marca} $${fmt(p.precio)}`).join(' | ');
      if (productos.length > 5) detalles += ` (+${productos.length - 5} más)`;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Consultas!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[fecha, hora, numero, medida, marca || '', productos.length, detalles]],
      },
    });
  } catch (err) {
    console.error('Error al registrar consulta:', err.message);
  }
}

// --- Leer Google Sheets ---
// Columnas: A=Cod.Art | B=Cod.Alt | C=Descripción | D=Marca | E=Modelo | F=Medida
//           G=Victoria | H=Nordelta | I=Pedido Express 48hs | J=Precio | K=Promoción
function getGoogleAuth(scopes) {
  return new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes });
}

async function obtenerPrecios(medida, marca, incluirRunFlat = false, minStock = 4, incluirNieve = false) {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });

  const rows = res.data.values || [];
  const resultados = [];

  for (const row of rows.slice(1)) {
    const rowCodAlt  = row[1] || '';  // B
    const rowDesc    = row[2] || '';  // C
    const rowMarca   = row[3] || '';  // D
    const rowModelo  = row[4] || '';  // E
    const rowMedida  = row[5] || '';  // F
    const stockVic   = row[6] || '0'; // G
    const stockNor   = row[7] || '0'; // H
    const stockExpr  = row[8] || '0'; // I
    const rowPrecio  = row[9] || '';  // J
    const rowPromo   = row[10] || ''; // K

    if (!rowMarca || !rowMedida || !rowPrecio || parseInt(rowPrecio) <= 0) continue;

    const medidaRowNorm = normalizarMedida(rowMedida);
    // Si el usuario no especificó "C", igual debe encontrar neumáticos de carga/comerciales (ej: 205/75R16C)
    const coincideMedida = medidaRowNorm === medida || medidaRowNorm === `${medida}C`;
    const coincideMarca = marca ? rowMarca.toLowerCase().includes(marca) : true;

    const sVic  = parseInt(stockVic.toString().replace(/\D/g, '')) || 0;
    const sNor  = parseInt(stockNor.toString().replace(/\D/g, '')) || 0;
    const sExpr = parseInt(stockExpr.toString().replace(/\D/g, '')) || 0;
    const stockTotal = sVic + sNor + sExpr;

    // RF seguido de dígito = run flat (RF205..., RF 235...); RF11/RF12 son modelos Hankook, no run flat
    const esRunFlat = /runflat|run flat|run-flat|\bRFT\b|\bZP\b|\bEMT\b/i.test(rowDesc) || /^RF\s*\d{3}/i.test(rowDesc);
    if (incluirRunFlat && !esRunFlat) continue;  // modo solo run flat: excluir normales
    if (!incluirRunFlat && esRunFlat) continue;  // modo normal: excluir run flat

    // Gamas de nieve/invierno: ocultar salvo que el cliente lo pida explícitamente
    const esNieve = /\b(alpin|ice snow|x-ice|xice|agilis alpin)\b/i.test(rowModelo + ' ' + rowDesc);
    if (!incluirNieve && esNieve) continue;

    if (coincideMedida && coincideMarca && stockTotal >= minStock) {
      resultados.push({
        codAlt: rowCodAlt,
        descripcion: rowDesc,
        marca: rowMarca,
        medida: rowMedida,
        precio: parseInt(rowPrecio.toString().replace(/\D/g, '')),
        promocion: rowPromo,
        stockVic: sVic,
        stockNor: sNor,
        stockExpr: sExpr,
        stockTotal,
      });
    }
  }

  // Orden dentro de cada categoría: marcas prioritarias primero, luego stock
  const ORDEN_MARCA = {
    // Premium: Michelin y Yokohama primero
    'michelin': 1, 'yokohama': 2, 'falken': 3, 'continental': 4, 'dunlop': 5, 'bfgoodrich': 6, 'goodyear': 7, 'pirelli': 8, 'bridgestone': 9,
    // Precio-Calidad: Giti y GTRadial primero
    'giti': 1, 'gtradial': 2, 'hankook': 3, 'nexen': 4,
    // Económicas: Tracmax y Linglong primero
    'tracmax': 1, 'linglong': 2, 'laufenn': 3, 'westlake': 4, 'windforce': 5, 'lavigator': 6, 'wanli': 7, 'sunny': 8,
  };

  return resultados.sort((a, b) => {
    const { orden: oA } = categoriaYEmoji(a.marca);
    const { orden: oB } = categoriaYEmoji(b.marca);
    if (oA !== oB) return oA - oB;
    // Dentro de cada categoría: stock propio primero, luego Express
    const aPropio = (a.stockVic + a.stockNor) > 0 ? 0 : 1;
    const bPropio = (b.stockVic + b.stockNor) > 0 ? 0 : 1;
    if (aPropio !== bPropio) return aPropio - bPropio;
    const mA = ORDEN_MARCA[a.marca.toLowerCase()] || 99;
    const mB = ORDEN_MARCA[b.marca.toLowerCase()] || 99;
    if (mA !== mB) return mA - mB;
    return b.stockTotal - a.stockTotal;
  });
}

// --- Formatear precio con puntos ---
function fmt(n) {
  return n.toLocaleString('es-AR');
}

// --- Armar bloque de precios para un producto ---
function preciosProducto(precio, esRev = false, marca = '') {
  if (esRev) {
    const desc = descuentoRevendedor(marca);
    const precioRev = Math.round(precio * (1 - desc));
    return `💲 Precio reventa: $${fmt(precioRev)}`;
  }
  const p6  = Math.round(precio / 6);
  const p3  = Math.round(precio * 0.85 / 3);
  const contado = Math.round(precio * 0.80);
  return `💳 12 pagos: $${fmt(precio)}\n💳 6 cuotas (-10%): $${fmt(Math.round(precio * 0.90))} — $${fmt(p6)}/cuota\n💳 3 cuotas (-15%): $${fmt(Math.round(precio * 0.85))} — $${fmt(p3)}/cuota\n💵 Contado (-20%): $${fmt(contado)}`;
}

const PIE = `📌 _Precios unitarios con IVA incluido._

📍 *Suc. Victoria:* Pres. Perón 3479 — ☎️ 11-3773-5246
📍 *Suc. Nordelta:* Agustín García 6318, Tigre — ☎️ 11-5734-7692
🕐 Lun-Vie 8 a 19 hs | Sáb 8 a 16 hs`;

// --- Prioridad de marcas para ordenar resultados (particulares) ---
const PRIORIDAD_MARCA_BOT = {
  'michelin': 1, 'bfgoodrich': 2, 'yokohama': 3, 'dunlop': 4, 'continental': 5,
  'falken': 6, 'goodyear': 7, 'pirelli': 8, 'bridgestone': 9,
  'giti': 10, 'gtradial': 11, 'hankook': 12, 'nexen': 13,
  'tracmax': 14, 'linglong': 15, 'laufenn': 16, 'westlake': 17,
};

// --- Formatear un producto para WhatsApp (un mensaje por producto) ---
function formatearProductoWA(p, esRev = false) {
  const tienePropio = (p.stockVic + p.stockNor) > 0;
  const express = !tienePropio && p.stockExpr > 0
    ? '\n⚡ _Pedido especial — retiro en sucursal en 48/72 hs hábiles_'
    : '';
  const promo = !esRev && p.promocion?.trim()
    ? `\n🏷️ _Promo: ${p.promocion} (2+ neumáticos, presencial)_`
    : '';
  let msg = `🔹 *${p.descripcion}*\n${preciosProducto(p.precio, esRev, p.marca)}${promo}${express}`;
  if (esRev) {
    const parts = [];
    if (p.stockVic > 0) parts.push(`Victoria: ${p.stockVic <= 7 ? p.stockVic : 'OK'}`);
    if (p.stockNor > 0) parts.push(`Nordelta: ${p.stockNor <= 7 ? p.stockNor : 'OK'}`);
    if (p.stockExpr > 0) parts.push(`Express: ${p.stockExpr <= 7 ? p.stockExpr : 'OK'} (48/72 hs)`);
    if (parts.length) msg += `\n📦 _Stock: ${parts.join(' | ')}_`;
  }
  return msg;
}

// --- Enviar precios a particulares: greeting → 30s → productos → pie → seguimiento ---
async function enviarPreciosParticulares(numero, productos, medidaNorm, sesionActual) {
  if (productos.length === 0) {
    const msg = `No encontré neumáticos *${medidaNorm}* con stock disponible.\n\nContactá nuestras sucursales:\n\n${WA_SUCURSALES}`;
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: msg });
    guardarMensaje(numero, 'bot', msg).catch(() => {});
    sesionActual.mensajes?.push({ rol: 'bot', texto: msg });
    return;
  }

  // Ordenar: stock propio primero, luego por prioridad de marca
  const sortPrio = arr => [...arr].sort((a, b) =>
    (PRIORIDAD_MARCA_BOT[a.marca.toLowerCase()] || 99) - (PRIORIDAD_MARCA_BOT[b.marca.toLowerCase()] || 99)
  );
  const conPropio   = sortPrio(productos.filter(p => p.stockVic + p.stockNor > 0));
  const soloExpress = sortPrio(productos.filter(p => p.stockVic + p.stockNor === 0));
  const ordenados   = [...conPropio, ...soloExpress];
  const mostrar     = ordenados.slice(0, 5);
  const extra       = ordenados.slice(5);

  sesionActual.productosExtra    = extra;
  sesionActual.ultimaMedida      = medidaNorm;
  sesionActual.ultimosProductos  = mostrar;

  // Encabezado
  const headerMsg = `🔍 Encontré estas opciones para *${medidaNorm}*:`;
  await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: headerMsg });
  guardarMensaje(numero, 'bot', headerMsg).catch(() => {});

  // Un mensaje por producto con delay
  for (const p of mostrar) {
    await new Promise(r => setTimeout(r, 1500));
    const msg = formatearProductoWA(p);
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: msg });
    guardarMensaje(numero, 'bot', msg).catch(() => {});
    sesionActual.mensajes?.push({ rol: 'bot', texto: msg });
  }

  await new Promise(r => setTimeout(r, 2000));

  // Pie de precio
  await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: PIE });
  guardarMensaje(numero, 'bot', PIE).catch(() => {});

  await new Promise(r => setTimeout(r, 1500));

  // Pregunta de seguimiento
  const followup = extra.length > 0
    ? `¿Qué te parecieron los precios? 😊 Tenemos ${extra.length} opción${extra.length > 1 ? 'es' : ''} más disponibles. Si querés algo más económico o ver más opciones, avisame.`
    : `¿Qué te parecieron los precios? 😊 Si necesitás algo más, estoy acá.`;
  await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: followup });
  guardarMensaje(numero, 'bot', followup).catch(() => {});
  sesionActual.mensajes?.push({ rol: 'bot', texto: followup });
}

// --- Armar lista de mensajes (uno por categoría) ---
function armarMensajes(productos, medidaOriginal, esRev = false, sinLimite = false) {
  if (productos.length === 0) {
    return [`No encontré neumáticos *${medidaOriginal}* con stock disponible.\n\nContactá nuestras sucursales para consultar disponibilidad:\n${WA_SUCURSALES}`];
  }

  const mensajes = [];

  // Filtrar marcas excluidas para revendedores
  const productosVisibles = esRev
    ? productos.filter(p => !MARCAS_EXCLUIDAS_REVENTA.includes(p.marca.toLowerCase()))
    : productos;

  // Encabezado
  const headerExtra = esRev ? ' _(precios de revendedor)_' : '';
  const totalVisibles = productosVisibles.length;
  mensajes.push(`🔍 *${medidaOriginal}* — ${totalVisibles} opción${totalVisibles > 1 ? 'es' : ''} con stock disponible${headerExtra}:`);

  // Límites por categoría: particulares 3/3/2, revendedores sin límite especial (solo stock)
  const LIMITES = esRev ? { 1: 99, 2: 99, 3: 99, 4: 99 } : { 1: 3, 2: 3, 3: 2, 4: 2 };

  const grupos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of productosVisibles) {
    const { orden } = categoriaYEmoji(p.marca);
    if (grupos[orden].length < LIMITES[orden]) grupos[orden].push(p);
  }

  const nombresGrupo = {
    1: '⭐ *PREMIUM*',
    2: '✅ *PRECIO-CALIDAD*',
    3: '💰 *ECONÓMICAS*',
    4: '📦 *OTRAS*',
  };

  // Un mensaje por categoría
  for (const orden of [1, 2, 3, 4]) {
    if (grupos[orden].length === 0) continue;
    let msg = `${nombresGrupo[orden]}\n`;
    for (const p of grupos[orden]) {
      const tienePropio = (p.stockVic + p.stockNor) > 0;
      const express = (!tienePropio && p.stockExpr > 0)
        ? '\n⚡ _Solo disponible vía Pedido Express — entrega en 48/72 hs hábiles (no en stock en local)_'
        : '';
      msg += `\n🔹 *${p.descripcion}*\n`;
      msg += preciosProducto(p.precio, esRev, p.marca);
      if (p.promocion && !esRev && p.promocion.trim()) {
        msg += `\n🏷️ _Promo: ${p.promocion} (presencial, 2+ neumáticos)_`;
      }
      if (esRev) {
        const sv = p.stockVic > 0 ? (p.stockVic <= 7 ? p.stockVic : 'OK') : null;
        const sn = p.stockNor > 0 ? (p.stockNor <= 7 ? p.stockNor : 'OK') : null;
        const se = p.stockExpr > 0 ? (p.stockExpr <= 7 ? p.stockExpr : 'OK') : null;
        const parts = [];
        if (sv) parts.push(`Victoria: ${sv}`);
        if (sn) parts.push(`Nordelta: ${sn}`);
        if (se) parts.push(`Express: ${se} (48/72 hs hábiles)`);
        if (parts.length) msg += `\n📦 _Stock: ${parts.join(' | ')}_`;
      }
      msg += express;
      msg += '\n';
    }
    mensajes.push(msg.trim());
  }

  if (totalVisibles > 8 && !sinLimite) {
    mensajes.push(`_...y más opciones disponibles. Filtrá por marca, ej: "${medidaOriginal} Michelin"_`);
  }

  if (!esRev) mensajes.push(PIE);
  return mensajes;
}

// --- Enviar mensajes en orden con delay ---
async function enviarSecuencial(numero, mensajes, delayMs = 700) {
  for (let i = 0; i < mensajes.length; i++) {
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${numero}`, body: mensajes[i] });
    if (i < mensajes.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }
}

// --- Sistema de prompt para Claude ---
const SISTEMA = `Sos el asistente de Neumáticos Gallo por WhatsApp. Pasás precios. Nada más.

═══ REGLA ABSOLUTA ═══
Cada vez que detectes una medida de neumático en el mensaje, respondé ÚNICAMENTE con:
BUSCAR_MEDIDA:XXX/XXRXX
Cero texto antes. Cero texto después. Solo esa línea.

═══ FLUJO ═══
• Cliente saluda sin medida → "Hola! ¿Qué medida necesitás?" (nada más)
• Cliente da la medida → BUSCAR_MEDIDA:medida (el sistema muestra los precios)
• Después de los precios, si preguntan por una marca específica → BUSCAR_MEDIDA:medida marca
• Después de los precios, si piden "la más barata" / "la más cara" / "solo Michelin" etc → BUSCAR_MEDIDA:medida [marca o vacío]
• Después de los precios, si piden "ver más", "mostrame más", "las otras opciones", "el resto" → BUSCAR_MEDIDA:ultima_medida_buscada (sin marca)
• Después de los precios, si preguntan sobre una sucursal → dar dirección y teléfono

═══ PROHIBIDO ═══
✗ Nunca preguntes modelo de auto, uso, preferencias antes de mostrar precios
✗ Nunca listes marcas disponibles ni describas marcas antes de mostrar precios
✗ Nunca inventes precios ni describas productos — los precios vienen del sistema
✗ Nunca listes "opciones restantes" ni inventes productos extras — si piden ver más, usá BUSCAR_MEDIDA
✗ Nunca escribas BUSCAR_MEDIDA dentro de un párrafo largo
✗ Nunca des información de marcas que el cliente no pidió

═══ POST-PRECIO (solo si ya se mostraron precios) ═══
Si preguntan por qué elegir una marca, respondé en 1-2 líneas máximo:
- Michelin: mayor duración y frenado, N°1 del mundo
- Continental: alemana, equipo original BMW/Mercedes
- Yokohama: japonesa, andar suave, gran calidad
- Dunlop: japonesa, durable, equipo original Toyota/Hilux
- BFGoodrich: mejor para 4x4/camionetas, grupo Michelin
- GTRadial/Giti: top 10 mundial, precio-calidad
- Nexen/Hankook: coreanas premium, equipo original BMW/Hyundai
- Tracmax: económica de buena calidad, representada por Gallo
- Linglong/Westlake: opciones económicas confiables

SUCURSALES (solo si preguntan):
- Victoria: Pres. Perón 3479 | 11-3773-5246 | Lun-Vie 8-19, Sáb 8-16
- Nordelta: Agustín García 6318, Tigre | 11-5734-7692 | Lun-Vie 8-19, Sáb 8-16

PRECIOS: Son SIEMPRE por unidad (1 neumático). Si alguien pregunta "¿es por las 4?", respondé: "No, el precio es por unidad. Para 4 neumáticos multiplicá por 4."

STOCK EXPRESS: Significa que el neumático se pide especialmente al importador para ese cliente. Se retira en nuestras sucursales (o enviamos al interior si corresponde). El plazo es 48 a 72 horas hábiles desde la seña. No es envío a domicilio.

SERVICIOS (si preguntan por mecánica, frenos, amortiguadores, baterías, etc.):
También hacemos: frenos, amortiguadores, tren delantero, baterías, escobillas, antirrobos/bujes de seguridad y más. Si alguien pregunta por esto, respondé: "Sí, hacemos ese servicio! Contactá a la sucursal que te quede más cerca."

FOTOS: Si piden fotos, deciles "¡Claro! En un momento te mando una foto." — el sistema las busca automáticamente.

Respondé en español argentino. Sin emojis excesivos. Máximo 3 líneas por respuesta salvo que sean precios.`;

async function respuestaClaude(historial, mensajeActual) {
  const messages = historial.map(m => ({
    role: m.rol === 'cliente' ? 'user' : 'assistant',
    content: m.texto,
  }));
  messages.push({ role: 'user', content: mensajeActual });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: SISTEMA,
    messages,
  });
  return response.content[0].text;
}

// --- Webhook principal ---
// --- Info de marcas ---
function infoDeMarca(marca) {
  const m = marca.toLowerCase();
  const info = {
    michelin: '🥇 *Michelin* es la marca N°1 del mundo. Líder en frenado y agarre en lluvia, y mayor duración. Sus modelos principales:\n• *Pilot Sport 4/5*: alto rendimiento deportivo\n• *Primacy 4/5*: confort y seguridad en ruta\n• *Energy XM2+*: autos compactos, excelente duración\n• *LTX Trail / LTX Force*: pickups y camionetas, uso mixto\n• *Primacy SUV / SUV+*: SUVs, suave y silenciosa',
    continental: '🏆 *Continental* es uno de los principales fabricantes europeos, marca alemana con una historia de más de 150 años. Suele ser equipo original de BMW y Mercedes-Benz. Excelente tecnología en seguridad y confort.',
    yokohama: '🇯🇵 *Yokohama* es una marca japonesa de altísima calidad. Se destaca por su andar suave y excelentes prestaciones. Modelos:\n• *BluEarth ES32*: autos compactos\n• *AE51/AE61*: autos medianos y SUVs\n• *ADVAN V701*: alto rendimiento\n• *Geolandar G015*: camioneta mixta, 3PMSF (apta nieve)\n• *Geolandar G016*: tipo Rugged Terrain',
    dunlop: '🏎️ *Dunlop* es marca japonesa similar a Yokohama, con algo más de duración. Es equipo original de Toyota en casi todos sus modelos. Modelos:\n• *Touring R1*: compactos\n• *FM800*: medianos y SUVs\n• *Sportmaxx*: alto rendimiento\n• *Grandtrek PT3/PT5*: camioneta ruta\n• *AT5/AT20/AT25*: mixtas, equipo original Hilux y SW4',
    bfgoodrich: '🛻 *BFGoodrich* pertenece al Grupo Michelin. La marca más reconocida en 4x4 y camionetas. Modelos:\n• *Trail Terrain*: AT suave\n• *AT KO2*: All Terrain super probada, robusta\n• *Mud Terrain*: uso en barro\n• *HD Terrain*: Heavy Duty, máxima resistencia',
    giti: '🔬 *Giti* tiene sede en Singapur, laboratorios en Alemania y fábricas de alta tecnología. Top 10 mundial en crecimiento. Equipo original de Ford Territory, Peugeot 2008/3008/5008, VW Polo, BYD, Chery y más.',
    gtradial: '⚙️ *GTRadial* es del grupo Giti, excelente opción precio-calidad para camionetas. Modelos:\n• *AT/HT*: confiables para trabajo\n• *AT70*: muy buen desempeño en tierra y barro\n• *AT71/HT71*: equipo original pickups BYD Shark\n• *XT71*: Rugged Terrain, muy llamativa\n• *AT200*: próximamente, prestaciones tipo BFGoodrich AT',
    nexen: '🇰🇷 *Nexen* es marca coreana de altísima calidad, equipo original de BMW, Hyundai y Kia. Prestaciones premium a precio menor.',
    hankook: '🇰🇷 *Hankook* también coreana, equipo original de BMW y Hyundai. Gran reconocimiento mundial y prestaciones de primer nivel.',
    falken: '🏔️ *Falken* es la marca de camioneta y 4x4 del grupo Dunlop. Muy popular en EEUU, enfocada en off-road y competición.',
    tracmax: '💡 *Tracmax* es nuestra marca económica representada. Excelente calidad para el segmento económico, fabricada en planta 4.0 (alta robotización). Muy buen balanceo y confiabilidad.',
    linglong: '🇨🇳 *Linglong* es una de las empresas chinas más importantes. Equipo original de VW Polo Track, Chevrolet Spark y VW Tera.',
    westlake: '💰 *Westlake* es una opción económica confiable del mercado.',
  };
  return info[m] || null;
}

// --- Detectar sucursal mencionada ---
function detectarSucursal(texto) {
  const lower = texto.toLowerCase();
  if (lower.includes('victoria') || lower.includes('vic')) return 'victoria';
  if (lower.includes('nordelta') || lower.includes('tigre') || lower.includes('nord')) return 'nordelta';
  return null;
}

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();
  const fromNumber = (req.body.From || '').replace('whatsapp:', '');
  const numMedia = parseInt(req.body.NumMedia || '0');
  const mediaType = (req.body.MediaContentType0 || '').toLowerCase();
  console.log('Mensaje recibido:', body);

  // Registrar mensaje en sesión
  registrarMensajeSesion(fromNumber, 'cliente', body || '[media]');

  // Mensaje sin texto (audio, imagen, video, sticker, documento)
  if (!body && numMedia === 0 && !req.body.Latitude) {
    // sticker u otro tipo sin media reportada — ignorar silenciosamente
    return res.status(200).end();
  }
  if (!body && (numMedia > 0 || mediaType)) {
    let tipoMsg = 'ese archivo';
    if (mediaType.startsWith('audio')) tipoMsg = 'audios';
    else if (mediaType.startsWith('image')) tipoMsg = 'imágenes';
    else if (mediaType.startsWith('video')) tipoMsg = 'videos';
    const msg = `Hola! Por el momento solo puedo leer mensajes de texto. No puedo escuchar ${tipoMsg}.\n\n¿Qué medida de neumático necesitás? (ej: 205/55R16)`;
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
    registrarMensajeSesion(fromNumber, 'bot', msg);
    guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
    return res.status(200).end();
  }

  // Detectar pedido de atención humana
  if (/hablar|persona|alguien|humano|asesor|vendedor/i.test(lower)) {
    guardarAlerta(fromNumber, body).catch(() => {});
    const msg = `Te pasamos los contactos de nuestras sucursales para que te atiendan:\n\n${WA_SUCURSALES}`;
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
    registrarMensajeSesion(fromNumber, 'bot', msg);
    guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
    return res.status(200).end();
  }

  // Detectar consultas de servicios mecánicos → alertar y dar links directos
  const esMecanica = /freno|pastilla|disco de freno|amortiguador|buje|tren delantero|direcci[oó]n|suspensi[oó]n|batería|bateria|escobilla|limpiaparabrisas|antirrobo|bul[oó]n|tuerca de seguridad|reparaci[oó]n|taller|cambio de aceite|alineaci[oó]n|balanceo/i.test(body);
  if (esMecanica) {
    guardarAlerta(fromNumber, body).catch(() => {});
    const msg = `Sí, hacemos ese servicio! 🔧 Contactá directamente a la sucursal que te quede más cerca:\n\n${WA_SUCURSALES}`;
    await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
    registrarMensajeSesion(fromNumber, 'bot', msg);
    guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
    return res.status(200).end();
  }

  try {
    const bodyLower = body.toLowerCase();
    const pideMostrador = /\bmostrador\b/i.test(bodyLower);
    const esRev = pideMostrador ? false : await esRevendedor(fromNumber);

    // Detección directa de medida ANTES de llamar a Claude
    const medidaDirecta = normalizarMedida(body);

    // Si no hay medida en el mensaje actual, buscar la última medida consultada en la sesión
    // para manejar filtros de marca post-precio ("quiero Yokohama", "la más barata", etc.)
    const sesionActual = sesiones.get(fromNumber) || { mensajes: [], productosExtra: [], ultimaMedida: null, pendingTimeout: null };
    let medidaContexto = null;
    if (!medidaDirecta) {
      for (let i = sesionActual.mensajes.length - 1; i >= 0; i--) {
        const m = sesionActual.mensajes[i];
        const med = normalizarMedida(m.texto);
        if (med) { medidaContexto = med; break; }
      }
    }

    // Si el cliente pide filtrar por marca o "la más barata/cara" y hay medida en contexto
    const pideMarca = medidaContexto && !medidaDirecta && extraerMarca(body);
    const matchMedida = medidaDirecta ? [null, medidaDirecta] : (pideMarca ? [null, medidaContexto] : null);

    // Detectar pedido de foto/imagen
    const pideFoto = /foto|imagen|pic|picture|cómo\s+(es|se\s+ve)|ver\s+(el|la|los|las)\s+(neumatico|cubierta|llanta|goma)/i.test(body);
    console.log(`pideFoto=${pideFoto} esperandoFoto=${sesionActual.esperandoFoto} ultimaMedida=${sesionActual.ultimaMedida}`);

    // Helper: enviar fotos de una lista de productos
    async function enviarFotosProductos(productosAFotografiar) {
      let enviadas = 0;
      for (const p of productosAFotografiar.slice(0, 5)) {
        if (enviadas > 0) await new Promise(r => setTimeout(r, 2500)); // delay entre búsquedas DDG
        const imgUrl = await buscarImagenNeumatico(`${p.descripcion} tire`);
        if (imgUrl) {
          await new Promise(r => setTimeout(r, 500));
          await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, mediaUrl: [imgUrl], body: p.descripcion });
          guardarMensaje(fromNumber, 'bot', `[foto: ${p.descripcion}]`).catch(() => {});
          enviadas++;
        }
      }
      if (enviadas === 0) {
        const msg = 'No encontré fotos disponibles. Podés buscarlas en Google o pedirlas en la sucursal.';
        await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
      }
    }

    // Helper: preguntar qué modelo quieren y listar opciones disponibles
    async function preguntarModeloFoto(productos) {
      const marcas = [...new Set(productos.map(p => p.marca))];
      const lista = marcas.join(', ');
      sesionActual.esperandoSeleccionFoto = true;
      const msg = `¿De cuál modelo querés la foto? Tengo disponible: ${lista}.\n_(Escribí la marca o modelo que querés ver)_`;
      await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
      guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
    }

    // Si el usuario está seleccionando qué modelo quiere ver (después de que se le preguntó)
    if (sesionActual.esperandoSeleccionFoto) {
      sesionActual.esperandoSeleccionFoto = false;
      res.status(200).end();
      ;(async () => {
        const productos = sesionActual.ultimosProductos || [];
        const bodyLow = body.toLowerCase();
        // Filtrar productos que coincidan con lo que escribió
        let seleccionados = productos.filter(p =>
          bodyLow.includes(p.marca.toLowerCase()) ||
          p.descripcion.toLowerCase().split(' ').some(w => w.length > 3 && bodyLow.includes(w))
        );
        // Si no hay match específico, mandar todos
        if (seleccionados.length === 0) seleccionados = productos;
        console.log(`[foto selección] "${body}" → ${seleccionados.length} productos`);
        await enviarFotosProductos(seleccionados);
      })().catch(e => console.error('Error enviando foto selección:', e.message));
      return;
    }

    // Si el bot había preguntado "¿de qué neumático?" (sin productos en sesión)
    if (sesionActual.esperandoFoto) {
      sesionActual.esperandoFoto = false;
      res.status(200).end();
      ;(async () => {
        const descripcionBuscar = body.trim() || sesionActual.ultimaMedida;
        const imgUrl = await buscarImagenNeumatico(`${descripcionBuscar} tire neumatico`);
        if (imgUrl) {
          await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, mediaUrl: [imgUrl], body: descripcionBuscar });
          guardarMensaje(fromNumber, 'bot', `[foto: ${descripcionBuscar}]`).catch(() => {});
        } else {
          const msg = 'No encontré una foto disponible. Podés buscar el modelo en Google o pedirla directamente en la sucursal.';
          await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
        }
      })().catch(e => console.error('Error enviando foto:', e.message));
      return;
    }

    if (pideFoto) {
      const productos = sesionActual.ultimosProductos || [];
      if (productos.length === 0) {
        // Sin productos en sesión: preguntar medida/modelo
        sesionActual.esperandoFoto = true;
        res.status(200).end();
        const msg = '¿De qué neumático querés la foto? Pasame la medida o el modelo.';
        await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
        guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
        return;
      }

      // Intentar detectar si el usuario ya especificó una marca en su mensaje
      const marcaEnMensaje = extraerMarca(body);
      const bodyLow = body.toLowerCase();
      let productosSeleccionados = marcaEnMensaje
        ? productos.filter(p => p.marca.toLowerCase() === marcaEnMensaje || p.descripcion.toLowerCase().includes(marcaEnMensaje))
        : productos.filter(p =>
            p.descripcion.toLowerCase().split(' ').some(w => w.length > 3 && bodyLow.includes(w))
          );

      if (productosSeleccionados.length > 0) {
        // Ya especificó qué quiere → mandar directamente
        res.status(200).end();
        ;(async () => {
          console.log(`[foto directa] ${productosSeleccionados.length} productos para "${body}"`);
          await enviarFotosProductos(productosSeleccionados);
        })().catch(e => console.error('Error enviando foto:', e.message));
      } else {
        // No especificó → preguntar qué modelo quieren
        res.status(200).end();
        ;(async () => {
          await preguntarModeloFoto(productos);
        })().catch(e => console.error('Error preguntando foto:', e.message));
      }
      return;
    }

    // Detectar pedido de más opciones (extra guardadas en sesión)
    const pideExtra = !esRev && (sesionActual.productosExtra || []).length > 0 &&
      /\bs[ií]\b|m[aá]s econ[oó]m|ver\s+m[aá]s|mostr[aá]?me\s+m[aá]s|las\s+dem[aá]s|el\s+resto|todas|las\s+otras|m[aá]s\s+opciones|otras\s+opciones/i.test(body);
    if (pideExtra) {
      const extra = sesionActual.productosExtra || [];
      sesionActual.productosExtra = [];
      res.status(200).end();
      registrarMensajeSesion(fromNumber, 'bot', '');
      ;(async () => {
        const headerMsg = 'Acá van más opciones:';
        await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: headerMsg });
        guardarMensaje(fromNumber, 'bot', headerMsg).catch(() => {});
        for (const p of extra) {
          await new Promise(r => setTimeout(r, 1500));
          const msg = formatearProductoWA(p);
          await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: msg });
          guardarMensaje(fromNumber, 'bot', msg).catch(() => {});
          sesionActual.mensajes?.push({ rol: 'bot', texto: msg });
        }
        await new Promise(r => setTimeout(r, 1500));
        const closing = 'Si necesitás algo más, estoy acá. 😊';
        await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: closing });
        guardarMensaje(fromNumber, 'bot', closing).catch(() => {});
      })().catch(e => console.error('Error enviando extra:', e.message));
      return;
    }

    // Detectar "ver más opciones" full (sin extra guardado) — para reventa o segunda búsqueda
    const esVerMas = !medidaDirecta && medidaContexto && /ver\s+m[aá]s|mostr[aá]?me\s+m[aá]s|las\s+dem[aá]s|el\s+resto|todas\s+las\s+opciones|las\s+otras|las\s+5|las\s+dem[aá]s\s+opciones|opciones\s+restantes|quiero\s+ver\s+todas/i.test(body);
    if (esVerMas) {
      const productos = await obtenerPrecios(medidaContexto, null, false);
      registrarConsulta(fromNumber, medidaContexto, null, productos);
      if (esRev) {
        sesionActual.ultimaMedida = medidaContexto;
        sesionActual.ultimosProductos = productos.filter(p => !MARCAS_EXCLUIDAS_REVENTA.includes(p.marca.toLowerCase()));
        const mensajes = armarMensajes(productos, medidaContexto, true, true);
        res.status(200).end();
        guardarMensajes(mensajes.map(m => [fromNumber, 'bot', m])).catch(() => {});
        mensajes.forEach(m => sesionActual.mensajes?.push({ rol: 'bot', texto: m }));
        enviarSecuencial(fromNumber, mensajes).catch(e => console.error('Error envío secuencial:', e.message));
      } else {
        res.status(200).end();
        enviarPreciosParticulares(fromNumber, productos, medidaContexto, sesionActual)
          .catch(e => console.error('Error envío precios:', e.message));
      }
      return;
    }

    if (!matchMedida) {
      // Solo llamamos a Claude si no hay medida detectada
      const sesion = sesiones.get(fromNumber) || { mensajes: [] };
      const historialPrevio = sesion.mensajes.slice(-10);
      const respuesta = await respuestaClaude(historialPrevio, body);
      console.log('Respuesta Claude:', respuesta.substring(0, 80));

      const matchClaude = respuesta.match(/BUSCAR_MEDIDA:(\S+)/);
      if (matchClaude) {
        const medidaNorm = matchClaude[1];
        const marca = extraerMarca(body);
        const pidioRunFlat = /runflat|run flat|run-flat|\brft\b|\bzp\b/i.test(body.toLowerCase());
        const pidioNieve = /\b(nieve|invierno|alpin|ice snow|x-ice|xice|agilis alpin|snow)\b/i.test(body.toLowerCase());
        const productos = await obtenerPrecios(medidaNorm, marca, pidioRunFlat, 4, pidioNieve);
        registrarConsulta(fromNumber, medidaNorm, marca, productos);
        if (esRev) {
          sesionActual.ultimaMedida = medidaNorm;
          sesionActual.ultimosProductos = productos.filter(p => !MARCAS_EXCLUIDAS_REVENTA.includes(p.marca.toLowerCase()));
          const mensajes = armarMensajes(productos, medidaNorm, true);
          res.status(200).end();
          guardarMensajes(mensajes.map(m => [fromNumber, 'bot', m])).catch(() => {});
          mensajes.forEach(m => sesionActual.mensajes?.push({ rol: 'bot', texto: m }));
          enviarSecuencial(fromNumber, mensajes).catch(e => console.error('Error envío secuencial:', e.message));
        } else {
          if (sesionActual.pendingTimeout) { clearTimeout(sesionActual.pendingTimeout); sesionActual.pendingTimeout = null; }
          const saludo = '¡Hola! Gracias por comunicarte con *Neumáticos Gallo* 😊 En seguida te pasamos los precios.';
          await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: saludo });
          guardarMensaje(fromNumber, 'bot', saludo).catch(() => {});
          sesionActual.mensajes?.push({ rol: 'bot', texto: saludo });
          res.status(200).end();
          sesionActual.pendingTimeout = setTimeout(() => {
            sesionActual.pendingTimeout = null;
            enviarPreciosParticulares(fromNumber, productos, medidaNorm, sesionActual)
              .catch(e => console.error('Error envío precios:', e.message));
          }, 30000);
        }
        return;
      } else {
        twiml.message(respuesta);
        registrarMensajeSesion(fromNumber, 'bot', respuesta);
      }

      console.log('Enviando respuesta TwiML...');
      return res.type('text/xml').send(twiml.toString());
    }

    // Medida detectada directamente
    if (matchMedida) {
      const medidaNorm = matchMedida[1];
      const marca = extraerMarca(body);
      const pidioRunFlat = /runflat|run flat|run-flat|\brft\b|\bzp\b/i.test(body.toLowerCase());
      const productos = await obtenerPrecios(medidaNorm, marca, pidioRunFlat);
      console.log('Productos encontrados:', productos.length, '| Revendedor:', esRev);
      registrarConsulta(fromNumber, medidaNorm, marca, productos);
      if (esRev) {
        sesionActual.ultimaMedida = medidaNorm;
        sesionActual.ultimosProductos = productos.filter(p => !MARCAS_EXCLUIDAS_REVENTA.includes(p.marca.toLowerCase()));
        const mensajes = armarMensajes(productos, medidaNorm, true);
        res.status(200).end();
        guardarMensajes(mensajes.map(m => [fromNumber, 'bot', m])).catch(() => {});
        mensajes.forEach(m => sesionActual.mensajes?.push({ rol: 'bot', texto: m }));
        enviarSecuencial(fromNumber, mensajes).catch(e => console.error('Error envío secuencial:', e.message));
      } else {
        if (sesionActual.pendingTimeout) { clearTimeout(sesionActual.pendingTimeout); sesionActual.pendingTimeout = null; }
        const saludo = '¡Hola! Gracias por comunicarte con *Neumáticos Gallo* 😊 En seguida te pasamos los precios.';
        await client.messages.create({ from: `whatsapp:${BOT_PHONE}`, to: `whatsapp:${fromNumber}`, body: saludo });
        guardarMensaje(fromNumber, 'bot', saludo).catch(() => {});
        sesionActual.mensajes?.push({ rol: 'bot', texto: saludo });
        res.status(200).end();
        sesionActual.pendingTimeout = setTimeout(() => {
          sesionActual.pendingTimeout = null;
          enviarPreciosParticulares(fromNumber, productos, medidaNorm, sesionActual)
            .catch(e => console.error('Error envío precios:', e.message));
        }, 30000);
      }
      return;
    } else {
      twiml.message(respuesta);
      registrarMensajeSesion(fromNumber, 'bot', respuesta);
    }
  } catch (err) {
    console.error('Error completo:', err.message, err.stack);
    twiml.message('❌ Hubo un error. Por favor intentá de nuevo en unos segundos.');
  }

  console.log('Enviando respuesta TwiML...');
  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));

// ── Reporte diario de chats — endpoint HTTP (llamado por cron-job.org) ────────
{
  const { execFile } = require('child_process');
  const path = require('path');
  const REPORTE_SECRET = process.env.REPORTE_SECRET || 'gallo2025';

  function correrReporte(fecha) {
    const args = [path.join(__dirname, 'scripts/reporte-chats.js')];
    if (fecha) args.push(fecha);
    console.log('📊 Enviando reporte diario de chats' + (fecha ? ` (${fecha})` : '') + '...');
    execFile('node', args,
      { cwd: path.join(__dirname), env: process.env },
      (err, stdout, stderr) => {
        if (stdout) console.log(stdout.trim());
        if (err) console.error('❌ Error reporte chats:\n' + (stderr || err.message));
      }
    );
  }

  app.get('/admin/reporte-diario', (req, res) => {
    const secret = req.query.secret || req.headers['x-secret'];
    if (secret !== REPORTE_SECRET) return res.status(401).json({ error: 'No autorizado' });
    const fecha = req.query.fecha || null; // opcional: DD/MM/YYYY
    correrReporte(fecha);
    res.json({ ok: true, mensaje: 'Reporte iniciado', fecha: fecha || 'ayer' });
  });

  app.get('/admin/sincronizar', (req, res) => {
    const secret = req.query.secret || req.headers['x-secret'];
    if (secret !== REPORTE_SECRET) return res.status(401).json({ error: 'No autorizado' });
    res.json({ ok: true, mensaje: 'Sync iniciado — revisá los logs de Railway' });
    const { execFile } = require('child_process');
    const path = require('path');
    const script = path.join(__dirname, 'scripts', 'sincronizar-fuentes.js');
    const child = execFile('node', [script], { cwd: __dirname });
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('exit', code => console.log(`✅ Sync finalizado (exit ${code})`));
  });

  console.log('📧 Endpoint reporte activo: GET /admin/reporte-diario?secret=...');
  console.log('🔄 Endpoint sync activo: GET /admin/sincronizar?secret=...');

  // --- Enviar seguimientos pendientes (llamado por cron-job.org cada 30 min) ---
  const respondio = require('./respondio');

  app.get('/admin/enviar-seguimientos', async (req, res) => {
    const secret = req.query.secret || req.headers['x-secret'];
    if (secret !== REPORTE_SECRET) return res.status(401).json({ error: 'No autorizado' });

    try {
      const auth = new google.auth.GoogleAuth({ credentials: GOOGLE_CREDS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });

      // Leer hoja Seguimientos (A=Fecha, B=Número, C=Medidas, D=Marcas, E=HoraProgramada, F=Estado)
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Seguimientos!A:F',
      });
      const rows = r.data.values || [];

      const ahoraArg = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const horaActual = ahoraArg.getHours();

      // Solo enviar entre 8 y 21hs Argentina
      if (horaActual < 8 || horaActual >= 21) {
        return res.json({ ok: true, mensaje: 'Fuera de horario (8-21hs)', enviados: 0 });
      }

      let enviados = 0;
      const updates = [];

      for (let i = 1; i < rows.length; i++) {
        const [fecha, numero, medidas, marcas, horaProg, estado] = rows[i];
        if (estado !== 'PENDIENTE') continue;
        if (!horaProg || !numero) continue;

        const horaProgDate = new Date(horaProg + ':00Z'); // UTC
        // horaProg está en hora Argentina (UTC-3), convertir a UTC para comparar
        const horaProgUTC = new Date(horaProgDate.getTime() + 3 * 60 * 60 * 1000);
        if (Date.now() < horaProgUTC.getTime()) continue;

        // Armar mensaje personalizado
        const medidasStr = medidas || '';
        const marcasStr = marcas || '';
        let msg = `Hola! 👋 Hace un rato consultaste precios de neumáticos`;
        if (medidasStr) msg += ` *${medidasStr}*`;
        msg += `.\n\n¿Pudiste decidirte? Si tenés alguna duda o querés reservar, estamos acá. 😊\n\n`;
        msg += `📍 *Suc. Victoria:* 11-3773-5246\n📍 *Suc. Nordelta:* 11-5734-7692`;

        let ok = false;

        // 1) Enviar desde Victoria via respond.io (template aprobado por Meta)
        try {
          await respondio.enviarSeguimiento(numero, medidasStr || 'neumáticos');
          ok = true;
          console.log(`[seguimiento] respond.io ✅ ${numero}`);
        } catch(e) {
          console.error(`[seguimiento] respond.io ❌ ${numero}:`, e.message);
        }

        // 2) Enviar también desde bot Twilio (respaldo, y para mantener hilo con el cliente)
        try {
          await client.messages.create({
            from: `whatsapp:${BOT_PHONE}`,
            to: `whatsapp:${numero}`,
            body: msg,
          });
          guardarMensaje(numero, 'bot', msg).catch(() => {});
          ok = true;
          console.log(`[seguimiento] Twilio ✅ ${numero}`);
        } catch(e) {
          console.error(`[seguimiento] Twilio ❌ ${numero}:`, e.message);
        }

        updates.push({ row: i + 1, estado: ok ? 'ENVIADO' : 'ERROR' });
        if (ok) enviados++;
        await new Promise(r => setTimeout(r, 1000));
      }

      // Marcar como ENVIADO/ERROR en la hoja
      for (const u of updates) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `Seguimientos!F${u.row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[u.estado]] },
        });
      }

      res.json({ ok: true, enviados, revisados: rows.length - 1 });
    } catch(e) {
      console.error('[seguimientos] Error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('📨 Endpoint seguimientos activo: GET /admin/enviar-seguimientos?secret=...');
}

// Exportar funciones para uso en app.js
module.exports = { obtenerPrecios, normalizarMedida };
