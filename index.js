require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const appRouter = require('./app');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- App de presupuestos ---
app.use('/app', appRouter);

// --- Historial de conversaciones ---
// Guarda mensajes por número y cierra la sesión tras 30 min de inactividad
const sesiones = new Map(); // numero -> { mensajes: [], timer, inicio }
const INACTIVIDAD_MS = 2 * 60 * 1000; // 2 minutos (testing)

function registrarMensajeSesion(numero, rol, texto) {
  if (!sesiones.has(numero)) {
    sesiones.set(numero, {
      mensajes: [],
      timer: null,
      inicio: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
  }
  const sesion = sesiones.get(numero);
  sesion.mensajes.push({ rol, texto });

  // Persistir mensaje en Google Sheets (fire & forget)
  guardarMensaje(numero, rol, texto).catch(() => {});

  // Reiniciar timer de inactividad
  if (sesion.timer) clearTimeout(sesion.timer);
  sesion.timer = setTimeout(() => cerrarSesion(numero), INACTIVIDAD_MS);
}

async function guardarAlerta(numero, mensaje) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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

async function cerrarSesion(numero) {
  const sesion = sesiones.get(numero);
  if (!sesion) return;
  sesiones.delete(numero);

  if (sesion.mensajes.length === 0) return;

  // Generar resumen de la conversación
  const resumen = generarResumen(sesion.mensajes, sesion.inicio);
  await guardarResumenSesion(numero, sesion.inicio, resumen);
  console.log('Sesión cerrada para', numero, '| Resumen guardado');
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
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
// Acepta: 185/65R15, 185-65-15, 185/65-15, 18565r15, 205 55 16, 2055516, etc.
function normalizarMedida(texto) {
  const t = texto.replace(/\s+/g, ' ').trim();

  // Formato con separadores: 205/55R16, 205-55-16, 205/55 16, 205 55 r16, etc.
  const m1 = t.match(/(\d{3})\s*[\/\-\s]\s*(\d{2})\s*[rR\/\-\s]\s*(\d{2})\b/);
  if (m1) return `${m1[1]}/${m1[2]}R${m1[3]}`;

  // Sin separadores: 2055516, 20555r16, 20555R16
  const m2 = t.match(/(\d{3})(\d{2})[rR]?(\d{2})\b/);
  if (m2) return `${m2[1]}/${m2[2]}R${m2[3]}`;

  return null;
}

// --- Extraer marca del texto ---
const MARCAS_PREMIUM = ['michelin', 'continental', 'dunlop', 'yokohama', 'bfgoodrich'];
const MARCAS_PRECIO_CALIDAD = ['gtradial', 'giti', 'nexen', 'falken', 'hankook'];
const MARCAS_ECONOMICAS = ['westlake', 'tracmax', 'linglong'];
const TODAS_MARCAS = [...MARCAS_PREMIUM, ...MARCAS_PRECIO_CALIDAD, ...MARCAS_ECONOMICAS];


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
  if (['yokohama', 'nexen'].includes(m)) return 0.32;
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
      const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
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
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
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
async function obtenerPrecios(medida, marca, incluirRunFlat = false) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Bot WhatsApp!A:K',
  });

  const rows = res.data.values || [];
  const resultados = [];

  for (const row of rows.slice(1)) {
    const rowDesc    = row[2] || '';  // C
    const rowMarca   = row[3] || '';  // D
    const rowModelo  = row[4] || '';  // E
    const rowMedida  = row[5] || '';  // F
    const stockVic   = row[6] || '0'; // G
    const stockNor   = row[7] || '0'; // H
    const stockExpr  = row[8] || '0'; // I
    const rowPrecio  = row[9] || '';  // J
    const rowPromo   = row[10] || ''; // K

    if (!rowMarca || !rowMedida || !rowPrecio) continue;

    const coincideMedida = normalizarMedida(rowMedida) === medida;
    const coincideMarca = marca ? rowMarca.toLowerCase().includes(marca) : true;

    const sVic  = parseInt(stockVic.toString().replace(/\D/g, '')) || 0;
    const sNor  = parseInt(stockNor.toString().replace(/\D/g, '')) || 0;
    const sExpr = parseInt(stockExpr.toString().replace(/\D/g, '')) || 0;
    const stockTotal = sVic + sNor + sExpr;

    // Excluir run flat salvo que el cliente los pida explícitamente
    const esRunFlat = /runflat|run flat|run-flat|\bRFT\b|\bZP\b/i.test(rowDesc);
    if (esRunFlat && !incluirRunFlat) continue;

    // Solo mostrar productos con 4 o más unidades en stock
    if (coincideMedida && coincideMarca && stockTotal >= 4) {
      resultados.push({
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

  // Orden: categoría → marca preferida primero → stock total desc
  const ORDEN_MARCA = {
    'michelin': 1, 'yokohama': 2, 'continental': 3, 'dunlop': 4, 'bfgoodrich': 5,
    'gtradial': 1, 'giti': 2, 'nexen': 3, 'falken': 4, 'hankook': 5,
    'tracmax': 1, 'linglong': 2, 'westlake': 3,
  };

  return resultados.sort((a, b) => {
    const { orden: oA } = categoriaYEmoji(a.marca);
    const { orden: oB } = categoriaYEmoji(b.marca);
    if (oA !== oB) return oA - oB;
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

const PIE = `📌 *Precio unitario. Promociones por compra de 2 o más neumáticos.*
🔧 Colocación sin cargo en nuestros locales. Válvulas, balanceo y alineación se cobran aparte.
⚡ Stock Express disponible en 48 hs hábiles.
🌐 Compra online: tienda.neumaticosgallo.com.ar (6 pagos o contado -20%, envíos a todo el país sin cargo superando mínimo de compra)

📍 *Suc. Victoria:* Pres. Perón 3479 — ☎️ 11-3773-5246
📍 *Suc. Nordelta:* Agustín García 6318, Tigre — ☎️ 11-5734-7692
🕐 Lun-Vie 8 a 19 hs | Sáb 8 a 16 hs

🤖 _Soy un bot. Escribí *"hablar con alguien"* para atención humana._`;

// --- Armar lista de mensajes (uno por categoría) ---
function armarMensajes(productos, medidaOriginal, esRev = false) {
  if (productos.length === 0) {
    return [`No encontré neumáticos *${medidaOriginal}* con stock disponible.\n\nEscribí "hablar con alguien" para consultar disponibilidad. 🙋`];
  }

  const mensajes = [];
  const total = productos.length;

  // Encabezado
  const headerExtra = esRev ? ' _(precios de revendedor)_' : '';
  mensajes.push(`🔍 *${medidaOriginal}* — ${total} opción${total > 1 ? 'es' : ''} con stock disponible${headerExtra}:`);

  // Agrupar por categoría — máx 3 por categoría para no saturar
  const grupos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of productos) {
    const { orden } = categoriaYEmoji(p.marca);
    if (grupos[orden].length < 3) grupos[orden].push(p);
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
      const express = p.stockExpr > 0
        ? (tienePropio
            ? '\n⚡ _Disponible también vía Pedido Express — entrega en 48 hs hábiles_'
            : '\n⚡ _Solo disponible vía Pedido Express — entrega en 48 hs hábiles (no en stock en local)_')
        : '';
      msg += `\n🔹 *${p.descripcion}*\n`;
      msg += preciosProducto(p.precio, esRev, p.marca);
      if (p.promocion && !esRev && p.promocion.trim()) {
        msg += `\n🏷️ _Promo: ${p.promocion} (presencial, 2+ neumáticos)_`;
      }
      msg += express;
      msg += '\n';
    }
    mensajes.push(msg.trim());
  }

  if (total > 8) {
    mensajes.push(`_...y ${total - 8} opciones más. Filtrá por marca, ej: "${medidaOriginal} Michelin"_`);
  }

  if (!esRev) mensajes.push(PIE);
  return mensajes;
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
• Después de los precios, si preguntan sobre una sucursal → dar dirección y teléfono

═══ PROHIBIDO ═══
✗ Nunca preguntes modelo de auto, uso, preferencias antes de mostrar precios
✗ Nunca listes marcas disponibles ni describas marcas antes de mostrar precios
✗ Nunca inventes precios ni describas productos — los precios vienen del sistema
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
  console.log('Mensaje recibido:', body);

  // Registrar mensaje en sesión
  registrarMensajeSesion(fromNumber, 'cliente', body);

  // Detectar pedido de ayuda humana
  if (/hablar|persona|alguien|humano|asesor|vendedor|ayuda/i.test(lower)) {
    guardarAlerta(fromNumber, body).catch(() => {});
  }

  try {
    const esRev = await esRevendedor(fromNumber);

    // Detección directa de medida ANTES de llamar a Claude
    const medidaDirecta = normalizarMedida(body);

    // Si no hay medida en el mensaje actual, buscar la última medida consultada en la sesión
    // para manejar filtros de marca post-precio ("quiero Yokohama", "la más barata", etc.)
    const sesionActual = sesiones.get(fromNumber) || { mensajes: [] };
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
        const productos = await obtenerPrecios(medidaNorm, marca, pidioRunFlat);
        registrarConsulta(fromNumber, medidaNorm, marca, productos);
        const mensajes = armarMensajes(productos, medidaNorm, esRev);
        const todosBot = [...mensajes];
        if (!esRev && productos.length > 0)
          todosBot.push('¿Te puedo ayudar con algo más? 😊\n\n¿Cuál sucursal te queda más cómoda?\n• *Victoria* — wa.me/541137735246\n• *Nordelta* — wa.me/541157347692\n\nColocación *sin cargo* en ambas sucursales. 🔧');
        todosBot.forEach(m => twiml.message(m));
        guardarMensajes(todosBot.map(m => [fromNumber, 'bot', m])).catch(() => {});
        todosBot.forEach(m => sesionActual.mensajes?.push({ rol: 'bot', texto: m }));
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
      const mensajes = armarMensajes(productos, medidaNorm, esRev);
      const todosBot = [...mensajes];
      if (!esRev && productos.length > 0)
        todosBot.push('¿Te puedo ayudar con algo más? 😊\n\n¿Cuál sucursal te queda más cómoda?\n• *Victoria* — wa.me/541137735246\n• *Nordelta* — wa.me/541157347692\n\nColocación *sin cargo* en ambas sucursales. 🔧');
      todosBot.forEach(m => twiml.message(m));
      guardarMensajes(todosBot.map(m => [fromNumber, 'bot', m])).catch(() => {});
      todosBot.forEach(m => sesionActual.mensajes?.push({ rol: 'bot', texto: m }));
    } else {
      twiml.message(respuesta);
      registrarMensajeSesion(fromNumber, 'bot', respuesta);
    }
  } catch (err) {
    console.error('Error:', err.message);
    twiml.message('❌ Hubo un error. Por favor intentá de nuevo o escribí *"hablar con alguien"*.');
  }

  console.log('Enviando respuesta TwiML...');
  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));

// Exportar funciones para uso en app.js
module.exports = { obtenerPrecios, normalizarMedida };
