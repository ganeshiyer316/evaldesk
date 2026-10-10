// The one place that talks to an AI model. Every call goes to OpenRouter with zero data
// retention required, and every request is kept in a short log so the reviewer can see
// exactly what was sent.

export const ZDR_ONLY = { zdr: true, data_collection: 'deny' };
export const NO_KEY = 'No OpenRouter key yet. Add one in Settings (local mode: OPENROUTER_API_KEY in .env).';

const sent = [];

// The most recent requests, newest first. Kept in memory only.
export const sentLog = () => [...sent];

// Many models think before they answer, and the thinking counts against the same limit as the
// answer. Left alone, a model can spend the whole limit thinking and write nothing (seen with a
// 55-note grouping). So every call asks for light thinking, and an empty answer gets one more try
// with twice the room.
export async function chat({ purpose = 'AI call', apiKey, model, baseUrl = 'https://openrouter.ai', messages, fetchImpl = fetch,
  maxTokens = 700, temperature = 0, timeoutMs = 60000, json = false, thinking = 'low', secondTry = true }) {
  if (!apiKey) throw new Error(NO_KEY);
  const common = { apiKey, model, baseUrl, messages, fetchImpl, temperature, timeoutMs, json };
  const first = await ask({ ...common, purpose, maxTokens, thinking });
  // "Crowded out": the answer is empty or was cut off, and thinking used tokens. Asking for light
  // thinking is not always obeyed (one model spent 15,318 of 16,000 tokens thinking anyway).
  const crowded = (reply) => (reply.finish === 'length' || !String(reply.content ?? '').trim()) && (reply.thought || reply.finish === 'length');
  if (!crowded(first) || !secondTry) return first;
  let cost = first.cost;
  // Second try: thinking switched off, same room. Some providers refuse that setting; then go on.
  try {
    const second = await ask({ ...common, purpose: `${purpose} (second try, thinking off)`, maxTokens, thinking: false });
    cost += second.cost;
    if (!crowded(second)) return { ...second, cost };
  } catch (error) {
    if (!/HTTP 4\d\d/.test(error.message)) throw error;
  }
  // Third and last try: light thinking again, with twice the room.
  const third = await ask({ ...common, purpose: `${purpose} (third try, twice the room)`, maxTokens: maxTokens * 2, thinking });
  return { ...third, cost: cost + third.cost };
}

async function ask({ purpose, apiKey, model, baseUrl, messages, fetchImpl, maxTokens, temperature, timeoutMs, json, thinking }) {
  const body = { model, temperature, max_tokens: maxTokens, messages, ...(json ? { response_format: { type: 'json_object' } } : {}),
    // thinking: 'low' asks for light thinking, false switches it off, null leaves the model's own setting.
    ...(thinking === false ? { reasoning: { enabled: false } } : thinking ? { reasoning: { effort: thinking } } : {}), usage: { include: true }, provider: ZDR_ONLY };
  const entry = { at: new Date().toISOString(), purpose, to: `${baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`, body, reply: null };
  sent.unshift(entry);
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
    const choice = parsed?.choices?.[0];
    // finish: "length" means the answer hit the token limit and was cut off. thought: the model
    // spent tokens on hidden reasoning, which can leave little or nothing for the answer itself.
    const usage = parsed?.usage ?? {};
    const thinkingTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0);
    const result = { content: choice?.message?.content ?? '', cost: Number(usage.cost ?? 0), finish: choice?.finish_reason ?? null,
      thought: Boolean(choice?.message?.reasoning || thinkingTokens),
      // How the model used its room: tokens in the whole reply, how many of those were thinking, and the room it was given.
      tokens: { reply: Number(usage.completion_tokens ?? 0), thinking: thinkingTokens, room: maxTokens } };
    // Kept beside what was sent (never the answer's words), so a reviewer can see why an answer was short or empty.
    entry.reply = { finish: result.finish, cost: result.cost, characters: result.content.length, ...result.tokens };
    return result;
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
