// RPG narrator for solo mode. Calls a local Ollama model to write incident-response
// narration; if Ollama is unreachable it falls back to templated flavor text so solo
// mode always works offline.
//
// Configure with env: BNB_OLLAMA_URL (default http://localhost:11434),
// BNB_OLLAMA_MODEL (default qwen2.5:7b).

import { scenarioFacts } from "./scenario.js";

const OLLAMA_URL = process.env.BNB_OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.BNB_OLLAMA_MODEL || "qwen2.5:7b";
const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const rpick = (a) => a[Math.floor(Math.random() * a.length)];

const SYSTEM = `You are the Incident Master narrating a cybersecurity incident-response tabletop RPG
(based on Black Hills InfoSec's "Backdoors & Breaches"). You speak to a lone blue-team analyst in
second person ("you"). Write vivid, technically authentic SOC narration in 2-4 short sentences.

Hard rules:
- Use CONCRETE artifacts from the provided scenario facts: the attacker IP, C2 domain/port, file
  hash, compromised account, hostnames, CVE, and MITRE ATT&CK techniques. Invent extra realistic
  detail (log source names, process trees, registry keys, ports) as needed.
- VARY your wording every time. Never reuse a stock opening like "the logs light up", "the SIEM
  dashboard lights up", or "something isn't right". Open differently each call.
- Continue the ongoing story; do not restate earlier sentences.
- Never name attacker techniques the analyst has not yet detected — hint only.
- No markdown, no lists, no preamble, no headings. Just the narration prose.`;

// Build the user prompt for a given narration moment.
function buildPrompt(kind, ctx = {}) {
  const facts = ctx.scenario ? `SCENARIO FACTS:\n${scenarioFacts(ctx.scenario)}\n` : "";
  const recent = ctx.recent ? `STORY SO FAR (continue from here; do NOT repeat its wording):\n"${ctx.recent}"\n` : "";
  const nonce = `Variation token ${ctx.nonce ?? ri(1000, 9999)} — make this narration unique.`;
  const head = `${facts}${recent}${nonce}\n`;
  const i = ctx.scenario?.iocs || {};
  switch (kind) {
    case "intro":
      return `${head}A new incident is opening at this organization. Write a UNIQUE cold open: how the
        team first notices trouble, anchored on ONE or TWO concrete early indicators (e.g. attacker IP
        ${i.ip || ""} or odd auth on "${i.account || "an account"}"). Build dread without naming the
        deeper attack stages. 3-4 sentences.`;
    case "success":
      return `${head}The analyst ran "${ctx.procedure}" and SUCCEEDED (rolled ${ctx.total} vs
        ${ctx.threshold}), detecting the ${ctx.stage} stage: "${ctx.card}". Narrate the specific
        artifacts uncovered — tie them to "${ctx.procedure}" and to the scenario IOCs (a log line, a
        process tree, the hash, a beacon to ${i.c2 || "the C2"}). End with a concrete hint toward the
        next move. 2-3 sentences.`;
    case "nodetect":
      return `${head}The analyst ran "${ctx.procedure}" — it worked but surfaced nothing new this
        round. Narrate a specific, believable dead end (a benign-looking artifact ruled out). 1-2 sentences.`;
    case "failure":
      return `${head}The analyst ran "${ctx.procedure}" and it FAILED (rolled ${ctx.total} vs
        ${ctx.threshold}). Give a CONCRETE, varied real-world reason it hit a wall — choose a specific
        gap: that log source was never onboarded to the SIEM, no EDR agent on ${i.host || "that host"},
        NetFlow retention already rolled off, a proxy bypass hid traffic to ${i.c2 || "the C2"}, a
        misconfigured sensor, MFA fatigue, etc. Do NOT reuse a reason already in the story so far. 2 sentences.`;
    case "inject":
      return `${head}A complication strikes the SOC: "${ctx.inject}". Narrate it landing
        mid-investigation, tied to this scenario. 2 sentences.`;
    case "win":
      return `${head}The analyst has detected the full attack chain and can contain it. Narrate the
        decisive containment (blocking ${i.ip || "the attacker IP"}, disabling "${i.account || "the account"}",
        eviction) and a beat of relief. 2-3 sentences.`;
    case "lose":
      return `${head}Time ran out; ${ctx.scenario?.actor || "the attackers"} achieved their objective
        undetected. Narrate the grim morning-after discovery, referencing IOCs that were there all along.
        2-3 sentences.`;
    default:
      return `${head}Narrate the current moment in the incident. 2 sentences.`;
  }
}

// Offline templates — filled with the scenario's IOCs and picked at random so they vary
// game-to-game even without the LLM.
function fallback(kind, ctx = {}) {
  const p = ctx.procedure || "the procedure";
  const card = ctx.card || "the activity";
  const i = ctx.scenario?.iocs || {};
  const ip = i.ip || "an external IP";
  const c2 = i.c2 ? `${i.c2}:${i.port || 443}` : "an unfamiliar domain";
  const acct = i.account ? `"${i.account}"` : "a service account";
  const host = i.host || "a workstation";
  const hash = i.hash ? i.hash.slice(0, 12) + "…" : "an unknown binary";
  const FB = {
    intro: [
      `It opens quietly: ${acct} authenticates from ${ip} at 02:14, well outside its baseline. Help desk has a ticket about ${host} "running hot," and a perimeter alert flags a trickle of traffic toward ${c2}. None of it is conclusive — but the shape is wrong, and the shift is yours.`,
      `A threat-intel feed pings on ${ip}; minutes later ${host} spawns a process no one recognizes (${hash}). The on-call is asleep, the queue is full, and the timestamps don't line up with any change ticket. You take point.`,
      `Billing notices an odd egress spike to ${c2}; meanwhile ${acct} just logged in from two countries an hour apart. Nothing has paged yet, which somehow makes it worse. You open the consoles and start pulling threads.`,
    ],
    success: [
      `Your ${p} pays off: ${card} surfaces in the telemetry on ${host}, with a clear link back to ${ip}. The artifacts line up — chase how they moved from here.`,
      `${p} lands. You tie ${card} to beaconing toward ${c2} and the binary ${hash}; the next hop is starting to take shape.`,
      `${p} confirms ${card} — ${acct} is in the middle of it. Pivot on that account's recent activity to find what they touched next.`,
    ],
    nodetect: [
      `${p} comes back clean — the one alert resolves to a patch-management job, not the intruder. Useful to rule out, but the trail stays cold.`,
      `${p} surfaces only noise this round: a noisy scanner and a flapping service. Nothing tied to ${ip}.`,
    ],
    failure: [
      `Your ${p} turns up nothing — that log source was never onboarded to the SIEM, so the activity on ${host} simply isn't there to find.`,
      `${p} stalls: no EDR agent was ever deployed to ${host}, leaving you blind to the process tree you needed.`,
      `Dead end — NetFlow retention already rolled off the window covering the ${c2} traffic, and no one budgeted to extend it.`,
      `A proxy bypass list quietly whitelisted ${c2}, so ${p} never sees the beacons leaving the network.`,
      `The sensor on that VLAN was misconfigured during the last migration; ${p} captures only a fraction of the traffic to ${ip}.`,
      `Alert fatigue buried it — the signal for ${acct} sat unread under 4,000 low-sev alerts.`,
    ],
    inject: [`A wrench hits the works: "${ctx.inject || "an inject"}." Mid-hunt, the team has to adapt around it while ${ip} keeps moving.`],
    win: [
      `The last piece clicks: you block ${ip} at the edge, disable ${acct}, kill the ${c2} beacon, and start eviction. End to end, scoped and contained — the room exhales.`,
      `You pull it together — ${host} isolated, ${acct} reset, ${c2} sinkholed. The chain is fully mapped and the door is shut.`,
    ],
    lose: [
      `The clock beats you. By morning ${acct} has been used to stage and exfil to ${c2}; ${ip} was in your logs the whole time. Now it's a recovery problem, not a detection one.`,
      `Time's up — the foothold on ${host} is entrenched and the data's gone. Every IOC was sitting there, just never connected in time.`,
    ],
  };
  const arr = FB[kind] || ["The investigation continues."];
  return rpick(arr);
}

// Resolve the effective provider config from ctx.narrator (+ env fallbacks).
function providerCfg(ctx = {}) {
  const n = ctx.narrator || {};
  return {
    provider: n.provider === "api" ? "api" : "ollama",
    ollamaUrl: (n.ollamaUrl || OLLAMA_URL).replace(/\/+$/, ""),
    apiBaseUrl: (n.apiBaseUrl || process.env.BNB_API_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: n.apiKey || process.env.BNB_API_KEY || "",
    model: n.model || ctx.model || MODEL,
  };
}

// Narrate a moment. If `onToken(textChunk)` is supplied, streams from the provider and calls
// it per chunk (typewriter); returns the full text. Uses ctx.narrator to pick Ollama or an
// OpenAI-compatible API. Falls back to templated flavor text on any failure.
export async function narrate(kind, ctx = {}, onToken) {
  const streaming = typeof onToken === "function";
  const cfg = providerCfg(ctx);
  try {
    const text = cfg.provider === "api"
      ? await narrateApi(cfg, kind, ctx, onToken, streaming)
      : await narrateOllama(cfg, kind, ctx, onToken, streaming);
    if (text && text.trim()) return text.trim();
    const fb = fallback(kind, ctx);
    if (streaming) onToken(fb);
    return fb;
  } catch {
    const fb = fallback(kind, ctx);
    if (streaming) onToken(fb);
    return fb;
  }
}

async function narrateOllama(cfg, kind, ctx, onToken, streaming) {
  const res = await fetch(`${cfg.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model, system: SYSTEM, prompt: buildPrompt(kind, ctx), stream: streaming,
      options: { temperature: 0.95, top_p: 0.95, repeat_penalty: 1.2, seed: ri(1, 2_000_000_000), num_predict: 256 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  if (!streaming) return (await res.json()).response || "";
  return readLines(res, (line) => { const j = JSON.parse(line); return j.response || ""; }, onToken);
}

async function narrateApi(cfg, kind, ctx, onToken, streaming) {
  const res = await fetch(`${cfg.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.model, stream: streaming, temperature: 0.95, top_p: 0.95,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: buildPrompt(kind, ctx) }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  if (!streaming) return (await res.json()).choices?.[0]?.message?.content || "";
  // OpenAI-style SSE: lines "data: {json}" with choices[0].delta.content, ending "data: [DONE]".
  return readLines(res, (line) => {
    if (!line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return "";
    return JSON.parse(payload).choices?.[0]?.delta?.content || "";
  }, onToken);
}

// Shared line-delimited stream reader; `extract(line)->chunk` pulls text from each line.
async function readLines(res, extract, onToken) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const chunk = extract(line); if (chunk) { full += chunk; onToken(chunk); } } catch {}
    }
  }
  return full;
}

// List models for a provider. opts: { provider, ollamaUrl, apiBaseUrl, apiKey }.
export async function listModels(opts = {}) {
  const cfg = providerCfg({ narrator: opts });
  try {
    if (cfg.provider === "api") {
      const res = await fetch(`${cfg.apiBaseUrl}/models`, {
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      return ((await res.json()).data || []).map((m) => m.id).sort();
    }
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    return ((await res.json()).models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

export const narratorInfo = { url: OLLAMA_URL, model: MODEL };
export { buildPrompt, fallback }; // exported for tests
