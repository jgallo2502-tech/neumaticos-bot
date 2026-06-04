require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));

// --- Normalizar medida de neumático ---
// Acepta: 185/65R15, 185-65-15, 185/65-15, 18565r15, etc.
function normalizarMedida(texto) {
  // Extraer números del patrón de medida
  const match = texto.match(/(\d{3})\s*[\/\-]\s*(\d{2})\s*[rR\-\/]\s*(\d{2})/);
  if (match) {
    return `${match[1]}/${match[2]}R${match[3]}`;
  }
  return null;
}

// --- Extraer marca del texto ---
const MARCAS_PREMIUM = ['michelin', 'continental', 'dunlop', 'yokohama'];
const MARCAS_PRECIO_CALIDAD = ['nexen', 'giti', 'hankook'];
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

// --- Leer Google Sheets ---
// Columnas: A=Cod.Art | B=Cod.Alt | C=Descripción | D=Marca | E=Modelo | F=Medida
//           G=Victoria | H=Nordelta | I=Pedido Express 48hs | J=Precio | K=Promoción
async function obtenerPrecios(medida, marca) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'A:K',
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

    if (coincideMedida && coincideMarca) {
      resultados.push({
        descripcion: rowDesc,
        marca: rowMarca,
        modelo: rowModelo,
        medida: rowMedida,
        precio: parseInt(rowPrecio.toString().replace(/\D/g, '')),
        promocion: rowPromo,
        stockVic: parseInt(stockVic.toString().replace(/\D/g, '')) || 0,
        stockNor: parseInt(stockNor.toString().replace(/\D/g, '')) || 0,
        stockExpr: parseInt(stockExpr.toString().replace(/\D/g, '')) || 0,
      });
    }
  }

  return resultados.sort((a, b) => b.precio - a.precio);
}

// --- Formatear precio con puntos ---
function fmt(n) {
  return n.toLocaleString('es-AR');
}

// --- Calcular info de promoción ---
function calcularPromo(precio, promoTexto) {
  const lines = [];
  const lower = promoTexto.toLowerCase();

  // Contado con 20% de descuento
  const precioContado = Math.round(precio * 0.80);
  lines.push(`💵 Contado (20% off): $${fmt(precioContado)}`);

  // Cuotas sin interés
  const matchCuotas = lower.match(/(\d+)\s*cuotas?\s*sin\s*inter[eé]s/);
  if (matchCuotas) {
    const cuotas = parseInt(matchCuotas[1]);
    const valorCuota = Math.round(precio / cuotas);
    lines.push(`💳 ${cuotas} cuotas sin interés: $${fmt(valorCuota)}/cuota (total $${fmt(precio)})`);
  }

  // Otras promos especiales
  const otrasPromos = promoTexto.replace(/\d+\s*cuotas?\s*sin\s*inter[eé]s/gi, '').trim();
  if (otrasPromos && otrasPromos.length > 2) {
    lines.push(`🏷️ Promo: ${otrasPromos}`);
  }

  return lines.join('\n');
}

// --- Armar respuesta de precios ---
function armarRespuesta(productos, medidaOriginal) {
  if (productos.length === 0) {
    return `No encontré neumáticos para la medida *${medidaOriginal}* en este momento.\n\nPodés consultar disponibilidad escribiendo "hablar con alguien" y te atendemos a la brevedad. 🙋`;
  }

  // Limitar a 8 productos para no exceder límite de WhatsApp
  const productosLimitados = productos.slice(0, 8);

  // Agrupar por categoría
  const grupos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of productosLimitados) {
    const { cat, orden } = categoriaYEmoji(p.marca);
    grupos[orden].push({ ...p, cat });
  }

  let msg = `🔍 Resultados para medida *${medidaOriginal}*:\n`;
  msg += `━━━━━━━━━━━━━━━━━━━\n`;

  const nombresGrupo = {
    1: '⭐ *PREMIUM*',
    2: '✅ *PRECIO-CALIDAD*',
    3: '💰 *ECONÓMICAS*',
    4: '📦 *OTRAS*',
  };

  for (const orden of [1, 2, 3, 4]) {
    if (grupos[orden].length === 0) continue;
    msg += `\n${nombresGrupo[orden]}\n`;
    for (const p of grupos[orden]) {
      const stockLineas = [];
      if (p.stockVic > 0)  stockLineas.push(`Victoria: ${p.stockVic}`);
      if (p.stockNor > 0)  stockLineas.push(`Nordelta: ${p.stockNor}`);
      if (p.stockExpr > 0) stockLineas.push(`Pedido Express 48hs: ${p.stockExpr}`);
      const stockTexto = stockLineas.length > 0 ? stockLineas.join(' | ') : '⚠️ Sin stock en depósito';

      msg += `\n🔹 *${p.descripcion}*\n`;
      msg += `   📦 Stock: ${stockTexto}\n`;
      msg += `   Precio lista (6 cuotas): $${fmt(p.precio)}\n`;
      if (p.promocion) {
        msg += calcularPromo(p.precio, p.promocion) + '\n';
        msg += `   ⚠️ _Promos válidas solo presencialmente_\n`;
      } else {
        const contado = Math.round(p.precio * 0.80);
        msg += `   💵 Contado (20% off): $${fmt(contado)}\n`;
      }
    }
  }

  if (productos.length > 8) {
    msg += `\n_...y ${productos.length - 8} opciones más. Escribí una marca para filtrar (ej: "185/65R15 Michelin")_\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📌 *Precio unitario. Colocación sin cargo.*\n`;
  msg += `📌 Alineación, balanceo y válvulas se cobran aparte.\n`;
  msg += `🌐 Envíos sin cargo superando el mínimo de compra (precio de lista vigente + 20% desc. contado).\n`;
  msg += `   👉 Pedidos por envío: *[tu web aquí]*\n`;
  msg += `\n🤖 _Soy un bot. Si necesitás atención personalizada escribí_ *"hablar con alguien"*`;

  return msg;
}

// --- Webhook principal ---
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();
  console.log('Mensaje recibido:', body);

  // Derivar a humano
  if (lower.includes('hablar') || lower.includes('humano') || lower.includes('persona') || lower.includes('alguien')) {
    twiml.message('👋 ¡Entendido! Un asesor te atenderá a la brevedad. Gracias por tu paciencia. 🙏\n\n🤖 _Bot de neumáticos_');
    return res.type('text/xml').send(twiml.toString());
  }

  // Saludo inicial
  if (lower.match(/^(hola|buenos|buenas|hi|hey|buen dia|buen día)/) && !normalizarMedida(body)) {
    twiml.message(
      '👋 ¡Hola! Soy el asistente virtual de *[Tu Neumáticos]*. 🤖\n\n' +
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
  console.log('Medida normalizada:', medidaNorm, '| Marca:', marca);

  try {
    console.log('Consultando Google Sheets...');
    const productos = await obtenerPrecios(medidaNorm, marca);
    console.log('Productos encontrados:', productos.length);
    twiml.message(armarRespuesta(productos, medidaNorm));
  } catch (err) {
    console.error('Error al consultar precios:', err.message);
    twiml.message('❌ Hubo un error al consultar los precios. Por favor intentá de nuevo o escribí *"hablar con alguien"*.');
  }

  console.log('Enviando respuesta TwiML...');
  res.type('text/xml').send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
