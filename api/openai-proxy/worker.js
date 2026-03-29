/**
 * Cloudflare Worker — OpenAI Proxy for Alpha City Portfolio Analyzer
 *
 * This worker keeps the OpenAI API key server-side so it is never exposed
 * in the browser.  The client sends the same JSON body it would send to
 * OpenAI, and this worker forwards it with the Authorization header.
 *
 * ── Setup ──────────────────────────────────────────────────────────────
 * 1. Install Wrangler:  npm i -g wrangler
 * 2. Authenticate:      wrangler login
 * 3. Store the key:     wrangler secret put OPENAI_API_KEY
 *    (paste your sk-… key when prompted — it is stored encrypted)
 * 4. Deploy:            wrangler deploy
 *
 * After deploying, add the Worker URL as a GitHub Actions secret named
 * OPENAI_PROXY_URL (e.g. https://alphacity-openai-proxy.<you>.workers.dev)
 * so the deploy workflow can inject it into the analyze page.
 *
 * ── Environment variables / secrets ────────────────────────────────────
 *   OPENAI_API_KEY   (secret)   — your OpenAI API key
 *   ALLOWED_ORIGINS  (variable) — comma-separated allowed origins,
 *                                 defaults to https://alphacity.tech
 */

const DEFAULT_ALLOWED_ORIGINS = 'https://alphacity.tech';

export default {
  async fetch(request, env) {
    // ── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCors(request, env, new Response(null, { status: 204 }));
    }

    // ── Only POST allowed ───────────────────────────────────────────
    if (request.method !== 'POST') {
      return handleCors(
        request,
        env,
        new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    // ── Origin check ────────────────────────────────────────────────
    const origin = request.headers.get('Origin') || '';
    if (!isAllowedOrigin(origin, env)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Validate that the API key secret is configured ──────────────
    if (!env.OPENAI_API_KEY) {
      return handleCors(
        request,
        env,
        new Response(
          JSON.stringify({ error: 'OpenAI API key not configured on proxy' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }

    // ── Forward to OpenAI ───────────────────────────────────────────
    try {
      const body = await request.text();

      const openaiResp = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body,
        },
      );

      // Stream the OpenAI response back to the client
      return handleCors(
        request,
        env,
        new Response(openaiResp.body, {
          status: openaiResp.status,
          headers: {
            'Content-Type':
              openaiResp.headers.get('Content-Type') || 'application/json',
          },
        }),
      );
    } catch (err) {
      return handleCors(
        request,
        env,
        new Response(
          JSON.stringify({ error: 'Proxy error', detail: err.message }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function allowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  return allowedOrigins(env).some(
    (allowed) => origin === allowed || origin === allowed.replace(/\/$/, ''),
  );
}

function handleCors(request, env, response) {
  const origin = request.headers.get('Origin') || '';
  const matched = allowedOrigins(env).find(
    (a) => origin === a || origin === a.replace(/\/$/, ''),
  );

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', matched || '');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
