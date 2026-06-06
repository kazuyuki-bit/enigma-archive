// netlify/functions/translate-case.js
// ENIGMA ARCHIVE — Japanese → English translator
//
// Fetches untranslated cases from Supabase (translations_done is null or false),
// asks Claude to translate the TITLE (truncated to 50 chars), LOCATION_COUNTRY
// and INCIDENT_DATE into English (description is NOT translated), and writes
// title_en / location_country_en / incident_date_en back, then marks
// translations_done = true.
//   • If the *_en columns do not exist in Supabase, it falls back to saving
//     title_en only (so the script still works on older schemas).
//   • On translation failure the case is ALSO marked translations_done = true
//     so it is permanently skipped and never retried.
//
// Required env vars:
//   ANTHROPIC_API_KEY            — Anthropic API key
//   SUPABASE_SERVICE_ROLE_KEY    — service-role key. Required to bypass RLS
//                                  on UPDATE. Set this in Netlify env vars.
// Optional env vars:
//   SUPABASE_URL                 — defaults to project URL below
//   TRANSLATE_MODEL              — Anthropic model (default haiku-4.5)
//   TRANSLATE_BATCH              — max cases per invocation (default 1)
//
// Query params (override env):
//   ?limit=N                     — cases per invocation (1..10)
//   ?id=<uuid>                   — translate a single specific case

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://agdfhkuazogzmgfexmgx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_BATCH = parseInt(process.env.TRANSLATE_BATCH || '1', 10);

const TIME_BUDGET_MS = 9000;
const SAFETY_MARGIN_MS = 2500;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function supabaseFetch(path, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase ${init.method || 'GET'} /${path} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
    );
  }
  return text ? JSON.parse(text) : null;
}

// Max source title length (characters) before translating. Long titles are the
// main cause of truncated / unparseable responses, so we cap the input.
const MAX_TITLE_LEN = 50;

const SYSTEM_PROMPT =
  'You are a translation engine. Translate the given Japanese fields into natural, fluent English. ' +
  'Respond with a SINGLE valid JSON object: {"title": "...", "location_country": "...", "incident_date": "..."}. ' +
  'Keep each value concise. For location_country output the English country/region name. ' +
  'For incident_date translate era/period expressions naturally (e.g. "1947年" → "1947", "古代〜現代" → "Ancient to modern era"). ' +
  'If a source field is empty, return an empty string for it. ' +
  'Do NOT add commentary, explanations, prose, or markdown code fences. ' +
  '必ず { で始まり } で終わる純粋なJSONのみを返すこと。説明文・コードブロック（```）・前置き・余分な改行は一切不要。 ' +
  'Your entire output must be ONLY the JSON object — nothing before {, nothing after }.';

function buildUserMessage(c) {
  const title = String(c.title || '').slice(0, MAX_TITLE_LEN);
  return `Translate these Japanese fields into natural English. Return ONE flat JSON object: {"title":"...","location_country":"...","incident_date":"..."}. Output JSON only.

TITLE: ${title}
LOCATION_COUNTRY: ${String(c.location_country || '')}
INCIDENT_DATE: ${String(c.incident_date || '')}`;
}

function extractJsonObject(raw) {
  let s = String(raw || '');
  s = s.replace(/```(?:json|JSON)?/g, '');
  s = s.replace(/```/g, '');
  s = s.replace(/^\s*json\s*/i, '');
  s = s.trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return s.slice(first, last + 1);
}

async function translateOne(c) {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserMessage(c) },
        // Prefill assistant turn with '{"title":' so Claude continues from
        // inside the JSON object. No preamble possible.
        { role: 'assistant', content: '{"title":' },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const stop = data.stop_reason || 'unknown';
  const continuation = (data.content || []).map((b) => b.text || '').join('');
  const raw = ('{"title":' + continuation).trim();
  const candidate = extractJsonObject(raw) || raw;

  try {
    return JSON.parse(candidate);
  } catch (e) {
    console.error(
      '[translate-case] JSON parse failed',
      JSON.stringify({
        case_id: c.id,
        stop_reason: stop,
        raw_length: raw.length,
        candidate_length: candidate.length,
        raw_text: raw,
        candidate_text: candidate,
        parse_error: String(e),
      })
    );
    const hint =
      stop === 'max_tokens'
        ? ' (response truncated by max_tokens — increase TRANSLATE_MAX_TOKENS or shorten the source)'
        : '';
    throw new Error(
      `JSON parse failed${hint}. stop_reason=${stop}. head=${candidate.slice(0, 200)} ... tail=${candidate.slice(-100)}`
    );
  }
}

function buildUpdate(translation, minimalOnly = false) {
  // Description is intentionally left untranslated.
  const title = (translation.title || '').toString().trim();
  const update = {
    translations_done: true,
    title_en: title || null,
  };
  if (minimalOnly) return update;
  const country = (translation.location_country || '').toString().trim();
  const date = (translation.incident_date || '').toString().trim();
  update.location_country_en = country || null;
  update.incident_date_en = date || null;
  return update;
}

function patchCase(id, update) {
  return supabaseFetch(`cases?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(update),
  });
}

// PostgREST reports a missing column with code PGRST204 / "Could not find the
// 'X' column" / "column ... does not exist". Detect that so we can fall back.
function isMissingColumnError(err) {
  const m = String(err && err.message ? err.message : err).toLowerCase();
  return (
    m.includes('pgrst204') ||
    (m.includes('could not find') && m.includes('column')) ||
    (m.includes('column') && m.includes('does not exist')) ||
    m.includes('schema cache')
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (typeof fetch !== 'function') {
    return jsonResponse(500, {
      error: 'global fetch is not available — set Netlify Functions Node runtime to 18 or later',
    });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse(500, { error: 'ANTHROPIC_API_KEY is not configured' });
  }
  if (!SERVICE_KEY) {
    return jsonResponse(500, {
      error: 'SUPABASE_SERVICE_ROLE_KEY is not configured. Set it in Netlify → Site settings → Environment variables.',
    });
  }

  const qs = event.queryStringParameters || {};
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const remaining = () => TIME_BUDGET_MS - elapsed();

  let cases;
  try {
    const select = 'select=id,title,description,location_country,incident_date';
    if (qs.id) {
      cases = await supabaseFetch(
        `cases?${select}&id=eq.${encodeURIComponent(qs.id)}&limit=1`
      );
    } else {
      const limit = Math.max(1, Math.min(parseInt(qs.limit || DEFAULT_BATCH, 10) || DEFAULT_BATCH, 10));
      const filter = 'or=(translations_done.is.null,translations_done.eq.false)';
      cases = await supabaseFetch(
        `cases?${select}&${filter}&order=created_at.asc&limit=${limit}`
      );
    }
  } catch (e) {
    return jsonResponse(500, { stage: 'fetch_cases', error: String(e) });
  }

  if (!cases || cases.length === 0) {
    return jsonResponse(200, { message: 'No untranslated cases', translated: 0, results: [] });
  }

  const results = [];
  for (const c of cases) {
    if (remaining() < SAFETY_MARGIN_MS) {
      results.push({ id: c.id, ok: false, skipped: true, error: 'time budget exhausted' });
      continue;
    }
    try {
      const translation = await translateOne(c);
      try {
        // Try the full update (title_en + location_country_en + incident_date_en).
        await patchCase(c.id, buildUpdate(translation));
        results.push({ id: c.id, ok: true });
      } catch (patchErr) {
        // If the *_en columns don't exist yet, fall back to saving title_en only.
        if (isMissingColumnError(patchErr)) {
          console.warn('[translate-case] *_en columns missing, saving title_en only:', c.id);
          await patchCase(c.id, buildUpdate(translation, true));
          results.push({ id: c.id, ok: true, fallback: 'title_en_only' });
        } else {
          throw patchErr;
        }
      }
    } catch (e) {
      // Translation failed. Mark the case as done anyway so it is never retried
      // (these cases fail repeatedly and would otherwise block the batch forever).
      let marked = false;
      try {
        await supabaseFetch(`cases?id=eq.${encodeURIComponent(c.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ translations_done: true }),
        });
        marked = true;
      } catch (markErr) {
        console.error('[translate-case] failed to mark translations_done', c.id, String(markErr));
      }
      results.push({ id: c.id, ok: false, skipped_permanently: marked, error: String(e) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return jsonResponse(200, {
    translated: okCount,
    failed: results.length - okCount,
    elapsed_ms: elapsed(),
    model: MODEL,
    results,
  });
};
