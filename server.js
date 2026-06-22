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
import { Game } from "./src/game.js";

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
      ws.send(JSON.stringify({ type: "state", state: proj }));
    }
  }
}

const room = new Room(process.env.BNB_DECK || "CoreV3.1");

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
  if (url === "/" || url === "/gm") return sendFile(res, join(PUBLIC, "index.html"));
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
  room.sockets.set(connId, ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
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
      case "start":
        r = g.start({ force: !!msg.force }, connId);
        break;
      case "roll":
        r = g.roll({ connId, procedureId: msg.procedureId, modifier: msg.modifier });
        break;
      case "reveal":
        r = g.reveal({ slot: msg.slot }, connId);
        break;
      case "dismissReveal":
        r = g.dismissReveal(connId);
        break;
      case "playInject":
        r = g.playInject({ cardId: msg.cardId }, connId);
        break;
      case "playConsultant":
        r = g.playConsultant({ cardId: msg.cardId }, connId);
        break;
      case "note":
        r = g.note({ text: msg.text }, connId);
        break;
      case "reset":
        r = g.reset(connId);
        break;
      default:
        return;
    }

    if (!r.ok) send(ws, { type: "error", error: r.error, needForce: r.needForce });
    room.broadcast();
  });

  ws.on("close", () => {
    room.sockets.delete(connId);
    room.game.leave(connId);
    room.broadcast();
  });

  // initial state so the picker can show live seat counts before joining
  send(ws, { type: "hello", connId });
  const proj = room.game.project("viewer");
  proj.you = { role: null, deck: room.deck, decks: room.decks };
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
  console.log(`Players / Viewers:  http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  on your network:   http://${ip}:${PORT}/   (share this on Wi-Fi)`);
  console.log(`Game Master:        http://localhost:${PORT}/gm`);
  console.log(`Game Master PIN:    ${GM_PIN}   ${process.env.BNB_PIN ? "(from BNB_PIN)" : "(random — set BNB_PIN to fix it)"}`);
  console.log(`Decks available:    ${room.decks.join(", ")}`);
  console.log("===========================================\n");
});
