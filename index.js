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

// --- Armar lista de mensajes de precios (uno por producto) ---
function armarMensajes(productos, medidaOriginal) {
  if (productos.length === 0) {
    return [`No encontré neumáticos para la medida *${medidaOriginal}* en este momento.\n\nEscribí "hablar con alguien" y te atendemos a la brevedad. 🙋`];
  }

  const mensajes = [];

  // Encabezado
  const total = productos.length;
  const mostrados = Math.min(total, 6);
  mensajes.push(`🔍 *${medidaOriginal}* — ${total} opciones encontradas (mostrando ${mostrados} por precio):\n\n⭐ Premium: Michelin, Continental, Dunlop, Yokohama\n✅ Precio-calidad: Nexen, Giti, Hankook\n💰 Económicas: Westlake, Tracmax, Linglong`);

  // Un mensaje por producto (máximo 6)
  for (const p of productos.slice(0, 6)) {
    const { cat } = categoriaYEmoji(p.marca);
    const stockLineas = [];
    if (p.stockVic > 0)  stockLineas.push(`Victoria: ${p.stockVic}`);
    if (p.stockNor > 0)  stockLineas.push(`Nordelta: ${p.stockNor}`);
    if (p.stockExpr > 0) stockLineas.push(`Express 48hs: ${p.stockExpr}`);
    const stockTexto = stockLineas.length > 0 ? stockLineas.join(' | ') : 'Sin stock en depósito';

    const contado = Math.round(p.precio * 0.80);
    let msg = `${cat}\n*${p.descripcion}*\n`;
    msg += `📦 ${stockTexto}\n`;
    msg += `💳 Lista 6 cuotas: $${fmt(p.precio)}\n`;
    msg += `💵 Contado -20%: $${fmt(contado)}`;
    if (p.promocion) {
      const matchCuotas = p.promocion.toLowerCase().match(/(\d+)\s*cuotas?\s*sin\s*inter[eé]s/);
      if (matchCuotas) {
        const cuotas = parseInt(matchCuotas[1]);
        msg += `\n💳 ${cuotas} cuotas s/i: $${fmt(Math.round(p.precio / cuotas))}/cuota`;
      }
      msg += `\n🏷️ ${p.promocion} _(solo presencial)_`;
    }
    mensajes.push(msg);
  }

  if (total > 6) {
    mensajes.push(`_...y ${total - 6} opciones más. Filtrá por marca, ej: "185/65R15 Michelin"_`);
  }

  // Pie
  mensajes.push(`📌 Precio unitario. Colocación sin cargo.\nAlineación, balanceo y válvulas se cobran aparte.\n🌐 Envíos sin cargo superando el mínimo (pedidos: tu-web.com)\n\n🤖 _Bot de neumáticos — escribí *"hablar con alguien"* para atención humana_`);

  return mensajes;
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
    const mensajes = armarMensajes(productos, medidaNorm);
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
