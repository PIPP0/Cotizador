/*
 * Worker de Cloudflare — suscripciones MercadoPago para Cotizadía.
 *
 * DESPLIEGUE (dashboard de Cloudflare, igual que el Worker de IA existente):
 *   1. Cloudflare dashboard → Workers & Pages → Create → pega este archivo completo.
 *   2. Settings → Variables and Secrets, agregar como "Secret" (no como texto plano):
 *        MP_ACCESS_TOKEN     — Access Token de producción de Mercado Pago
 *                              (https://www.mercadopago.cl/developers/panel → Credenciales de producción)
 *        FIREBASE_DB_SECRET  — Firebase Console → Configuración del proyecto → Cuentas de servicio
 *                              → pestaña "Secretos de base de datos" → Agregar secreto
 *   3. Copiar la URL del Worker (algo como https://mp-cotizadia.<subdominio>.workers.dev)
 *      y pegarla en MP_WORKER_URL dentro de index.html (buscar "TODO: pegar la URL del Worker").
 *   4. En el panel de MercadoPago, no hace falta configurar el webhook a mano: se le indica
 *      la notification_url en cada preapproval creado (ver handleCrearSuscripcion).
 *
 * PRECIOS: PLAN_PRECIOS abajo son placeholders — actualízalos cuando estén definidos.
 */

const FIREBASE_DB_URL = 'https://cotizador-e6a9a-default-rtdb.firebaseio.com';
const ALLOWED_ORIGIN = 'https://cotizadia.cl';

// TODO: definir precios reales (CLP/mes) antes de activar el cobro
const PLAN_PRECIOS = {
  pro: 9990,
  team: 19990,
};

function withCors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  resp.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

function jsonResponse(obj, status) {
  return withCors(new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function mpRequest(env, method, path, payload) {
  const res = await fetch('https://api.mercadopago.com' + path, {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + env.MP_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error('MP API ' + method + ' ' + path + ' -> ' + res.status + ': ' + JSON.stringify(data));
  return data;
}

async function fbGet(env, path) {
  const res = await fetch(FIREBASE_DB_URL + path + '.json?auth=' + env.FIREBASE_DB_SECRET);
  if (!res.ok) return null;
  return res.json();
}

async function fbSet(env, path, value) {
  const res = await fetch(FIREBASE_DB_URL + path + '.json?auth=' + env.FIREBASE_DB_SECRET, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error('Firebase PUT ' + path + ' -> ' + res.status);
  return res.json();
}

async function handleCrearSuscripcion(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'body inválido' }, 400); }
  const clientId = (body && body.clientId || '').toString();
  const tier = (body && body.tier || '').toString();
  const email = (body && body.email || '').toString();
  const origin = (body && body.origin) || ALLOWED_ORIGIN;

  if (!clientId || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: 'faltan datos o email inválido' }, 400);
  }
  const precio = PLAN_PRECIOS[tier];
  if (!precio) return jsonResponse({ error: 'plan inválido' }, 400);

  // el cliente debe existir de verdad — evita generar preapprovals para clientId inventados
  const clientConfig = await fbGet(env, '/config/' + clientId);
  if (!clientConfig) return jsonResponse({ error: 'cliente no encontrado' }, 404);

  const token = crypto.randomUUID();
  const externalReference = 'sub_' + clientId + '_' + token;
  const workerHost = new URL(request.url).host;

  try {
    await fbSet(env, '/subscriptions_pending/' + token, {
      clientId: clientId, tier: tier, email: email, estado: 'pendiente', creadoEn: Date.now(),
    });
    const resp = await mpRequest(env, 'POST', '/preapproval', {
      reason: 'Cotizadía - Plan ' + tier,
      external_reference: externalReference,
      payer_email: email,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: precio, currency_id: 'CLP' },
      back_url: origin + '/' + clientId + '/?plan_pendiente=1',
      notification_url: 'https://' + workerHost + '/mp-webhook',
      status: 'pending',
    });
    await fbSet(env, '/subscriptions_pending/' + token + '/preapprovalId', resp.id);
    return jsonResponse({ init_point: resp.init_point || resp.sandbox_init_point });
  } catch (e) {
    return jsonResponse({ error: String((e && e.message) || e) }, 500);
  }
}

async function handleWebhook(request, env, url) {
  let body = {};
  try { body = await request.json(); } catch (e) { /* algunas notificaciones llegan sin body, solo query */ }
  const notifId = (body.data && body.data.id) || url.searchParams.get('id') || url.searchParams.get('data.id');
  const tipo = body.type || url.searchParams.get('type') || url.searchParams.get('topic');
  if (!notifId || tipo !== 'preapproval') return jsonResponse({ ok: true });

  try {
    // nunca confiar en el payload del webhook: siempre se vuelve a consultar el estado real a la API
    const info = await mpRequest(env, 'GET', '/preapproval/' + notifId);
    const externalReference = info.external_reference || '';
    const parts = externalReference.split('_'); // formato: sub_{clientId}_{token}
    if (parts[0] !== 'sub' || parts.length < 3) return jsonResponse({ ok: true });
    const token = parts[parts.length - 1];
    const clientId = parts.slice(1, -1).join('_');

    const pending = await fbGet(env, '/subscriptions_pending/' + token);
    if (!pending) return jsonResponse({ ok: true });

    const status = info.status;
    const nuevoEstado = status === 'authorized' ? 'active' : status === 'cancelled' ? 'cancelled' : 'pending';
    await fbSet(env, '/subscriptions_pending/' + token, Object.assign({}, pending, { estado: nuevoEstado, mpStatus: status }));

    if (nuevoEstado === 'active') {
      await fbSet(env, '/config/' + clientId + '/plan', { tier: pending.tier, status: 'active', preapprovalId: info.id, updatedAt: Date.now() });
    } else if (nuevoEstado === 'cancelled') {
      await fbSet(env, '/config/' + clientId + '/plan', { tier: 'free', status: 'cancelled', updatedAt: Date.now() });
    }
  } catch (e) {
    // no relanzar el error: si respondemos != 2xx, Mercado Pago reintenta la notificación indefinidamente
    console.error('mp-webhook error', e);
  }
  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (url.pathname === '/crear-suscripcion' && request.method === 'POST') return handleCrearSuscripcion(request, env);
    if (url.pathname === '/mp-webhook' && (request.method === 'POST' || request.method === 'GET')) return handleWebhook(request, env, url);
    return jsonResponse({ error: 'not found' }, 404);
  },
};
