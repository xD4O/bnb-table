// Pure game logic for Backdoors & Breaches — no I/O, no networking.
// The server owns one Game instance and broadcasts role-filtered projections.
//
// The "hidden objective" guarantee lives here: project(role) never includes an
// un-revealed objective card's identity for any role other than "gm".

const SLOTS = ["initial", "pivot", "c2", "persist"];
const SLOT_TYPE = { initial: "initial", pivot: "pivot", c2: "c2", persist: "persist" };

const DEFAULT_CONFIG = {
  turnLimit: 10,
  establishedThreshold: 11,
  unestablishedThreshold: 17,
  injectNudgeAfterFails: 3,
  cooldownTurns: 3, // house rule: a procedure is locked for this many turns after use (0 = off)
};

// Config keys that may legitimately be 0 (everything else must be >= 1).
const ZERO_OK = new Set(["cooldownTurns"]);

const DEFAULT_CAPACITY = { gm: 2, playerMin: 1, playerMax: 5 };

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function realD20() {
  return 1 + Math.floor(Math.random() * 20);
}

export class Game {
  constructor(catalog, opts = {}) {
    this.catalog = catalog; // { deckTitle, cards:[{id,name,image,type}], backs:{...} }
    this.d20 = opts.d20 || realD20;
    this.byId = new Map(catalog.cards.map((c) => [c.id, c]));
    this.players = new Map(); // connId -> { id, name, role }
    this.state = this.freshState();
  }

  freshState() {
    return {
      deck: this.catalog.deckTitle,
      phase: "setup",
      config: { ...DEFAULT_CONFIG },
      capacity: { ...DEFAULT_CAPACITY },
      objective: { initial: null, pivot: null, c2: null, persist: null },
      revealed: { initial: false, pivot: false, c2: false, persist: false },
      detection: {}, // slot -> [procedureId...] that detect it (GM-only; read off card art)
      pendingReveal: null, // { procedureName, options:[slot...] } when GM must choose
      established: [],
      lastUsed: {}, // procedureId -> turn number it was last rolled (for cooldown)
      turn: 0,
      successes: 0,
      failures: 0,
      consecutiveFails: 0,
      lastRoll: null,
      playedInjects: [],
      playedConsultants: [],
      log: [],
      chat: [], // { id, from, role, channel: "players"|"viewers", text }
    };
  }

  // --- membership / capacity ------------------------------------------------

  counts() {
    const c = { gm: 0, player: 0, viewer: 0 };
    for (const p of this.players.values()) c[p.role]++;
    return c;
  }

  roleOf(connId) {
    return this.players.get(connId)?.role;
  }

  join(connId, { name, role }) {
    if (!["gm", "player", "viewer"].includes(role)) return fail("Unknown role");
    const counts = this.counts();
    if (role === "gm" && counts.gm >= this.state.capacity.gm)
      return fail("Both Game Master seats are taken");
    if (role === "player" && counts.player >= this.state.capacity.playerMax)
      return fail(`Defender team is full (${this.state.capacity.playerMax}/${this.state.capacity.playerMax})`);
    const player = { id: connId, name: (name || role).slice(0, 40), role };
    this.players.set(connId, player);
    this.log(`${player.name} joined as ${role}`);
    return ok({ player });
  }

  leave(connId) {
    const p = this.players.get(connId);
    if (p) {
      this.players.delete(connId);
      this.log(`${p.name} left`);
    }
  }

  // --- GM setup / config ----------------------------------------------------

  requireGm(by) {
    return this.roleOf(by) === "gm";
  }

  cardsOfType(type) {
    return this.catalog.cards.filter((c) => c.type === type);
  }

  pickRandom(arr, n) {
    const pool = [...arr];
    const out = [];
    while (out.length < n && pool.length) {
      const i = Math.floor(this.d20Random() * pool.length);
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }

  // randomness for setup that is independent of the d20 die roller
  d20Random() {
    return (this.d20() - 1) / 20;
  }

  setup({ objective, established, detection } = {}, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can set up the game");
    if (this.state.phase !== "setup") return fail("Reset before setting up a new game");

    // Objective: explicit ids or random one-per-slot.
    const obj = {};
    for (const slot of SLOTS) {
      let id = objective?.[slot];
      if (id) {
        const card = this.byId.get(id);
        if (!card || card.type !== SLOT_TYPE[slot])
          return fail(`Invalid ${slot} card: ${id}`);
      } else {
        id = this.pickRandom(this.cardsOfType(SLOT_TYPE[slot]), 1)[0]?.id;
        if (!id) return fail(`No ${slot} cards in deck`);
      }
      obj[slot] = id;
    }

    // Established procedures: explicit 4 or random 4.
    let est;
    if (established) {
      if (established.length !== 4) return fail("Pick exactly 4 established procedures");
      for (const id of established) {
        const card = this.byId.get(id);
        if (!card || card.type !== "procedure") return fail(`Invalid procedure: ${id}`);
      }
      est = [...established];
    } else {
      est = this.pickRandom(this.cardsOfType("procedure"), 4).map((c) => c.id);
    }

    // Optional detection map: per slot, which procedures detect that attack card.
    const det = {};
    for (const slot of SLOTS) {
      const ids = (detection?.[slot] || []).filter((id) => this.byId.get(id)?.type === "procedure");
      det[slot] = ids;
    }

    this.state.objective = obj;
    this.state.established = est;
    this.state.detection = det;
    this.state.pendingReveal = null;
    this.state.revealed = { initial: false, pivot: false, c2: false, persist: false };
    this.log("Game Master set the scenario");
    return ok();
  }

  setConfig(partial, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can change config");
    const next = { ...this.state.config };
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (partial[k] != null) {
        const v = Math.trunc(Number(partial[k]));
        const min = ZERO_OK.has(k) ? 0 : 1;
        if (!Number.isFinite(v) || v < min) return fail(`Invalid ${k}`);
        next[k] = v;
      }
    }
    this.state.config = next;
    this.log("Game Master updated the rules config");
    return ok();
  }

  start({ force } = {}, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can start the game");
    if (this.state.phase !== "setup") return fail("Game already started");
    if (!this.state.objective.initial) {
      const r = this.setup({}, by); // auto random setup if GM never configured one
      if (!r.ok) return r;
    }
    const players = this.counts().player;
    if (players < this.state.capacity.playerMin && !force)
      return fail(`Need ${this.state.capacity.playerMin}+ players (currently ${players})`, {
        needForce: true,
      });
    if (players < this.state.capacity.playerMin) this.log(`GM started below minimum (${players} players)`);
    this.state.phase = "playing";
    this.state.turn = 0;
    this.state.successes = 0;
    this.state.failures = 0;
    this.state.consecutiveFails = 0;
    this.state.lastRoll = null;
    this.log("Incident started — defenders, begin your investigation");
    return ok();
  }

  // --- play -----------------------------------------------------------------

  roll({ connId, procedureId, modifier = 0 }) {
    const role = this.roleOf(connId);
    if (role !== "player" && role !== "gm") return fail("Only defenders can roll");
    if (this.state.phase !== "playing") return fail("Game is not in progress");
    const card = this.byId.get(procedureId);
    if (!card || card.type !== "procedure") return fail("Pick a valid procedure");

    const cd = this.state.config.cooldownTurns;
    if (cd > 0) {
      const last = this.state.lastUsed[procedureId];
      const prospective = this.state.turn + 1; // the turn this roll would be
      if (last != null && prospective - last <= cd)
        return fail(`"${card.name}" is on cooldown (${last + cd - this.state.turn} turn(s) left)`);
    }

    const established = this.state.established.includes(procedureId);
    const threshold = established
      ? this.state.config.establishedThreshold
      : this.state.config.unestablishedThreshold;
    const mod = Math.trunc(Number(modifier) || 0);
    const die = this.d20();
    const total = die + mod;
    const success = total >= threshold;

    this.state.turn++;
    this.state.lastUsed[procedureId] = this.state.turn;
    if (success) {
      this.state.consecutiveFails = 0;
    } else {
      this.state.failures++;
      this.state.consecutiveFails++;
    }
    const who = this.players.get(connId)?.name || "Someone";
    this.state.lastRoll = {
      playerName: who,
      procedureId,
      procedureName: card.name,
      established,
      d20: die,
      modifier: mod,
      total,
      threshold,
      success,
      ts: this.state.turn,
    };
    this.log(
      `${who} ran "${card.name}" — rolled ${die}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ""}=${total} vs ${threshold} → ${success ? "SUCCESS" : "no detection"}`
    );

    // On a success, figure out which attack card(s) this procedure reveals.
    if (success && this.state.phase === "playing") {
      const opts = this.revealOptions(procedureId);
      if (opts.length === 1) {
        this._doReveal(opts[0], true);
      } else if (opts.length > 1) {
        this.state.pendingReveal = { procedureName: card.name, options: opts };
        this.log(`${card.name} detected something — Game Master, choose which card to reveal`);
      } else {
        this.state.pendingReveal = null;
        this.log(`${card.name} succeeded but detected nothing new`);
      }
    }

    // House rule: a natural 1 or 20 triggers an Inject.
    if ((die === 1 || die === 20) && this.state.phase === "playing") this._autoInject(die);

    if (this.state.turn >= this.state.config.turnLimit && this.state.phase === "playing" && this.state.successes < 4) {
      this.state.phase = "lost";
      this.log("Out of time — the attackers win.");
    }
    return ok({ roll: this.state.lastRoll });
  }

  // Which unrevealed slots this procedure can reveal. With a detection map, only
  // the matching cards; without one, all unrevealed slots (GM-judged).
  revealOptions(procedureId) {
    const unrevealed = SLOTS.filter((s) => !this.state.revealed[s]);
    const det = this.state.detection || {};
    const hasMap = Object.values(det).some((arr) => arr && arr.length);
    if (hasMap) return unrevealed.filter((s) => (det[s] || []).includes(procedureId));
    return unrevealed;
  }

  _autoInject(die) {
    const injects = this.cardsOfType("inject");
    if (!injects.length) return;
    const unplayed = injects.filter((c) => !this.state.playedInjects.includes(c.id));
    const pool = unplayed.length ? unplayed : injects;
    const pick = pool[Math.floor(this.d20Random() * pool.length)] || pool[0];
    this.state.playedInjects.push(pick.id);
    this.log(`🎲 Natural ${die}! Inject auto-played: "${pick.name}"`);
  }

  _doReveal(slot, auto = false) {
    if (this.state.revealed[slot]) return;
    this.state.revealed[slot] = true;
    this.state.successes = SLOTS.filter((s) => this.state.revealed[s]).length;
    this.state.pendingReveal = null;
    const card = this.byId.get(this.state.objective[slot]);
    this.log(`${auto ? "Auto-detected" : "Detected"} the ${slot} card: "${card?.name}" (${this.state.successes}/4)`);
    if (this.state.successes === 4) {
      this.state.phase = "won";
      this.log("All four attack cards detected — defenders win!");
    }
  }

  reveal({ slot }, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can reveal cards");
    if (this.state.phase !== "playing") return fail("Game is not in progress");
    if (!SLOTS.includes(slot)) return fail("Unknown slot");
    if (this.state.revealed[slot]) return fail("Already revealed");
    this._doReveal(slot, false);
    return ok();
  }

  dismissReveal(by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can do that");
    this.state.pendingReveal = null;
    this.log("Game Master: no card detected this turn");
    return ok();
  }

  playInject({ cardId }, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can play injects");
    const card = this.byId.get(cardId);
    if (!card || card.type !== "inject") return fail("Not an inject card");
    this.state.playedInjects.push(cardId);
    this.log(`Inject played: "${card.name}"`);
    return ok();
  }

  playConsultant({ cardId }, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can play consultants");
    const card = this.byId.get(cardId);
    if (!card || card.type !== "consultant") return fail("Not a consultant card");
    this.state.playedConsultants.push(cardId);
    this.log(`Consultant brought in: "${card.name}"`);
    return ok();
  }

  note({ text }, by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can post notes");
    this.log(`📝 ${String(text || "").slice(0, 200)}`);
    return ok();
  }

  reset(by) {
    if (!this.requireGm(by)) return fail("Only the Game Master can reset");
    const config = { ...this.state.config }; // keep tuned rules across reset
    this.state = this.freshState();
    this.state.config = config;
    this.log("Game reset");
    return ok();
  }

  // Chat channels: players <-> GM, and viewers <-> GM. Viewers never see player
  // chat and vice-versa; the GM sees and can post to both.
  postChat({ connId, text, channel }) {
    const p = this.players.get(connId);
    if (!p) return fail("Join before chatting");
    const t = String(text || "").trim().slice(0, 500);
    if (!t) return fail("Empty message");
    let ch;
    if (p.role === "viewer") ch = "viewers";
    else if (p.role === "player") ch = "players";
    else ch = channel === "viewers" ? "viewers" : "players"; // GM chooses
    const msg = { id: this.state.chat.length + 1, from: p.name, role: p.role, channel: ch, text: t };
    this.state.chat.push(msg);
    if (this.state.chat.length > 200) this.state.chat.shift();
    return ok({ message: msg });
  }

  chatFor(role) {
    if (role === "gm") return this.state.chat;
    const ch = role === "viewer" ? "viewers" : "players";
    return this.state.chat.filter((m) => m.channel === ch);
  }

  log(text) {
    this.state.log.push({ ts: this.state.log.length + 1, text });
    if (this.state.log.length > 200) this.state.log.shift();
  }

  // --- projection (role-filtered snapshot) ----------------------------------

  // procedureId -> remaining cooldown turns (only entries with > 0)
  cooldownMap() {
    const cd = this.state.config.cooldownTurns;
    const out = {};
    if (cd > 0) {
      for (const [pid, last] of Object.entries(this.state.lastUsed)) {
        const left = Math.max(0, last + cd - this.state.turn);
        if (left > 0) out[pid] = left;
      }
    }
    return out;
  }

  cardView(id) {
    const c = this.byId.get(id);
    return c ? { id: c.id, name: c.name, image: c.image, type: c.type } : null;
  }

  project(role) {
    const s = this.state;
    const isGm = role === "gm";

    const objective = {};
    for (const slot of SLOTS) {
      if (s.revealed[slot] || isGm) {
        objective[slot] = { ...this.cardView(s.objective[slot]), revealed: s.revealed[slot] };
      } else {
        objective[slot] = { locked: true, type: SLOT_TYPE[slot], back: this.catalog.backs[slot] };
      }
    }

    const base = {
      deck: s.deck,
      phase: s.phase,
      config: s.config,
      capacity: s.capacity,
      counts: this.counts(),
      objective,
      revealed: s.revealed,
      established: s.established.map((id) => this.cardView(id)).filter(Boolean),
      procedures: this.cardsOfType("procedure"),
      cooldowns: this.cooldownMap(),
      turn: s.turn,
      successes: s.successes,
      failures: s.failures,
      consecutiveFails: s.consecutiveFails,
      injectNudge: s.consecutiveFails >= s.config.injectNudgeAfterFails && s.phase === "playing",
      awaitingReveal: !!s.pendingReveal,
      lastRoll: s.lastRoll,
      playedInjects: s.playedInjects.map((id) => this.cardView(id)).filter(Boolean),
      playedConsultants: s.playedConsultants.map((id) => this.cardView(id)).filter(Boolean),
      players: [...this.players.values()].map((p) => ({ name: p.name, role: p.role })),
      log: s.log,
      chat: this.chatFor(role),
      backs: this.catalog.backs,
    };

    if (!isGm) return base;

    // GM-only: full scenario builder catalog + the solution.
    return {
      ...base,
      gm: {
        solution: objective, // resolved cards (GM always sees them)
        detection: s.detection,
        pendingReveal: s.pendingReveal,
        builder: {
          initial: this.cardsOfType("initial"),
          pivot: this.cardsOfType("pivot"),
          c2: this.cardsOfType("c2"),
          persist: this.cardsOfType("persist"),
          procedure: this.cardsOfType("procedure"),
          inject: this.cardsOfType("inject"),
          consultant: this.cardsOfType("consultant"),
        },
      },
    };
  }
}

export { SLOTS, DEFAULT_CONFIG, DEFAULT_CAPACITY };
