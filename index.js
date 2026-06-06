require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));

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
const MARCAS_PRECIO_CALIDAD = ['nexen', 'giti', 'hankook'];
const MARCAS_ECONOMICAS = ['westlake', 'tracmax', 'linglong'];
const TODAS_MARCAS = [...MARCAS_PREMIUM, ...MARCAS_PRECIO_CALIDAD, ...MARCAS_ECONOMICAS];
const MARCAS_DESCUENTO_35 = ['michelin', 'bfgoodrich'];

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
  return MARCAS_DESCUENTO_35.includes(marca.toLowerCase()) ? 0.35 : 0.28;
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
      revendedoresCache = new Set(rows.flat().map(n => n.toString().replace(/\D/g, '')));
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
    'giti': 1, 'gtradial': 1, 'nexen': 2, 'hankook': 3,
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
    const p6  = Math.round(precioRev / 6);
    const p3  = Math.round(precioRev * 0.85 / 3);
    const contado = Math.round(precioRev * 0.80);
    return `💳 12 pagos: $${fmt(precioRev)}\n💳 6 cuotas (-10%): $${fmt(Math.round(precioRev * 0.90))} — $${fmt(p6)}/cuota\n💳 3 cuotas (-15%): $${fmt(Math.round(precioRev * 0.85))} — $${fmt(p3)}/cuota\n💵 Contado (-20%): $${fmt(contado)}`;
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
      const express = p.stockExpr > 0 ? '\n⚡ _Disponible también vía Pedido Express en 48 hs hábiles_' : '';
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

  mensajes.push(PIE);
  return mensajes;
}

// --- Webhook principal ---
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();
  const fromNumber = (req.body.From || '').replace('whatsapp:', '');
  console.log('Mensaje recibido:', body);

  // Derivar a humano
  if (lower.includes('hablar') || lower.includes('humano') || lower.includes('persona') || lower.includes('alguien')) {
    twiml.message('👋 ¡Entendido! Un asesor te atenderá a la brevedad. Gracias por tu paciencia. 🙏\n\n🤖 _Bot de neumáticos_');
    return res.type('text/xml').send(twiml.toString());
  }

  // Saludo inicial
  if (lower.match(/^(hola|buenos|buenas|hi|hey|buen dia|buen día)/) && !normalizarMedida(body)) {
    twiml.message(
      '👋 ¡Hola! Soy el asistente virtual de *Neumáticos Gallo*. 🤖\n\n' +
      'Puedo consultarte precios de neumáticos. Escribime la medida que buscás, por ejemplo:\n\n' +
      '• *185/65R15*\n• *195/55R16 Michelin*\n• *205/55-16*\n\n' +
      'También podés indicar la marca si tenés preferencia.\n\n' +
      '_Para atención humana escribí *"hablar con alguien"*_'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  // Buscar medida en el mensaje
  const medidaNorm = normalizarMedida(body);
  if (!medidaNorm) {
    twiml.message(
      '🔍 No encontré una medida de neumático en tu mensaje.\n\n' +
      'Escribime la medida así:\n• *185/65R15*\n• *195/55-16*\n• *205/55R16 Michelin*\n\n' +
      '_Para atención humana escribí *"hablar con alguien"*_'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  const marca = extraerMarca(body);
  const pidioRunFlat = /runflat|run flat|run-flat|\brft\b|\bzp\b/i.test(lower);
  console.log('Medida normalizada:', medidaNorm, '| Marca:', marca, '| RunFlat:', pidioRunFlat);

  try {
    console.log('Consultando Google Sheets...');
    const [productos, esRev] = await Promise.all([
      obtenerPrecios(medidaNorm, marca, pidioRunFlat),
      esRevendedor(fromNumber),
    ]);
    console.log('Productos encontrados:', productos.length, '| Revendedor:', esRev, '| From:', fromNumber);
    const mensajes = armarMensajes(productos, medidaNorm, esRev);
    for (const m of mensajes) {
      twiml.message(m);
    }
  } catch (err) {
    console.error('Error al consultar precios:', err.message);
    twiml.message('❌ Hubo un error al consultar los precios. Por favor intentá de nuevo o escribí *"hablar con alguien"*.');
  }

  console.log('Enviando respuesta TwiML...');
  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
