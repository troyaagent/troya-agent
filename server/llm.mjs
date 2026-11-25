// OpenRouter chat client with tool calling, plus a daily spend cap.
// On only when OPENROUTER_API_KEY is set. Model: OPENROUTER_MODEL (default Claude Haiku 5.5), with a cheaper fallback model.
// LLM_DAILY_USD caps spend per UTC day (default $5); past it, callers fall back to the deterministic parser.

const KEY = process.env.OPENROUTER_API_KEY || "";
const URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5";
const FALLBACK = process.env.OPENROUTER_FALLBACK || "deepseek/deepseek-v4.1-flash";
const DAILY_USD = Number(process.env.LLM_DAILY_USD || 5);

let store;
export function initLlm(s) { store = s; }
export const llmOn = () => !!KEY;
export const llmModel = () => MODEL;

const today = () => new Date().toISOString().slice(0, 10);
async function spentToday() {
  const u = await store.readJson("llm-usage.json", {});
  return u.day === today() ? u : { day: today(), calls: 0, usd: 0, tokensIn: 0, tokensOut: 0 };
}
export async function underCap() { return KEY && (await spentToday()).usd < DAILY_USD; }
async function record(usage) {
  await store.update("llm-usage.json", {}, (u) => {
    if (u.day !== today()) { u.day = today(); u.calls = 0; u.usd = 0; u.tokensIn = 0; u.tokensOut = 0; }
    u.calls++;
    u.usd = +(u.usd + (Number(usage?.cost) || 0)).toFixed(6);
    u.tokensIn += usage?.prompt_tokens || 0;
    u.tokensOut += usage?.completion_tokens || 0;
  });
}
export async function usageToday() { const u = await spentToday(); return { ...u, capUsd: DAILY_USD, model: MODEL }; }

async function call(messages, tools, opts = {}) {
  const res = await fetch(URL, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
      "HTTP-Referer": process.env.SITE_URL || "https://troya.codes",
      "X-Title": "Troya Agent",
    },
    body: JSON.stringify({
      model: opts.model || MODEL, ...(opts.noFallback ? {} : { models: [opts.model || MODEL, FALLBACK] }),   // noFallback: never answer with a weaker model
      messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? "auto" : undefined,
      max_tokens: opts.maxTokens || 900, temperature: opts.temperature ?? 0.3, usage: { include: true },
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || `OpenRouter ${res.status}`);
  await record(j.usage);
  return j.choices?.[0]?.message || {};
}

/** One plain completion with a chosen model (the Arena's AI traders each run their own), inside the same daily cap. */
export async function ask({ system, user, model, maxTokens = 700, temperature = 0.4 }) {
  if (!KEY || !(await underCap())) return "";
  // thinking models spend tokens before they answer: keep their reasoning short and out of the reply
  const msg = await call([{ role: "system", content: system }, { role: "user", content: user }], [], { model, maxTokens, temperature, reasoning: { effort: "low", exclude: true } });
  return String(msg.content || "").trim();
}

// Runs the model, executes the tool calls it asks for (exec(name, args) → result object), and repeats until it answers.
export async function chatWithTools({ system, history = [], user, tools = [], exec, maxSteps = 5, onTool, model, maxTokens, temperature, noFallback }) {
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: user }];
  for (let step = 0; step < maxSteps; step++) {
    const lastStep = step === maxSteps - 1;
    const msg = await call(messages, lastStep ? [] : tools, { model, maxTokens, temperature, noFallback });   // model: a caller may pick its own (Heel Hunt runs a stronger one)
    const calls = msg.tool_calls || [];
    if (!calls.length) return String(msg.content || "").trim();
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch {}
      let out;
      try { out = await exec(c.function?.name, args); onTool?.(c.function?.name, true); }
      catch (e) { out = { error: String(e.message || e).slice(0, 300) }; onTool?.(c.function?.name, false); }
      const text = JSON.stringify(out ?? null);
      messages.push({ role: "tool", tool_call_id: c.id, content: `<untrusted>${text.length > 16000 ? text.slice(0, 16000) + "…" : text}</untrusted>` });
    }
  }
  return "";
}
