/*
 * Worker de Cloudflare — IA de Cotizadía (proxy a OpenAI, pagado por Cotizadía).
 *
 * Reemplaza el modelo anterior de "cada cliente pega su propia API key de OpenAI"
 * por un modelo real de plan pago: Cotizadía provee y paga la IA, y este Worker
 * la habilita solo para clientes cuyo plan (config/{clientId}/plan/tier en Firebase)
 * no sea 'free'. Así "IA" pasa a ser un beneficio real y verificable del plan Pro,
 * no algo que cualquiera pueda activar gratis pegando su propia key.
 *
 * DESPLIEGUE (dashboard de Cloudflare, igual que worker-mercadopago/mp-worker.js):
 *   1. Cloudflare dashboard → Workers & Pages → Create → pega este archivo completo.
 *   2. Settings → Variables and Secrets, agregar como "Secret" (NUNCA como texto plano):
 *        OPENAI_API_KEY      — tu propia API key de OpenAI (platform.openai.com/api-keys).
 *                              Pégala directo en el campo de Cloudflare — nunca se la
 *                              compartas a nadie más (ni la pegues en un chat, doc, etc).
 *        FIREBASE_DB_SECRET  — el mismo secreto ya usado en worker-mercadopago
 *                              (Firebase Console → Configuración del proyecto → Cuentas
 *                              de servicio → "Secretos de base de datos").
 *   3. Copiar la URL del Worker (algo como https://ai-cotizadia.<subdominio>.workers.dev)
 *      y pegarla en AI_WORKER_URL dentro de index.html (buscar "TODO: pegar la URL del Worker IA").
 *
 * COSTO: cada clientId tiene un tope mensual de llamadas (MONTHLY_CAP) para evitar
 * facturas sorpresa de OpenAI — ajustar según el plan y el uso real observado.
 */

const FIREBASE_DB_URL = 'https://cotizador-e6a9a-default-rtdb.firebaseio.com';
const ALLOWED_ORIGIN = 'https://cotizadia.cl';

const ALLOWED_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
const DEFAULT_MODEL = 'gpt-4o-mini';

// Tope de llamadas IA por clientId por mes calendario — evita abuso/costos inesperados.
const MONTHLY_CAP = { pro: 200, premium: 500, team: 500 };

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

function currentMonthKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function handleGenerar(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'body inválido' }, 400); }

  const clientId = (body && body.clientId || '').toString();
  if (!clientId) return jsonResponse({ error: 'falta clientId' }, 400);

  const tier = await fbGet(env, '/config/' + clientId + '/plan/tier');
  if (!tier || tier === 'free') {
    return jsonResponse({ error: 'plan_required', message: 'La IA está disponible desde el plan Pro.' }, 402);
  }

  const monthKey = currentMonthKey();
  const usagePath = '/ai_usage/' + clientId + '/' + monthKey;
  const used = (await fbGet(env, usagePath)) || 0;
  const cap = MONTHLY_CAP[tier] || MONTHLY_CAP.pro;
  if (used >= cap) {
    return jsonResponse({ error: 'cap_reached', message: 'Alcanzaste el límite mensual de IA de tu plan.' }, 429);
  }

  let messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) {
    if (!body.system || !body.user) return jsonResponse({ error: 'faltan system/user o messages' }, 400);
    messages = [{ role: 'system', content: body.system }, { role: 'user', content: body.user }];
  }
  const maxTokens = Math.min(parseInt(body.maxTokens) || 700, 2000);
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : DEFAULT_MODEL;
  const stream = !!body.stream;

  // Incrementa el contador antes de llamar — evita que una ráfaga concurrente se pase del tope.
  await fbSet(env, usagePath, used + 1);

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream, messages }),
  });

  if (stream) {
    if (!upstream.ok) {
      const e = await upstream.json().catch(() => ({}));
      return jsonResponse({ error: (e.error && e.error.message) || ('OpenAI error ' + upstream.status) }, 502);
    }
    return withCors(new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  }

  const data = await upstream.json();
  if (data.error) return jsonResponse({ error: data.error.message }, 502);
  return jsonResponse({ text: data.choices[0].message.content.trim() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    if (url.pathname === '/generar' && request.method === 'POST') return handleGenerar(request, env);
    return jsonResponse({ error: 'not found' }, 404);
  },
};
