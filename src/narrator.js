// RPG narrator for solo mode. Calls a local Ollama model to write incident-response
// narration; if Ollama is unreachable it falls back to templated flavor text so solo
// mode always works offline.
//
// Configure with env: BNB_OLLAMA_URL (default http://localhost:11434),
// BNB_OLLAMA_MODEL (default qwen2.5:7b).

const OLLAMA_URL = process.env.BNB_OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.BNB_OLLAMA_MODEL || "qwen2.5:7b";

const SYSTEM = `You are the Incident Master narrating a cybersecurity incident-response tabletop RPG
(based on Black Hills InfoSec's "Backdoors & Breaches"). You speak to a lone blue-team
analyst. Write vivid, realistic SOC narration in 2-4 short sentences, second person ("you").
Use authentic infosec detail (logs, EDR, SIEM, DNS, C2, persistence). Stay in character —
no markdown, no preamble, no lists. Never reveal attacker techniques the analyst has not yet
detected; you may hint atmospherically.`;

// Build the user prompt for a given narration moment.
function buildPrompt(kind, ctx = {}) {
  const chain = (ctx.chain || [])
    .map((c) => `${c.stage}=${c.revealed ? c.name : "[undetected]"}`)
    .join(", ");
  const theme = ctx.theme ? `Organization/theme: ${ctx.theme}.` : "";
  switch (kind) {
    case "intro":
      return `${theme} A new incident is opening. The full (hidden) attack chain is: ${(ctx.chain || [])
        .map((c) => `${c.stage}=${c.name}`)
        .join(", ")}. Do NOT name these techniques. Set the scene: how the organization first
        notices something is wrong, and the unease in the SOC. 3-4 sentences.`;
    case "success":
      return `${theme} The analyst ran the procedure "${ctx.procedure}" and SUCCEEDED (rolled
        ${ctx.total} vs ${ctx.threshold}). This detected the ${ctx.stage} stage of the attack:
        "${ctx.card}". Narrate what they uncovered, tie it specifically to "${ctx.procedure}",
        and hint at a plausible next investigative step. 2-3 sentences.`;
    case "nodetect":
      return `${theme} The analyst ran "${ctx.procedure}" and it SUCCEEDED mechanically but found
        nothing new this round. Briefly narrate a dead end that still feels productive. 1-2 sentences.`;
    case "failure":
      return `${theme} The analyst ran "${ctx.procedure}" and it FAILED (rolled ${ctx.total} vs
        ${ctx.threshold}). Give a concrete, believable real-world reason the investigation hit a
        wall — e.g. the EDR license lapsed, those logs were never forwarded to the SIEM, the
        retention window already rolled off, a sensor was misconfigured, or alert fatigue buried
        it. 2 sentences. Current state: ${chain}.`;
    case "inject":
      return `${theme} A complication just struck the SOC: "${ctx.inject}". Narrate it landing
        mid-investigation. 2 sentences.`;
    case "win":
      return `${theme} The analyst has now detected the entire attack chain and can contain it.
        Narrate the decisive containment and a beat of relief. 2-3 sentences.`;
    case "lose":
      return `${theme} Time ran out. The attackers completed their objective undetected. Narrate
        the grim morning-after discovery. 2-3 sentences.`;
    default:
      return `Narrate the current moment in the incident. 2 sentences.`;
  }
}

// Offline / failure templates — varied by a deterministic-ish index so it isn't identical.
function fallback(kind, ctx = {}) {
  const p = ctx.procedure || "the procedure";
  const card = ctx.card || "the activity";
  const FB = {
    intro: [
      "It starts with a ticket nobody wants: scattered alerts, a few odd logins, a help-desk note about a 'slow' laptop. Nothing screams compromise — but the pattern is wrong. You pull up the consoles and start your shift as incident lead.",
    ],
    success: [
      `Your ${p} pays off — you surface ${card} in the telemetry. The artifacts line up into a clear lead; follow the trail toward how they moved next.`,
      `${p} lights up exactly where you hoped. ${card} is now on the board, and it points you deeper into the kill chain.`,
    ],
    nodetect: [`${p} comes back clean this round — useful for ruling things out, but the trail stays cold.`],
    failure: [
      `Your ${p} turns up nothing — turns out those logs were never forwarded to the SIEM, so the evidence simply isn't there.`,
      `${p} stalls: the EDR agent's license lapsed last quarter and was never renewed on that segment, leaving you blind.`,
      `Dead end. The retention window already rolled off the data you needed, and no one budgeted for longer storage.`,
      `A sensor on that VLAN was misconfigured during the last migration, so ${p} sees only a fraction of the traffic.`,
    ],
    inject: [`A wrench hits the works: "${ctx.inject || "an inject"}." The team scrambles to adapt mid-hunt.`],
    win: ["The last piece clicks into place. You scope it end to end, cut the attacker's access, and start eviction. The room exhales — this one's contained."],
    lose: ["The clock beats you. By morning the data's gone and the foothold is entrenched; now it's a recovery problem, not a detection one."],
  };
  const arr = FB[kind] || ["The investigation continues."];
  const idx = ((ctx.turn || ctx.seed || 0) % arr.length + arr.length) % arr.length;
  return arr[idx];
}

// Narrate a moment. If `onToken(textChunk)` is supplied, streams from Ollama and calls
// it per chunk (typewriter); returns the full text. ctx.model overrides the default model.
export async function narrate(kind, ctx = {}, onToken) {
  const streaming = typeof onToken === "function";
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.model || MODEL,
        system: SYSTEM,
        prompt: buildPrompt(kind, ctx),
        stream: streaming,
        options: { temperature: 0.85, num_predict: 220 },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);

    if (!streaming) {
      const data = await res.json();
      return (data.response || "").trim() || fallback(kind, ctx);
    }

    // Stream NDJSON: each line is {response, done}.
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
        try {
          const j = JSON.parse(line);
          if (j.response) { full += j.response; onToken(j.response); }
        } catch {}
      }
    }
    const text = full.trim();
    if (text) return text;
    const fb = fallback(kind, ctx);
    onToken(fb);
    return fb;
  } catch {
    const fb = fallback(kind, ctx);
    if (streaming) onToken(fb); // still surface it in the typewriter pane
    return fb;
  }
}

export async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

export const narratorInfo = { url: OLLAMA_URL, model: MODEL };
export { buildPrompt, fallback }; // exported for tests
