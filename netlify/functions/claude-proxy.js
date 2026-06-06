// netlify/functions/claude-proxy.js
// ENIGMA ARCHIVE — Anthropic API proxy
// Forwards POST bodies to https://api.anthropic.com/v1/messages
// using the ANTHROPIC_API_KEY environment variable set in Netlify.

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured' }),
    };
  }

  let payload;
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const body = {
    model: payload.model || DEFAULT_MODEL,
    max_tokens: payload.max_tokens ?? 4096,
    messages: payload.messages || [],
    ...(payload.system ? { system: payload.system } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.top_k !== undefined ? { top_k: payload.top_k } : {}),
    ...(payload.stop_sequences ? { stop_sequences: payload.stop_sequences } : {}),
    ...(payload.tools ? { tools: payload.tools } : {}),
    ...(payload.tool_choice ? { tool_choice: payload.tool_choice } : {}),
  };

  try {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    return {
      statusCode: response.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': response.headers.get('content-type') || 'application/json',
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Upstream request failed', detail: String(err) }),
    };
  }
};
