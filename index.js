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

    const sVic  = parseInt(stockVic.toString().replace(/\D/g, '')) || 0;
    const sNor  = parseInt(stockNor.toString().replace(/\D/g, '')) || 0;
    const sExpr = parseInt(stockExpr.toString().replace(/\D/g, '')) || 0;
    const stockTotal = sVic + sNor + sExpr;

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
      });
    }
  }

  return resultados.sort((a, b) => {
    const { orden: oA } = categoriaYEmoji(a.marca);
    const { orden: oB } = categoriaYEmoji(b.marca);
    if (oA !== oB) return oA - oB;
    return b.precio - a.precio;
  });
}

// --- Formatear precio con puntos ---
function fmt(n) {
  return n.toLocaleString('es-AR');
}

// --- Armar bloque de precios para un producto ---
function preciosProducto(precio) {
  const p6  = Math.round(precio / 6);
  const p3  = Math.round(precio * 0.85 / 3);
  const contado = Math.round(precio * 0.80);
  return `💳 12 pagos: $${fmt(precio)}\n💳 6 cuotas (-10%): $${fmt(Math.round(precio * 0.90))} — $${fmt(p6)}/cuota\n💳 3 cuotas (-15%): $${fmt(Math.round(precio * 0.85))} — $${fmt(p3)}/cuota\n💵 Contado (-20%): $${fmt(contado)}`;
}

const PIE = `📌 *Precio unitario. Promociones por compra de 2 o más neumáticos.*
🔧 Colocación sin cargo en nuestros locales. Válvulas, balanceo y alineación se cobran aparte.
🌐 Compra online: tienda.neumaticosgallo.com.ar (6 pagos o contado -20%, envíos a todo el país sin cargo superando mínimo de compra)

📍 *Suc. Victoria:* Pres. Perón 3479 — ☎️ 11-3773-5246
📍 *Suc. Nordelta:* Agustín García 6318, Tigre — ☎️ 11-5734-7692
🕐 Lun-Vie 8 a 19 hs | Sáb 8 a 16 hs

🤖 _Soy un bot. Escribí *"hablar con alguien"* para atención humana._`;

// --- Armar lista de mensajes de precios (uno por producto) ---
function armarMensajes(productos, medidaOriginal) {
  if (productos.length === 0) {
    return [`No encontré neumáticos *${medidaOriginal}* con stock disponible.\n\nEscribí "hablar con alguien" para consultar disponibilidad. 🙋`];
  }

  const mensajes = [];
  const total = productos.length;
  const mostrados = Math.min(total, 6);

  mensajes.push(`🔍 *${medidaOriginal}* — ${total} opción${total > 1 ? 'es' : ''} con stock (mostrando ${mostrados}, mayor a menor precio):\n\n⭐ Premium: Michelin, Continental, Dunlop, Yokohama\n✅ Precio-calidad: Nexen, Giti, Hankook\n💰 Económicas: Westlake, Tracmax, Linglong`);

  for (const p of productos.slice(0, 6)) {
    const { cat } = categoriaYEmoji(p.marca);
    const stockLineas = [];
    if (p.stockVic > 0)  stockLineas.push(`Victoria: ${p.stockVic}`);
    if (p.stockNor > 0)  stockLineas.push(`Nordelta: ${p.stockNor}`);
    if (p.stockExpr > 0) stockLineas.push(`Express 48hs: ${p.stockExpr}`);
    const stockTexto = stockLineas.join(' | ');

    let msg = `${cat}\n*${p.descripcion}*\n\n`;
    msg += preciosProducto(p.precio);
    if (p.promocion) {
      msg += `\n🏷️ _Promo: ${p.promocion} (presencial, 2+ neumáticos)_`;
    }
    mensajes.push(msg);
  }

  if (total > 6) {
    mensajes.push(`_...y ${total - 6} opciones más. Filtrá por marca, ej: "${medidaOriginal} Michelin"_`);
  }

  mensajes.push(PIE);
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
