// The one place that talks to an AI model. Every call goes to OpenRouter with zero data
// retention required, and every request is kept in a short log so the reviewer can see
// exactly what was sent.

export const ZDR_ONLY = { zdr: true, data_collection: 'deny' };
export const NO_KEY = 'No OpenRouter key yet. Add one in Settings (local mode: OPENROUTER_API_KEY in .env).';

const sent = [];

// The most recent requests, newest first. Kept in memory only.
export const sentLog = () => [...sent];

export async function chat({ purpose = 'AI call', apiKey, model, baseUrl = 'https://openrouter.ai', messages, fetchImpl = fetch,
  maxTokens = 700, temperature = 0, timeoutMs = 60000, json = false }) {
  if (!apiKey) throw new Error(NO_KEY);
  const body = { model, temperature, max_tokens: maxTokens, messages, ...(json ? { response_format: { type: 'json_object' } } : {}),
    usage: { include: true }, provider: ZDR_ONLY };
  sent.unshift({ at: new Date().toISOString(), purpose, to: `${baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`, body });
  sent.length = Math.min(sent.length, 30);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-title': 'EvalDesk' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${(parsed?.error?.message ?? text).slice(0, 160)}`);
    return { content: parsed?.choices?.[0]?.message?.content ?? '', cost: Number(parsed?.usage?.cost ?? 0) };
  } catch (error) {
    if (error.name === 'AbortError') {
      const waited = timeoutMs >= 120000 ? `${Math.round(timeoutMs / 60000)} minutes` : `${Math.round(timeoutMs / 1000)} seconds`;
      throw new Error(`The AI model took too long to answer (no reply after ${waited}). Try again, or choose a faster model in Settings: ${model} may be slow or busy.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
