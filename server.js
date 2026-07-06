// Local LAN server for Backdoors & Breaches.
//   - serves the no-build SPA (public/) and card art (assets/)
//   - one WebSocket endpoint; one in-memory Game; role-filtered broadcasts
//
// The hidden-objective guarantee is enforced here by sending each socket only
// game.project(theirRole) — un-revealed objective cards are never serialized to
// player/viewer sockets.

import http from "node:http";
import { readFile, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";
import { Game, SLOTS } from "./src/game.js";
import { narrate, narratorInfo, listModels } from "./src/narrator.js";
import { buildScenario } from "./src/scenario.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const GM_PIN = String(process.env.BNB_PIN || Math.floor(1000 + Math.random() * 9000));
const ASSETS = join(__dirname, "assets");
const PUBLIC = join(__dirname, "public");

// Map carddb back-image fields to objective/card-type slots.
const BACK_FIELDS = { initial: "red", pivot: "yellow", c2: "brown", persist: "purple", inject: "grey", consultant: "green" };

function listDecks() {
  const dir = join(ASSETS, "decks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, "carddb.json")));
}

function loadCatalog(deck) {
  const dbPath = join(ASSETS, "decks", deck, "carddb.json");
  const db = JSON.parse(readFileSync(dbPath, "utf8"));
  const cards = db.data.map((c) => ({ id: c.id, name: c.name, image: c.image, type: c.type }));
  const backs = {};
  for (const [slot, field] of Object.entries(BACK_FIELDS)) backs[slot] = db[field];
  return { deckTitle: db.title || deck, deckKey: deck, cards, backs, link: db.link };
}

// --- Room: holds the current Game, swaps decks while preserving membership ---

class Room {
  constructor(deck) {
    this.decks = listDecks();
    this.deck = this.decks.includes(deck) ? deck : this.decks[0];
    this.game = new Game(loadCatalog(this.deck));
    this.sockets = new Map(); // connId -> ws
    this.narrSeq = 0; // narration entry counter
    this.narratorCfg = undefined; // narrator provider/model config
    this.narrationOn = false; // GM-enabled AI narration (team mode)
  }

  changeDeck(deck) {
    if (!this.decks.includes(deck) || deck === this.deck) return;
    const config = this.game.state.config;
    const members = [...this.game.players.values()]; // {id,name,role}
    this.deck = deck;
    this.game = new Game(loadCatalog(deck));
    this.game.state.config = { ...config };
    for (const m of members) this.game.join(m.id, { name: m.name, role: m.role });
  }

  broadcast() {
    for (const [connId, ws] of this.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const role = this.game.roleOf(connId) || "viewer";
      const proj = this.game.project(role);
      proj.you = { role, deck: this.deck, decks: this.decks };
      proj.narrationOn = this.narrationOn;
      ws.send(JSON.stringify({ type: "state", state: proj }));
    }
  }

  // Chat is pushed on its own channel so it doesn't trigger a full board re-render
  // (which would reset any in-progress GM panel selections).
  broadcastChat() {
    for (const [connId, ws] of this.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const role = this.game.roleOf(connId) || "viewer";
      ws.send(JSON.stringify({ type: "chat", messages: this.game.chatFor(role) }));
    }
  }
}

const DEFAULT_DECK = process.env.BNB_DECK || "CoreV3.1";
const teamRoom = new Room(DEFAULT_DECK);
const soloRooms = new Map(); // connId -> Room (one private solo game per player)
const roomFor = (connId) => soloRooms.get(connId) || teamRoom;

// --- solo narration helpers -------------------------------------------------

function chainCtx(game) {
  return SLOTS.map((s) => ({
    stage: s,
    name: game.byId.get(game.state.objective[s])?.name || "?",
    revealed: game.state.revealed[s],
  }));
}

// Stream one narration entry token-by-token to the solo player, then commit it to state.
// Keep only known narrator fields; never log/broadcast the API key.
function sanitizeNarrator(n = {}, legacyModel) {
  n = n || {};
  const s = (v, len) => (v ? String(v).slice(0, len) : undefined);
  return {
    provider: n.provider === "api" ? "api" : "ollama",
    ollamaUrl: s(n.ollamaUrl, 200),
    apiBaseUrl: s(n.apiBaseUrl, 200),
    apiKey: s(n.apiKey, 500),
    model: s(n.model || legacyModel, 120),
  };
}

async function narrateInto(room, kind, extra = {}) {
  const g = room.game;
  const id = ++room.narrSeq;
  const toAll = (obj) => { for (const w of room.sockets.values()) send(w, obj); };
  const recent = g.state.narrative.length ? g.state.narrative[g.state.narrative.length - 1].text : "";
  const ctx = {
    chain: chainCtx(g),
    theme: room.theme,
    scenario: room.scenario,
    recent,
    nonce: Math.floor(Math.random() * 1e6),
    turn: g.state.turn,
    narrator: room.narratorCfg,
    ...extra,
  };
  let acc = "";
  await narrate(kind, ctx, (tok) => { acc += tok; toAll({ type: "narrate", id, text: acc, done: false }); });
  g.addNarrative(acc);
  toAll({ type: "narrate", id, text: acc, done: true });
}

// After a roll (solo or narrated team game): narrate outcome, then inject, then win/lose.
async function narrateRoll(room, before, beforeInjects) {
  const g = room.game;
  const roll = g.state.lastRoll;
  const newStage = SLOTS.find((s) => !before[s] && g.state.revealed[s]);
  const extra = { procedure: roll.procedureName, total: roll.total, threshold: roll.threshold };
  if (newStage) await narrateInto(room, "success", { ...extra, stage: newStage, card: g.byId.get(g.state.objective[newStage])?.name });
  else if (roll.success) await narrateInto(room, "nodetect", extra);
  else await narrateInto(room, "failure", extra);
  if (g.state.playedInjects.length > beforeInjects) {
    const last = g.state.playedInjects[g.state.playedInjects.length - 1];
    await narrateInto(room, "inject", { inject: g.byId.get(last)?.name });
  }
  if (g.state.phase === "won") await narrateInto(room, "win");
  else if (g.state.phase === "lost") await narrateInto(room, "lose");
}

// After a manual GM reveal in a narrated team game.
async function narrateReveal(room, stage) {
  const g = room.game;
  const card = g.byId.get(g.state.objective[stage])?.name;
  await narrateInto(room, "success", { procedure: g.state.lastRoll?.procedureName || "the team's analysis", stage, card });
  if (g.state.phase === "won") await narrateInto(room, "win");
}

function startSoloIncident(room, connId) {
  const sysId = `sys-${connId}`;
  const g = room.game;
  g.reset(sysId);
  g.setup({}, sysId); // random attack chain + established procedures
  g.setMode("solo");
  g.start({ force: true }, sysId);
  // a fresh randomized incident brief (IOCs, actor, tooling) grounded in this game's chain
  room.scenario = buildScenario(chainCtx(g).map((c) => c.name), room.theme);
  room.broadcast();
  narrateInto(room, "intro"); // async; streams in shortly after
}

// --- static file server -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function sendFile(res, filePath) {
  readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

// Resolve a request path to a file under one of the allowed roots, blocking traversal.
function resolveSafe(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, clean);
  if (!full.startsWith(root)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") return sendFile(res, join(PUBLIC, "home.html"));
  if (url === "/gm" || url === "/play") return sendFile(res, join(PUBLIC, "index.html"));
  if (url === "/solo") return sendFile(res, join(PUBLIC, "solo.html"));
  if (url === "/help" || url === "/wiki") return sendFile(res, join(PUBLIC, "help.html"));
  if (url === "/api/models") {
    const respond = (opts) =>
      listModels(opts).then((models) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models, default: narratorInfo.model }));
      });
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { let o = {}; try { o = JSON.parse(body || "{}"); } catch {} respond(o); });
    } else {
      respond({});
    }
    return;
  }
  if (url.startsWith("/assets/")) {
    const f = resolveSafe(ASSETS, url.slice("/assets/".length));
    if (f) return sendFile(res, f);
  }
  const pub = resolveSafe(PUBLIC, url.slice(1));
  if (pub && existsSync(pub)) return sendFile(res, pub);
  res.writeHead(404);
  res.end("Not found");
});

// --- websocket ---------------------------------------------------------------

const wss = new WebSocketServer({ server, path: "/ws" });
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws) => {
  const connId = `c${nextId++}`;
  teamRoom.sockets.set(connId, ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Solo: move this socket into its own private game, then auto-start an incident.
    if (msg.type === "joinSolo") {
      teamRoom.sockets.delete(connId);
      teamRoom.game.leave(connId);
      const sr = new Room(DEFAULT_DECK);
      sr.solo = true;
      sr.theme = String(msg.theme || "").slice(0, 120);
      sr.narratorCfg = sanitizeNarrator(msg.narrator, msg.model);
      sr.sockets.set(connId, ws);
      soloRooms.set(connId, sr);
      sr.game.join(`sys-${connId}`, { name: "Incident Master", role: "gm" });
      sr.game.join(connId, { name: msg.name, role: "player" });
      startSoloIncident(sr, connId);
      return;
    }
    if (msg.type === "newIncident") {
      const sr = soloRooms.get(connId);
      if (sr) startSoloIncident(sr, connId);
      return;
    }

    const room = roomFor(connId);
    const g = room.game;
    let r = { ok: true };

    switch (msg.type) {
      case "join": {
        if (msg.role === "gm" && String(msg.pin) !== GM_PIN) {
          send(ws, { type: "error", error: "Wrong Game Master PIN" });
          return;
        }
        r = g.join(connId, { name: msg.name, role: msg.role });
        break;
      }
      case "setup": {
        if (msg.deck) room.changeDeck(msg.deck);
        r = room.game.setup(
          { objective: msg.objective, established: msg.established, detection: msg.detection },
          connId
        );
        break;
      }
      case "config":
        r = g.setConfig(msg.config || {}, connId);
        break;
      case "setNarration": {
        if (g.roleOf(connId) !== "gm") { send(ws, { type: "error", error: "Only the Game Master can control narration" }); return; }
        room.narrationOn = !!msg.on;
        if (msg.narrator) room.narratorCfg = sanitizeNarrator(msg.narrator);
        if (room.narrationOn && !room.scenario && g.state.objective.initial)
          room.scenario = buildScenario(chainCtx(g).map((c) => c.name), room.theme);
        g.log(room.narrationOn ? "Game Master enabled AI narration" : "Game Master disabled AI narration");
        room.broadcast();
        if (room.narrationOn && g.state.phase === "playing" && g.state.narrative.length === 0) narrateInto(room, "intro");
        return;
      }
      case "start": {
        r = g.start({ force: !!msg.force }, connId);
        if (r.ok && room.narrationOn && !room.solo) {
          room.scenario = buildScenario(chainCtx(g).map((c) => c.name), room.theme);
          room.broadcast();
          narrateInto(room, "intro");
          return;
        }
        break;
      }
      case "roll": {
        const track = room.solo || room.narrationOn;
        const before = track ? { ...g.state.revealed } : null;
        const beforeInjects = track ? g.state.playedInjects.length : 0;
        r = g.roll({ connId, procedureId: msg.procedureId, modifier: msg.modifier });
        if (track && r.ok) {
          room.broadcast(); // show the roll/animation immediately
          narrateRoll(room, before, beforeInjects); // narration streams in after
          return;
        }
        break;
      }
      case "reveal": {
        const before = room.narrationOn && !room.solo ? { ...g.state.revealed } : null;
        r = g.reveal({ slot: msg.slot }, connId);
        if (r.ok && before) {
          const stage = SLOTS.find((s) => !before[s] && g.state.revealed[s]);
          room.broadcast();
          if (stage) narrateReveal(room, stage);
          return;
        }
        break;
      }
      case "dismissReveal":
        r = g.dismissReveal(connId);
        break;
      case "playInject": {
        r = g.playInject({ cardId: msg.cardId, modifier: msg.modifier }, connId);
        if (r.ok && room.narrationOn && !room.solo) {
          const last = g.state.playedInjects[g.state.playedInjects.length - 1];
          room.broadcast();
          narrateInto(room, "inject", { inject: g.byId.get(last)?.name });
          return;
        }
        break;
      }
      case "setModifier":
        r = g.setModifier({ value: msg.value }, connId);
        break;
      case "playConsultant":
        r = g.playConsultant({ cardId: msg.cardId }, connId);
        break;
      case "note":
        r = g.note({ text: msg.text }, connId);
        break;
      case "chat":
        r = g.postChat({ connId, text: msg.text, channel: msg.channel });
        break;
      case "reset":
        r = g.reset(connId);
        break;
      default:
        return;
    }

    if (!r.ok) send(ws, { type: "error", error: r.error, needForce: r.needForce });
    if (msg.type === "chat") {
      if (r.ok) room.broadcastChat();
    } else {
      room.broadcast();
    }
  });

  ws.on("close", () => {
    const room = roomFor(connId);
    room.sockets.delete(connId);
    room.game.leave(connId);
    if (room.solo) soloRooms.delete(connId);
    else room.broadcast();
  });

  // initial state so the picker can show live seat counts before joining
  send(ws, { type: "hello", connId });
  const proj = teamRoom.game.project("viewer");
  proj.you = { role: null, deck: teamRoom.deck, decks: teamRoom.decks };
  send(ws, { type: "state", state: proj });
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  const ips = lanAddresses();
  console.log("\n=== Backdoors & Breaches — local server ===");
  console.log(`Home / launcher:    http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  on your network:   http://${ip}:${PORT}/   (share this on Wi-Fi)`);
  console.log(`Players / Viewers:  http://localhost:${PORT}/play`);
  console.log(`Game Master:        http://localhost:${PORT}/gm`);
  console.log(`Solo (vs AI IM):    http://localhost:${PORT}/solo`);
  console.log(`How-to-Play guide:  http://localhost:${PORT}/help`);
  console.log(`Game Master PIN:    ${GM_PIN}   ${process.env.BNB_PIN ? "(from BNB_PIN)" : "(random — set BNB_PIN to fix it)"}`);
  console.log(`Decks available:    ${teamRoom.decks.join(", ")}`);
  console.log(`Narrator (Ollama):  ${narratorInfo.model} @ ${narratorInfo.url}  (falls back to templates if offline)`);
  console.log("===========================================\n");
});
