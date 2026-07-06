// Role-aware client. Connects over WS, renders whatever role-filtered projection
// the server sends. Un-revealed objective cards simply aren't in the data for
// players/viewers, so there is nothing to "peek" at in the DOM.

import { loadSettings, renderSettings } from "/settings.js";

const isGmPage = location.pathname === "/gm";
const SLOTS = ["initial", "pivot", "c2", "persist"];
const SLOT_LABEL = { initial: "Initial Compromise", pivot: "Pivot & Escalate", c2: "C2 & Exfil", persist: "Persistence" };

const $ = (id) => document.getElementById(id);
const assetUrl = (p) => (p ? "/assets/" + p : "");
let ws, state = null, joined = false;
let myJoin = null; // { role, name, pin } — remembered so we can re-join after a reconnect
let chat = []; // role-filtered chat, updated on its own channel
let animatedRollTs = null; // so the d20 animation only fires on a genuinely new roll
let narr = []; // shared AI narrative (team mode), driven by "narrate" events
let narrSeeded = false, narrSetup = false, awaitingNarr = false;

// ---- connection ------------------------------------------------------------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { if (myJoin) sendJoin(); }; // re-establish our seat after a reconnect
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      state = msg.state;
      if (state.chat) chat = state.chat;
      if (!narrSeeded && state.narrative?.length) { narr = state.narrative.map((m) => ({ id: "s" + m.id, text: m.text })); narrSeeded = true; }
      render();
    } else if (msg.type === "chat") {
      chat = msg.messages;
      renderChat();
    } else if (msg.type === "narrate") {
      const e = narr.find((x) => x.id === msg.id);
      if (e) e.text = msg.text; else { narr.push({ id: msg.id, text: msg.text }); narrSeeded = true; }
      awaitingNarr = false;
      renderNarrative();
    } else if (msg.type === "error") {
      showError(msg.error);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

function sendJoin() {
  if (!myJoin) return;
  const m = { type: "join", role: myJoin.role, name: myJoin.name };
  if (myJoin.role === "gm") m.pin = myJoin.pin;
  send(m);
}

function send(obj) { ws.readyState === 1 && ws.send(JSON.stringify(obj)); }

function showError(text) {
  if (!joined) { $("join-err").textContent = text; return; }
  const b = $("banner");
  b.hidden = false; b.className = "nudge"; b.textContent = "⚠ " + text;
  setTimeout(() => renderBanner(), 2500);
}

// ---- join ------------------------------------------------------------------

function setupJoin() {
  $("join-sub").textContent = isGmPage ? "Game Master entrance" : "Choose how to join";
  $("gm-pick").hidden = !isGmPage;
  $("role-pick").hidden = isGmPage;
  document.querySelectorAll(".role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.dataset.role;
      const name = $("name").value.trim();
      if (!name) { showError("Enter a name first"); return; }
      myJoin = { role, name, pin: role === "gm" ? $("pin").value.trim() : undefined };
      sendJoin();
    });
  });
}

function updateJoinCounts() {
  if (!state || joined) return;
  const c = state.counts, cap = state.capacity;
  $("cnt-player").textContent = `${c.player}/${cap.playerMax}`;
  $("cnt-viewer").textContent = `${c.viewer}`;
  if ($("cnt-gm")) $("cnt-gm").textContent = `${c.gm}/${cap.gm}`;
  const pBtn = document.querySelector('[data-role="player"]');
  if (pBtn) { pBtn.disabled = c.player >= cap.playerMax; if (pBtn.disabled) pBtn.querySelector("span").textContent = "Team full"; }
  const gBtn = document.querySelector('[data-role="gm"]');
  if (gBtn) { gBtn.disabled = c.gm >= cap.gm; if (gBtn.disabled) gBtn.querySelector("span").textContent = "Both GM seats taken"; }
}

// We learn we're "in" when the server reports our chosen role as our `you.role`.
function checkJoined() {
  if (!myJoin) return;
  if (state?.you?.role === myJoin.role) {
    if (!joined) {
      joined = true;
      $("join").hidden = true;
      $("board").hidden = false;
    }
  }
}

// ---- render ----------------------------------------------------------------

function render() {
  updateJoinCounts();
  checkJoined();
  if (!joined) return;
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
  if (s.activeModifier) { tm.hidden = false; tm.className = "track bad"; tm.textContent = `🎚 ${s.activeModifier > 0 ? "+" : ""}${s.activeModifier} to rolls`; }
  else tm.hidden = true;
  $("t-phase").textContent = ({ setup: "Setup", playing: "In progress", won: "Defenders win", lost: "Attackers win" })[s.phase];
  $("t-seats").textContent = `GM ${s.counts.gm}/${s.capacity.gm} · Def ${s.counts.player}/${s.capacity.playerMax} · 👁 ${s.counts.viewer}`;
  renderBanner();
  renderSlots();
  renderLastRoll();
  renderProcedures();
  renderRollControls();
  renderPlayed();
  renderLog();
  renderChat();
  renderNarrative();
  renderGmNarration();
  renderGmPanel();
}

// ---- AI narration (team) ---------------------------------------------------

function renderNarrative() {
  const sec = $("narrative-sec");
  if (!sec) return;
  sec.hidden = !(narr.length || state.narrationOn);
  const el = $("narrative");
  el.innerHTML = narr.map((m) => `<p class="narr">${escapeHtml(m.text)}</p>`).join("");
  el.scrollTop = el.scrollHeight;
  $("narrating").hidden = !awaitingNarr;
}

function renderGmNarration() {
  const sec = $("gm-narration");
  if (!sec) return;
  const isGm = state.you.role === "gm";
  sec.hidden = !isGm;
  if (!isGm) return;
  if (!narrSetup) { renderSettings($("settings-host")); narrSetup = true; }
  const toggle = $("narr-toggle");
  if (document.activeElement !== toggle) toggle.checked = !!state.narrationOn;
  if (!toggle.dataset.wired) {
    toggle.dataset.wired = "1";
    toggle.addEventListener("change", () => send({ type: "setNarration", on: toggle.checked, narrator: loadSettings() }));
  }
}

// ---- chat ------------------------------------------------------------------

const ROLE_ICON = { gm: "🎴", player: "🛡️", viewer: "👁️" };

function renderChat() {
  const log = $("chat-log");
  if (!log || !state) return;
  const isGm = state.you.role === "gm";
  $("chat-scope").textContent = isGm
    ? "— you see all channels"
    : state.you.role === "viewer"
    ? "— viewers only"
    : "— your team";
  // GM gets a channel target selector
  const chan = $("chat-channel");
  chan.hidden = !isGm;
  if (isGm && !chan.dataset.ready) {
    chan.innerHTML = `<option value="players">→ Team</option><option value="viewers">→ Viewers</option>`;
    chan.dataset.ready = "1";
  }
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.innerHTML = chat
    .map(
      (m) =>
        `<li class="msg ch-${m.channel} role-${m.role}"><span class="who">${ROLE_ICON[m.role] || ""} ${escapeHtml(m.from)}` +
        (isGm ? ` <em class="chtag">${m.channel === "viewers" ? "viewers" : "team"}</em>` : "") +
        `</span> ${escapeHtml(m.text)}</li>`
    )
    .join("");
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setupChat() {
  const input = $("chat-input"), send_ = () => {
    const text = input.value.trim();
    if (!text || !joined) return;
    const m = { type: "chat", text };
    if (state?.you?.role === "gm") m.channel = $("chat-channel").value;
    send(m);
    input.value = "";
  };
  $("chat-send").addEventListener("click", send_);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send_(); } });
}

function renderBanner() {
  const b = $("banner"), s = state;
  if (s.phase === "won") { b.hidden = false; b.className = "won"; b.textContent = "🛡️ Defenders win — full attack chain detected!"; }
  else if (s.phase === "lost") { b.hidden = false; b.className = "lost"; b.textContent = "💀 Attackers win — out of time."; }
  else if (s.awaitingReveal && s.you.role !== "gm") { b.hidden = false; b.className = "nudge"; b.textContent = "🔍 A detection is being confirmed by the Game Master…"; }
  else if (s.injectNudge) { b.hidden = false; b.className = "nudge"; b.textContent = `⚠ ${s.consecutiveFails} failed rolls in a row — Game Master may play an Inject.`; }
  else b.hidden = true;
}

function renderSlots() {
  const row = $("slot-row");
  row.innerHTML = "";
  const isGm = state.you.role === "gm";
  for (const slot of SLOTS) {
    const o = state.objective[slot];
    const div = document.createElement("div");
    div.className = "slot";
    div.dataset.type = slot;
    let img;
    if (o.locked) {
      img = assetUrl(o.back);
      div.classList.add("locked");
    } else {
      img = assetUrl(o.image);
      if (state.revealed[slot]) div.classList.add("done");
      if (isGm && !state.revealed[slot]) div.classList.add("gmsecret");
    }
    div.innerHTML =
      `<div class="label">${SLOT_LABEL[slot]}</div>` +
      `<img src="${img}" alt="${slot}"${o.locked ? "" : ` data-full="${img}"`} />` +
      (o.locked ? `<div class="lockbadge">🔒</div>` : "");
    if (isGm && state.phase === "playing" && !state.revealed[slot]) {
      const btn = document.createElement("button");
      btn.className = "reveal-btn";
      btn.textContent = "✔ Detected — reveal to all";
      btn.onclick = () => send({ type: "reveal", slot });
      div.appendChild(btn);
    }
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
    `<div class="roll-text"><strong>${r.playerName} ran “${r.procedureName}”${r.established ? " (established)" : ""}</strong>` +
    `<div class="meta">d20 ${r.d20}${r.establishedBonus ? `${modStr(r.establishedBonus)} (est)` : ""}${modStr(r.modifier)}${r.activeModifier ? `${modStr(r.activeModifier)} (inject)` : ""} = ${r.total} vs ${r.threshold} → ` +
    `${r.success ? "SUCCESS" : "no detection"}${r.d20 === 20 ? " · NAT 20!" : r.d20 === 1 ? " · NAT 1!" : ""}</div></div>`;
  // animate only when this is a brand-new roll
  if (r.ts !== animatedRollTs) { animatedRollTs = r.ts; animateDie(el.querySelector(".die"), r.d20); }
}

const modStr = (m) => (m ? (m > 0 ? ` +${m}` : ` ${m}`) : "");

// Tumble through random faces, then settle on the final value.
function animateDie(el, finalValue) {
  if (!el) return;
  el.classList.add("rolling");
  const start = performance.now();
  const iv = setInterval(() => {
    el.textContent = 1 + Math.floor(Math.random() * 20);
    if (performance.now() - start > 650) {
      clearInterval(iv);
      el.textContent = finalValue;
      el.classList.remove("rolling");
    }
  }, 55);
}

// All procedures (established highlighted + non-established shown), with cooldown overlay.
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

function renderRollControls() {
  const wrap = $("roll-controls");
  const canRoll = (state.you.role === "player" || state.you.role === "gm") && state.phase === "playing";
  wrap.hidden = !canRoll;
  if (!canRoll) return;
  const sel = $("proc-select");
  const estIds = new Set(state.established.map((c) => c.id));
  const prev = sel.value;
  sel.innerHTML = "";
  for (const c of state.procedures) {
    const cool = state.cooldowns?.[c.id] || 0;
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.disabled = cool > 0;
    opt.textContent =
      `${c.name}${estIds.has(c.id) ? " (established +)" : ""}` + (cool ? ` ❄ cooldown ${cool}` : "");
    sel.appendChild(opt);
  }
  // keep previous selection if still rollable, else jump to first available option
  if (prev && !state.cooldowns?.[prev]) sel.value = prev;
  if (sel.selectedOptions[0]?.disabled) {
    const firstOpen = [...sel.options].find((o) => !o.disabled);
    if (firstOpen) sel.value = firstOpen.value;
  }
  $("roll-btn").onclick = () => {
    if (state.narrationOn) { awaitingNarr = true; $("narrating").hidden = false; }
    send({ type: "roll", procedureId: sel.value, modifier: Number($("modifier").value) || 0 });
  };
}

function strip(cards) {
  return cards
    .map((c) => { const s = assetUrl(c.image); return `<img class="thumb" src="${s}" data-full="${s}" title="${c.name}" />`; })
    .join("");
}

function renderPlayed() {
  const el = $("played");
  let html = "";
  if (state.playedInjects.length) html += `<div class="card-group"><h3>Injects in play</h3><div class="card-strip">${strip(state.playedInjects)}</div></div>`;
  if (state.playedConsultants.length) html += `<div class="card-group"><h3>Consultants</h3><div class="card-strip">${strip(state.playedConsultants)}</div></div>`;
  el.innerHTML = html;
}

function renderLog() {
  const ul = $("log");
  ul.innerHTML = "";
  for (const e of [...state.log].reverse()) {
    const li = document.createElement("li");
    li.textContent = e.text;
    ul.appendChild(li);
  }
}

// ---- GM panel --------------------------------------------------------------

function renderGmPanel() {
  const panel = $("gm-panel");
  if (state.you.role !== "gm") { panel.hidden = true; return; }
  panel.hidden = false;
  const s = state, g = s.gm;
  const opt = (cards, sel) => cards.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${c.name}</option>`).join("");
  const curObj = {};
  for (const slot of SLOTS) curObj[slot] = s.objective[slot]?.id;

  let html = `<h2>🎴 Game Master Controls</h2>`;

  if (s.phase === "setup") {
    html += `<div class="gm-block"><h3>1 · Deck</h3><div class="gm-row">
      <select id="gm-deck">${s.you.decks.map((d) => `<option ${d === s.you.deck ? "selected" : ""}>${d}</option>`).join("")}</select>
      <button class="gm-btn" id="gm-randomize">🎲 Randomize whole scenario</button></div></div>`;

    html += `<div class="gm-block"><h3>2 · Attack chain (hidden objective)</h3>`;
    for (const slot of SLOTS) {
      html += `<div class="gm-row"><label>${SLOT_LABEL[slot]}<select data-obj="${slot}">${opt(g.builder[slot], curObj[slot])}</select></label></div>`;
    }
    html += `<h3>Established procedures (pick 4)</h3><div class="gm-row" id="gm-est">`;
    const est = new Set(s.established.map((c) => c.id));
    for (const c of g.builder.procedure) {
      html += `<label style="flex-direction:row;gap:.3rem"><input type="checkbox" data-est="${c.id}" ${est.has(c.id) ? "checked" : ""}/>${c.name}</label>`;
    }
    html += `</div>`;

    html += `<h3>Detection map <small>(optional — enables auto-reveal)</small></h3>
      <p class="warn">For each attack card, pick the procedures that detect it (listed on the card art). Ctrl/⌘-click for multiple. Leave blank to reveal manually.</p>`;
    for (const slot of SLOTS) {
      const sel = new Set(s.gm.detection?.[slot] || []);
      html += `<div class="gm-row"><label>${SLOT_LABEL[slot]}
        <select multiple size="4" data-det="${slot}">
        ${g.builder.procedure.map((c) => `<option value="${c.id}" ${sel.has(c.id) ? "selected" : ""}>${c.name}</option>`).join("")}
        </select></label></div>`;
    }

    html += `<div class="gm-row"><button class="gm-btn gold" id="gm-apply">Apply scenario</button></div></div>`;

    html += `<div class="gm-block"><h3>3 · Rules</h3><div class="gm-row">
      <label>Turn limit<input type="number" id="cfg-turnLimit" value="${s.config.turnLimit}"/></label>
      <label>Success ≥<input type="number" id="cfg-successThreshold" value="${s.config.successThreshold}"/></label>
      <label>Established +<input type="number" id="cfg-establishedBonus" min="0" value="${s.config.establishedBonus}"/></label>
      <label>Inject nudge<input type="number" id="cfg-injectNudgeAfterFails" value="${s.config.injectNudgeAfterFails}"/></label>
      <label>Cooldown turns<input type="number" id="cfg-cooldownTurns" min="0" value="${s.config.cooldownTurns}"/></label>
      <button class="gm-btn" id="gm-cfg">Save rules</button></div>
      <p class="warn">Cooldown: a procedure can't be re-rolled for this many turns (0 = off).</p></div>`;

    const few = s.counts.player < s.capacity.playerMin;
    html += `<div class="gm-block"><h3>4 · Start</h3>`;
    if (few) html += `<p class="warn">Need ${s.capacity.playerMin}+ players (currently ${s.counts.player}). Check “force” to start anyway.</p>
      <div class="gm-row"><label style="flex-direction:row;gap:.3rem"><input type="checkbox" id="gm-force"/>Force start</label></div>`;
    html += `<div class="gm-row"><button class="gm-btn gold" id="gm-start">▶ Start incident</button></div></div>`;
  } else {
    if (s.gm.pendingReveal) {
      const pr = s.gm.pendingReveal;
      html += `<div class="gm-block reveal-prompt"><h3>🔍 “${pr.procedureName}” detected a card — reveal which?</h3><div class="gm-row">`;
      for (const slot of pr.options) html += `<button class="gm-btn gold" data-revealopt="${slot}">Reveal ${SLOT_LABEL[slot]}</button>`;
      html += `<button class="gm-btn" id="gm-dismiss-reveal">No detection</button></div></div>`;
    }
    html += `<div class="gm-block"><h3>Active roll modifier</h3><div class="gm-row">
      <input type="number" id="gm-modval" value="${s.activeModifier || 0}" style="width:5rem" />
      <button class="gm-btn" id="gm-setmod">Set</button>
      <button class="gm-btn" id="gm-clearmod">Clear</button>
      </div><p class="warn">Added to every roll — e.g. an inject that says “−3 to all procedures”.</p></div>`;
    html += `<div class="gm-block"><h3>Play an Inject</h3><div class="gm-row">
      <select id="gm-inject">${opt(g.builder.inject)}</select>
      <label>roll mod<input type="number" id="gm-inject-mod" value="0" style="width:4rem" /></label>
      <button class="gm-btn" id="gm-play-inject">Play inject</button></div>
      <p class="warn">Set “roll mod” if this inject changes rolls (e.g. −3); leave 0 otherwise.</p></div>`;
    html += `<div class="gm-block"><h3>Bring a Consultant</h3><div class="gm-row">
      <select id="gm-consultant">${opt(g.builder.consultant)}</select><button class="gm-btn" id="gm-play-consultant">Play consultant</button></div></div>`;
    html += `<div class="gm-block"><h3>Note to the table</h3><div class="gm-row">
      <input id="gm-note" placeholder="Narrate something…" style="flex:1"/><button class="gm-btn" id="gm-add-note">Post</button></div>
      <div class="gm-row"><label>Turn limit<input type="number" id="cfg2-turnLimit" value="${s.config.turnLimit}"/></label>
      <label>Cooldown turns<input type="number" id="cfg2-cooldownTurns" min="0" value="${s.config.cooldownTurns}"/></label>
      <button class="gm-btn" id="gm-cfg2">Update rules</button></div></div>`;
    html += `<div class="gm-block"><button class="gm-btn danger" id="gm-reset">↺ Reset game</button></div>`;
  }
  panel.innerHTML = html;
  wireGmPanel();
}

function wireGmPanel() {
  const click = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  click("gm-randomize", () => send({ type: "setup", deck: $("gm-deck").value }));
  click("gm-apply", () => {
    const objective = {};
    document.querySelectorAll("[data-obj]").forEach((s) => (objective[s.dataset.obj] = s.value));
    const established = [...document.querySelectorAll("[data-est]:checked")].map((c) => c.dataset.est);
    if (established.length !== 4) { showError("Pick exactly 4 established procedures"); return; }
    const detection = {};
    document.querySelectorAll("[data-det]").forEach((sel) => {
      detection[sel.dataset.det] = [...sel.selectedOptions].map((o) => o.value);
    });
    send({ type: "setup", deck: $("gm-deck").value, objective, established, detection });
  });
  document.querySelectorAll("[data-revealopt]").forEach((b) => (b.onclick = () => send({ type: "reveal", slot: b.dataset.revealopt })));
  click("gm-dismiss-reveal", () => send({ type: "dismissReveal" }));
  click("gm-cfg", () => send({ type: "config", config: readCfg("cfg-") }));
  click("gm-cfg2", () => send({ type: "config", config: readCfg("cfg2-") }));
  click("gm-start", () => send({ type: "start", force: $("gm-force")?.checked }));
  click("gm-play-inject", () => send({ type: "playInject", cardId: $("gm-inject").value, modifier: Number($("gm-inject-mod").value) || 0 }));
  click("gm-setmod", () => send({ type: "setModifier", value: Number($("gm-modval").value) || 0 }));
  click("gm-clearmod", () => send({ type: "setModifier", value: 0 }));
  click("gm-play-consultant", () => send({ type: "playConsultant", cardId: $("gm-consultant").value }));
  click("gm-add-note", () => { send({ type: "note", text: $("gm-note").value }); $("gm-note").value = ""; });
  click("gm-reset", () => confirm("Reset to a fresh game?") && send({ type: "reset" }));
}

function readCfg(prefix) {
  const keys = ["turnLimit", "successThreshold", "establishedBonus", "injectNudgeAfterFails", "cooldownTurns"];
  const out = {};
  for (const k of keys) { const el = $(prefix + k); if (el) out[k] = Number(el.value); }
  return out;
}

// ---- lightbox (click any [data-full] card to enlarge) ----------------------

function setupLightbox() {
  const lb = $("lightbox"), img = $("lb-img");
  const open = (src) => { img.src = src; lb.hidden = false; };
  const close = () => { lb.hidden = true; img.src = ""; };
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-full]");
    if (t) { open(t.getAttribute("data-full")); return; }
  });
  lb.addEventListener("click", close); // click backdrop or close button
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

// ---- boot ------------------------------------------------------------------

setupJoin();
setupLightbox();
setupChat();
connect();
