# Backdoors & Breaches — Local Multiplayer (with hidden Game Master objectives)

**Date:** 2026-06-22
**Status:** Approved design, pre-implementation

## Goal

A locally-hosted, LAN-multiplayer digital table for *Backdoors & Breaches* (Black Hills
InfoSec, Creative Commons). Players and viewers watch the board update live (cards reveal
"as it goes"). A Game Master (the Incident Master) secretly holds the **attack chain** —
four objective cards that players/viewers **cannot see until the GM unlocks (reveals)** each
one through play.

## Non-goals

- Internet/online matchmaking. This is single-room, single-LAN, in-memory.
- Automated detection adjudication. The detection mapping (which procedures detect which
  attack card) is printed on card art, not in machine-readable data, so the human GM
  adjudicates — exactly like the tabletop Incident Master. This is intentional, not a gap.
- Persistence across server restarts (state is in-memory; a reset is a fresh game).

## Card data source

Pulled from the official engine
`https://play.backdoorsandbreaches.com/play.backdoorsandbreaches.com-Engine-V1/App/`.

- Each deck is `decks/<Deck>/carddb.json` → `{ title, revdate, link, data[], red, yellow,
  brown, purple, grey, green, logo }`.
- `data[]` entries: `{ name, image, type, id, details }`.
- `type` ∈ `initial | pivot | c2 | persist | procedure | inject | consultant`.
- Card effect text and the per-card "detection methods" list are **baked into the PNG art**
  (`image`), 1449×2000 px. Back/placeholder images: `red`=Initial, `yellow`=Pivot,
  `brown`=C2, `purple`=Persistence, `grey`=Inject, `green`=Consultant.

**Bundled decks:** Core v3.1 (52 cards) + Core v2.2 Expansion (92 cards incl. 14 Consultants,
15 procedures). Downloaded once into `assets/decks/<Deck>/` at build time; served locally so
the app works offline thereafter. GM may switch deck at setup.

## Roles

| Role | Route | Sees hidden objectives? | Can act? |
|------|-------|------------------------|----------|
| Game Master | `/gm` (PIN-gated) | **Yes** | Full control: setup, reveal, injects, consultants, notes, reset |
| Player (Defender) | `/` | No (locked backs until revealed) | Pick procedure + roll d20 |
| Viewer | `/` (choose Viewer) | No | Read-only spectator |

PIN is a server-side env/config value (default printed at startup). Wrong PIN ⇒ no GM socket.

## Architecture

- **Server:** Node, `http` for static + a single `ws` WebSocket endpoint. One npm dependency
  (`ws`). Holds the authoritative `GameState` in memory.
- **Server-side redaction (the core security property):** the server computes a per-role
  projection of the state. Hidden objective card identities are **never sent** to
  player/viewer sockets — they receive only `{ slot, locked:true, backImage }`. On reveal,
  the GM action mutates state and the server broadcasts the now-public card to everyone. There
  is no client-side "hide" that could be defeated with dev tools.
- **Frontend:** no-build vanilla JS + CSS, one shared `app.js` that renders differently by
  role using the projected state it receives. Card art shown as `<img>` from local assets.
- **Startup:** server prints the LAN URL (`http://<lan-ip>:3000`) and an ASCII QR code so
  phones can join fast.

## Game state (authoritative, server)

```
GameState {
  deck: string                        // e.g. "CoreV3.1"
  phase: "setup" | "playing" | "won" | "lost"
  config: { turnLimit: 10, establishedThreshold: 11, unestablishedThreshold: 17,
            injectNudgeAfterFails: 3 }
  objective: { initial, pivot, c2, persist }   // card ids — GM-only, redacted for others
  revealed:  { initial:bool, pivot:bool, c2:bool, persist:bool }
  established: [procCardId x4]         // visible to all
  turn, successes, failures, consecutiveFails: number
  lastRoll: { playerName, procedureId, d20, modifier, total, threshold, success, ts } | null
  playedInjects: [cardId...]          // visible to all once played
  playedConsultants: [cardId...]      // visible to all once played
  players: [{ id, name, role }]
  log: [{ ts, text }]                 // shared event feed
}
```

Player/Viewer projection replaces `objective` with locked placeholders for any slot where
`revealed[slot]===false`, and omits the inject/consultant *draw piles* (only *played* ones
are shown).

## Game flow (faithful core rules; GM-arbitrated)

1. **Setup (GM):** choose deck; pick attack chain — one each of initial/pivot/c2/persist
   (Random or hand-pick from a builder). Deal 4 random Procedures as **Established**
   (success ≥ 11). All other procedures usable but **not Established** (success ≥ 17).
   Optional Starting Condition inject. GM presses **Start**.
2. **Turn (Defender):** pick a Procedure, roll d20 (server rolls authoritatively). GM may set
   a `±modifier` to apply special card rules. Server computes `total = d20 + modifier`,
   `success = total ≥ threshold(procedure)`, broadcasts the roll, increments `turn`.
3. **Adjudicate (GM):** on a success, GM reads the hidden objective art and, if the chosen
   procedure detects an un-revealed attack card, presses **Reveal** on that slot → unlocked
   for all, `successes++`. On failure, `failures++`, `consecutiveFails++` (reset on success).
4. **Injects / Consultants (GM):** GM may play an Inject (UI nudges after
   `injectNudgeAfterFails` consecutive failures) or hand a Consultant to defenders; played
   cards become visible to all.
5. **End:** **Win** when all 4 revealed. **Lose** when `turn ≥ turnLimit` without all 4. GM
   can **Reset** to a fresh game.

## WebSocket protocol

Client→server messages: `join {name, role, pin?}`, `setup {deck, objective?, established?}`,
`start`, `roll {procedureId, modifier?}` (defenders+GM), `reveal {slot}` (GM),
`playInject {cardId}` (GM), `playConsultant {cardId}` (GM), `note {text}` (GM),
`reset` (GM), `config {...}` (GM).
Server→client: `state {projection}` (full re-broadcast on every change — state is small),
`error {text}`.
Server validates role on every action (defenders cannot reveal; viewers cannot roll, etc.).

## File layout

```
backdoors-and-breaches/
  package.json            # "start": node server.js ; dep: ws
  server.js               # http static + ws, GameState, redaction, validation
  scripts/fetch-cards.js  # downloads carddb.json + PNGs for bundled decks → assets/
  assets/
    decks/CoreV3.1/...     # carddb.json + card PNGs + back images
    decks/CoreV2.2-Expansion/...
  public/
    index.html  app.js  styles.css   # role-aware SPA (player/viewer/gm)
  docs/superpowers/specs/2026-06-22-bnb-local-multiplayer-design.md
```

## Testing

- **Unit (node:test):** redaction (player projection never contains hidden objective ids),
  roll resolution (thresholds, modifier, success/fail, consecutiveFails reset), win/lose
  transitions, role-permission guards (defender reveal rejected, viewer roll rejected).
- **Manual:** start server, open `/gm` (PIN) + two `/` tabs (player+viewer); run a full game;
  confirm players see locked backs that flip only on GM reveal, dice broadcast live, win/lose
  fire correctly.

## Risks / decisions

- **Art is the source of truth for effects/detection** → GM-arbitrated adjudication (accepted,
  faithful).
- **One-time bulk download (~70MB)** of card art at build via `fetch-cards.js`; cached locally.
- **Single room** (one game at a time) — sufficient for a local table; multi-room is YAGNI.
