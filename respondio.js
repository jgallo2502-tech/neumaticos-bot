const https = require('https');

const BASE = 'api.respond.io';
const TOKEN = process.env.RESPOND_IO_API_KEY;
const CHANNEL_ID = parseInt(process.env.RESPOND_IO_CHANNEL_ID || '547132');
const TEMPLATE_NAME = 'seguimiento_neumaticos';
const TEMPLATE_LANG = 'es_AR';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: BASE,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(out) }); }
        catch(e) { resolve({ status: res.statusCode, data: out }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Busca contacto por teléfono. Devuelve el id o null.
async function buscarContacto(phone) {
  // phone sin +, ej: "5491137735246"
  const r = await request('GET', `/v2/contact/phone:+${phone}`);
  if (r.status === 200 && r.data?.id) return r.data.id;
  return null;
}

// Crea contacto. Devuelve el id o null.
async function crearContacto(phone) {
  const r = await request('POST', '/v2/contact', { phone: `+${phone}` });
  if ((r.status === 200 || r.status === 201) && r.data?.id) return r.data.id;
  console.error('[respondio] Error creando contacto:', JSON.stringify(r.data).substring(0, 200));
  return null;
}

// Devuelve el id del contacto (busca o crea).
async function obtenerContactoId(phone) {
  const id = await buscarContacto(phone);
  if (id) return id;
  return crearContacto(phone);
}

// Envía el template de seguimiento con la medida consultada.
// medidas: string, ej: "265/65R17, 245/65R17"
async function enviarSeguimiento(phone, medidas) {
  if (!TOKEN) throw new Error('RESPOND_IO_API_KEY no configurado');

  const contactId = await obtenerContactoId(phone);
  if (!contactId) throw new Error(`No se pudo obtener contacto para ${phone}`);

  const r = await request('POST', `/v2/contact/${contactId}/message`, {
    channelId: CHANNEL_ID,
    message: {
      type: 'whatsapp_template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANG },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: medidas },
            ],
          },
        ],
      },
    },
  });

  if (r.status === 200 || r.status === 201) {
    console.log(`[respondio] ✅ Template enviado a ${phone}`);
    return true;
  }

  console.error(`[respondio] ❌ Error enviando template a ${phone}:`, JSON.stringify(r.data).substring(0, 300));
  throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data).substring(0, 150)}`);
}

module.exports = { enviarSeguimiento };
