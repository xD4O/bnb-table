# Backdoors & Breaches — Local Multiplayer

A locally-hosted, LAN-multiplayer table for [Backdoors & Breaches](https://www.blackhillsinfosec.com/projects/backdoorsandbreaches)
(the incident-response card game by Black Hills InfoSec, released under Creative Commons).

- **Players & Viewers** watch the board update live — cards reveal *as it goes*.
- The **Game Master** (Incident Master) secretly holds the 4-card **attack chain**. Players and
  viewers see locked card backs until the GM **reveals** each one through play.
- Up to **2 Game Masters**, a **3–5 player** defender team, and **unlimited viewers**.

The hidden-objective guarantee is enforced **server-side**: un-revealed objective cards are
never sent to player/viewer connections, so there's nothing to peek at in the browser.

## Setup

```bash
npm install
npm run fetch-cards   # one-time: downloads official Core v3.1 + Expansion card art (~56MB)
npm start
```

On startup the server prints the URLs and a Game Master PIN, e.g.:

```
Players / Viewers:  http://localhost:3000/
  on your network:   http://192.168.1.42:3000/    <- share this on your Wi-Fi
Game Master:        http://localhost:3000/gm
Game Master PIN:    7421   (random — set BNB_PIN to fix it)
```

Everyone on the same Wi-Fi opens the network URL. Game Masters open `/gm` and enter the PIN.

Set a fixed PIN / port / deck with env vars:

```bash
BNB_PIN=1234 PORT=8080 BNB_DECK=CoreV2.2-Expansion npm start
```

## How to play (digital)

1. **GM** opens `/gm`, picks a deck, then either **Randomizes** the scenario or hand-builds the
   attack chain (one Initial Compromise / Pivot & Escalate / C2 & Exfil / Persistence card) and
   chooses 4 **Established** procedures. Optionally tune the rules (turn limit, success
   thresholds, inject nudge). Press **Start**.
2. **Defenders** pick a Procedure and **roll d20** each turn. Established procedures succeed on
   11+, others on 17+ (defaults — GM-editable). A `±modifier` field applies any special card
   rules.
3. On a successful roll the **GM** reads their hidden cards and, if that procedure detects an
   attack card, **reveals** it — it unlocks for everyone.
4. The GM plays **Injects** (the UI nudges after 3 consecutive failures) and **Consultants**.
5. **Win:** all 4 attack cards detected. **Lose:** the turn limit is hit first.

## Roles & capacity

| Role | URL | Sees hidden chain? | Can act? | Capacity |
|------|-----|--------------------|----------|----------|
| Game Master | `/gm` (PIN) | Yes | Full control | max 2 |
| Defender | `/` | No (until revealed) | Roll d20, pick procedures | 3–5 (one team) |
| Viewer | `/` | No | Watch only | unlimited |

Below 3 players the GM can still **Force start** (for testing/demos).

## Project layout

```
server.js            HTTP static server + WebSocket; role-filtered broadcast
src/game.js          Pure game logic (state machine, redaction, rules) — fully unit-tested
test/game.test.js    node:test suite
scripts/fetch-cards.js   Downloads official card data + art into assets/
public/              index.html · app.js · styles.css  (no build step)
assets/decks/<Deck>/ carddb.json + card PNGs (git-ignored; regenerate with fetch-cards)
```

Run the tests with `npm test`.

## Credits

Backdoors & Breaches is created by **Black Hills Information Security** and is free under
Creative Commons. Card data and art are fetched from the official
[B&B web engine](https://play.backdoorsandbreaches.com/). This project is an unofficial local
table built around those cards.
