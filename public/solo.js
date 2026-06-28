// Solo client: one analyst vs the AI Incident Master. Reuses the same server/game
// projection; the server auto-adjudicates detection (chain order) and streams narration.

const SLOTS = ["initial", "pivot", "c2", "persist"];
const SLOT_LABEL = { initial: "Initial Compromise", pivot: "Pivot & Escalate", c2: "C2 & Exfil", persist: "Persistence" };
const $ = (id) => document.getElementById(id);
const assetUrl = (p) => (p ? "/assets/" + p : "");
const modStr = (m) => (m ? (m > 0 ? ` +${m}` : ` ${m}`) : "");

let ws, state = null, joined = false, begun = false;
let animatedRollTs = null, awaitingNarrative = false;
let narr = []; // { id, text } — client narrative list (committed + streaming)
let seeded = false;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { if (begun) sendBegin(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      state = msg.state;
      if (!seeded && state.narrative?.length) { narr = state.narrative.map((m) => ({ id: "s" + m.id, text: m.text })); seeded = true; }
      if (joined || begun) { joined = true; seeded = true; show(); render(); }
    } else if (msg.type === "narrate") {
      const e = narr.find((x) => x.id === msg.id);
      if (e) e.text = msg.text; else narr.push({ id: msg.id, text: msg.text });
      awaitingNarrative = false;
      renderNarrative();
    } else if (msg.type === "error") {
      $("join-err").textContent = msg.error;
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
const sendRaw = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function sendBegin() {
  sendRaw({ type: "joinSolo", name: $("name").value.trim() || "Analyst", theme: $("theme").value.trim(), model: $("model").value || undefined });
}

function show() { $("join").hidden = true; $("board").hidden = false; }

// ---- render ----------------------------------------------------------------

function render() {
  if (!state) return;
  const s = state;
  $("deck-name").textContent = s.deck || "";
  $("t-turn").textContent = `Turn ${s.turn}/${s.config.turnLimit}`;
  const left = Math.max(0, s.config.turnLimit - s.turn);
  const lt = $("t-left");
  lt.textContent = s.phase === "playing" ? `⏳ ${left} turn${left === 1 ? "" : "s"} left` : `⏳ limit ${s.config.turnLimit}`;
  lt.className = "track" + (s.phase === "playing" && left <= 2 ? " low" : s.phase === "playing" ? " ok" : "");
  $("t-succ").textContent = `Detected ${s.successes}/4`;
  $("t-fail").textContent = `Failures ${s.failures}`;
  const tm = $("t-mod");
  if (s.activeModifier) { tm.hidden = false; tm.className = "track bad"; tm.textContent = `🎚 ${s.activeModifier > 0 ? "+" : ""}${s.activeModifier} to rolls`; } else tm.hidden = true;
  $("t-phase").textContent = ({ setup: "Briefing", playing: "Investigating", won: "Contained — you win", lost: "Breached — you lose" })[s.phase] || "";

  renderBanner();
  renderNarrative();
  renderSlots();
  renderLastRoll();
  renderProcedures();
  renderRoll();
  renderPlayed();
  renderLog();
}

function renderBanner() {
  const b = $("banner"), s = state;
  if (s.phase === "won") { b.hidden = false; b.className = "won"; b.textContent = "🛡️ Contained — you detected the whole attack chain!"; }
  else if (s.phase === "lost") { b.hidden = false; b.className = "lost"; b.textContent = "💀 Breached — the attackers finished before you caught them."; }
  else b.hidden = true;
}

function renderNarrative() {
  const el = $("narrative");
  el.innerHTML = narr.map((m) => `<p class="narr">${escapeHtml(m.text)}</p>`).join("");
  el.scrollTop = el.scrollHeight;
  $("narrating").hidden = !awaitingNarrative;
}

function renderSlots() {
  const row = $("slot-row");
  row.innerHTML = "";
  for (const slot of SLOTS) {
    const o = state.objective[slot];
    const div = document.createElement("div");
    div.className = "slot";
    div.dataset.type = slot;
    let img;
    if (o.locked) { img = assetUrl(o.back); div.classList.add("locked"); }
    else { img = assetUrl(o.image); if (state.revealed[slot]) div.classList.add("done"); }
    div.innerHTML =
      `<div class="label">${SLOT_LABEL[slot]}</div>` +
      `<img src="${img}" alt="${slot}"${o.locked ? "" : ` data-full="${img}"`} />` +
      (o.locked ? `<div class="lockbadge">🔒</div>` : "");
    row.appendChild(div);
  }
}

function renderLastRoll() {
  const el = $("lastroll"), r = state.lastRoll;
  if (!r) { el.hidden = true; return; }
  el.hidden = false;
  el.className = r.success ? "success" : "failroll";
  const crit = r.d20 === 20 ? " crit" : r.d20 === 1 ? " fumble" : "";
  el.innerHTML =
    `<div class="die${crit}">${r.d20}</div>` +
    `<div class="roll-text"><strong>You ran “${r.procedureName}”${r.established ? " (established)" : ""}</strong>` +
    `<div class="meta">d20 ${r.d20}${r.establishedBonus ? `${modStr(r.establishedBonus)} (est)` : ""}${modStr(r.modifier)}${r.activeModifier ? `${modStr(r.activeModifier)} (inject)` : ""} = ${r.total} vs ${r.threshold} → ` +
    `${r.success ? "SUCCESS" : "no detection"}${r.d20 === 20 ? " · NAT 20!" : r.d20 === 1 ? " · NAT 1!" : ""}</div></div>`;
  if (r.ts !== animatedRollTs) { animatedRollTs = r.ts; animateDie(el.querySelector(".die"), r.d20); }
}

function animateDie(el, finalValue) {
  if (!el) return;
  el.classList.add("rolling");
  const start = performance.now();
  const iv = setInterval(() => {
    el.textContent = 1 + Math.floor(Math.random() * 20);
    if (performance.now() - start > 650) { clearInterval(iv); el.textContent = finalValue; el.classList.remove("rolling"); }
  }, 55);
}

function renderProcedures() {
  const row = $("procedures-row");
  const estIds = new Set(state.established.map((c) => c.id));
  row.innerHTML = "";
  for (const c of state.procedures) {
    const cool = state.cooldowns?.[c.id] || 0;
    const est = estIds.has(c.id);
    const wrap = document.createElement("div");
    wrap.className = "proc-card" + (cool ? " cooling" : "");
    const src = assetUrl(c.image);
    wrap.innerHTML =
      `<img class="thumb${est ? " est" : ""}" src="${src}" data-full="${src}" title="${c.name}${est ? " (established)" : ""}" />` +
      (est ? `<span class="est-tag">EST</span>` : "") +
      (cool ? `<span class="cd-badge"><span class="snow">❄</span><span class="cd-n">${cool}</span></span>` : "");
    row.appendChild(wrap);
  }
}

function renderRoll() {
  const wrap = $("roll-controls");
  wrap.hidden = state.phase !== "playing";
  if (wrap.hidden) return;
  const sel = $("proc-select");
  const estIds = new Set(state.established.map((c) => c.id));
  const prev = sel.value;
  sel.innerHTML = "";
  for (const c of state.procedures) {
    const cool = state.cooldowns?.[c.id] || 0;
    const opt = document.createElement("option");
    opt.value = c.id; opt.disabled = cool > 0;
    opt.textContent = `${c.name}${estIds.has(c.id) ? " (established +)" : ""}` + (cool ? ` ❄ ${cool}` : "");
    sel.appendChild(opt);
  }
  if (prev && !state.cooldowns?.[prev]) sel.value = prev;
  if (sel.selectedOptions[0]?.disabled) { const f = [...sel.options].find((o) => !o.disabled); if (f) sel.value = f.value; }
}

function strip(cards) {
  return cards.map((c) => { const s = assetUrl(c.image); return `<img class="thumb" src="${s}" data-full="${s}" title="${c.name}" />`; }).join("");
}
function renderPlayed() {
  let html = "";
  if (state.playedInjects.length) html += `<div class="card-group"><h3>Injects in play</h3><div class="card-strip">${strip(state.playedInjects)}</div></div>`;
  if (state.playedConsultants.length) html += `<div class="card-group"><h3>Consultants</h3><div class="card-strip">${strip(state.playedConsultants)}</div></div>`;
  $("played").innerHTML = html;
}
function renderLog() {
  $("log").innerHTML = [...state.log].reverse().map((e) => `<li>${escapeHtml(e.text)}</li>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- wiring ----------------------------------------------------------------

$("begin").addEventListener("click", () => {
  if (!$("name").value.trim()) { $("join-err").textContent = "Enter a name first"; return; }
  begun = true; awaitingNarrative = true; sendBegin();
});
$("roll-btn").addEventListener("click", () => {
  awaitingNarrative = true;
  $("narrating").hidden = false;
  sendRaw({ type: "roll", procedureId: $("proc-select").value, modifier: Number($("modifier").value) || 0 });
});
$("new-incident").addEventListener("click", () => {
  narr = []; awaitingNarrative = true; $("narrating").hidden = false; renderNarrative();
  sendRaw({ type: "newIncident" });
});

// populate the Incident Master model picker from Ollama (graceful if none)
fetch("/api/models").then((r) => r.json()).then(({ models, default: def }) => {
  const sel = $("model");
  const list = models && models.length ? models : (def ? [def] : []);
  if (!list.length) { sel.innerHTML = `<option value="">built-in fallback (Ollama offline)</option>`; return; }
  sel.innerHTML = list.map((m) => `<option value="${m}" ${m === def ? "selected" : ""}>${m}</option>`).join("");
}).catch(() => { $("model").innerHTML = `<option value="">default</option>`; });

// lightbox
(function lightbox() {
  const lb = $("lightbox"), img = $("lb-img");
  document.addEventListener("click", (e) => { const t = e.target.closest("[data-full]"); if (t) { img.src = t.getAttribute("data-full"); lb.hidden = false; } });
  lb.addEventListener("click", () => { lb.hidden = true; img.src = ""; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { lb.hidden = true; img.src = ""; } });
})();

connect();
