// Role-aware client. Connects over WS, renders whatever role-filtered projection
// the server sends. Un-revealed objective cards simply aren't in the data for
// players/viewers, so there is nothing to "peek" at in the DOM.

const isGmPage = location.pathname === "/gm";
const SLOTS = ["initial", "pivot", "c2", "persist"];
const SLOT_LABEL = { initial: "Initial Compromise", pivot: "Pivot & Escalate", c2: "C2 & Exfil", persist: "Persistence" };

const $ = (id) => document.getElementById(id);
const assetUrl = (p) => (p ? "/assets/" + p : "");
let ws, state = null, joined = false;
let myJoin = null; // { role, name, pin } — remembered so we can re-join after a reconnect

// ---- connection ------------------------------------------------------------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { if (myJoin) sendJoin(); }; // re-establish our seat after a reconnect
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") {
      state = msg.state;
      render();
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
  $("t-succ").textContent = `Detected ${s.successes}/4`;
  $("t-fail").textContent = `Failures ${s.failures}`;
  $("t-phase").textContent = ({ setup: "Setup", playing: "In progress", won: "Defenders win", lost: "Attackers win" })[s.phase];
  $("t-seats").textContent = `GM ${s.counts.gm}/${s.capacity.gm} · Def ${s.counts.player}/${s.capacity.playerMax} · 👁 ${s.counts.viewer}`;
  renderBanner();
  renderSlots();
  renderLastRoll();
  renderEstablished();
  renderRollControls();
  renderPlayed();
  renderLog();
  renderGmPanel();
}

function renderBanner() {
  const b = $("banner"), s = state;
  if (s.phase === "won") { b.hidden = false; b.className = "won"; b.textContent = "🛡️ Defenders win — full attack chain detected!"; }
  else if (s.phase === "lost") { b.hidden = false; b.className = "lost"; b.textContent = "💀 Attackers win — out of time."; }
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
      `<img src="${img}" alt="${slot}" />` +
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
  el.innerHTML =
    `<div class="die">${r.d20}</div>` +
    `<div class="roll-text"><strong>${r.playerName} ran “${r.procedureName}”${r.established ? " (established)" : ""}</strong>` +
    `<div class="meta">d20 ${r.d20}${r.modifier ? (r.modifier > 0 ? ` +${r.modifier}` : ` ${r.modifier}`) : ""} = ${r.total} vs ${r.threshold} → ` +
    `${r.success ? "SUCCESS" : "no detection"}</div></div>`;
}

function renderEstablished() {
  const row = $("established-row");
  row.innerHTML = "";
  for (const c of state.established) {
    const img = document.createElement("img");
    img.className = "thumb est"; img.src = assetUrl(c.image); img.title = c.name;
    row.appendChild(img);
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
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.name}${estIds.has(c.id) ? "  (established +)" : ""}`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
  $("roll-btn").onclick = () =>
    send({ type: "roll", procedureId: sel.value, modifier: Number($("modifier").value) || 0 });
}

function strip(cards) {
  return cards.map((c) => `<img class="thumb" src="${assetUrl(c.image)}" title="${c.name}" />`).join("");
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
    html += `</div><div class="gm-row"><button class="gm-btn gold" id="gm-apply">Apply scenario</button></div></div>`;

    html += `<div class="gm-block"><h3>3 · Rules</h3><div class="gm-row">
      <label>Turn limit<input type="number" id="cfg-turnLimit" value="${s.config.turnLimit}"/></label>
      <label>Established ≥<input type="number" id="cfg-establishedThreshold" value="${s.config.establishedThreshold}"/></label>
      <label>Not-est ≥<input type="number" id="cfg-unestablishedThreshold" value="${s.config.unestablishedThreshold}"/></label>
      <label>Inject nudge<input type="number" id="cfg-injectNudgeAfterFails" value="${s.config.injectNudgeAfterFails}"/></label>
      <button class="gm-btn" id="gm-cfg">Save rules</button></div></div>`;

    const few = s.counts.player < s.capacity.playerMin;
    html += `<div class="gm-block"><h3>4 · Start</h3>`;
    if (few) html += `<p class="warn">Need ${s.capacity.playerMin}+ players (currently ${s.counts.player}). Check “force” to start anyway.</p>
      <div class="gm-row"><label style="flex-direction:row;gap:.3rem"><input type="checkbox" id="gm-force"/>Force start</label></div>`;
    html += `<div class="gm-row"><button class="gm-btn gold" id="gm-start">▶ Start incident</button></div></div>`;
  } else {
    html += `<div class="gm-block"><h3>Play an Inject</h3><div class="gm-row">
      <select id="gm-inject">${opt(g.builder.inject)}</select><button class="gm-btn" id="gm-play-inject">Play inject</button></div></div>`;
    html += `<div class="gm-block"><h3>Bring a Consultant</h3><div class="gm-row">
      <select id="gm-consultant">${opt(g.builder.consultant)}</select><button class="gm-btn" id="gm-play-consultant">Play consultant</button></div></div>`;
    html += `<div class="gm-block"><h3>Note to the table</h3><div class="gm-row">
      <input id="gm-note" placeholder="Narrate something…" style="flex:1"/><button class="gm-btn" id="gm-add-note">Post</button></div>
      <div class="gm-row"><label>Turn limit<input type="number" id="cfg2-turnLimit" value="${s.config.turnLimit}"/></label>
      <button class="gm-btn" id="gm-cfg2">Update limit</button></div></div>`;
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
    send({ type: "setup", deck: $("gm-deck").value, objective, established });
  });
  click("gm-cfg", () => send({ type: "config", config: readCfg("cfg-") }));
  click("gm-cfg2", () => send({ type: "config", config: { turnLimit: Number($("cfg2-turnLimit").value) } }));
  click("gm-start", () => send({ type: "start", force: $("gm-force")?.checked }));
  click("gm-play-inject", () => send({ type: "playInject", cardId: $("gm-inject").value }));
  click("gm-play-consultant", () => send({ type: "playConsultant", cardId: $("gm-consultant").value }));
  click("gm-add-note", () => { send({ type: "note", text: $("gm-note").value }); $("gm-note").value = ""; });
  click("gm-reset", () => confirm("Reset to a fresh game?") && send({ type: "reset" }));
}

function readCfg(prefix) {
  const keys = ["turnLimit", "establishedThreshold", "unestablishedThreshold", "injectNudgeAfterFails"];
  const out = {};
  for (const k of keys) { const el = $(prefix + k); if (el) out[k] = Number(el.value); }
  return out;
}

// ---- boot ------------------------------------------------------------------

setupJoin();
connect();
