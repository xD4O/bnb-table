# Backdoors & Breaches — Local Multiplayer + Solo RPG

A locally-hosted table for [Backdoors & Breaches](https://www.blackhillsinfosec.com/projects/backdoorsandbreaches)
(the incident-response card game by Black Hills InfoSec, released under Creative Commons),
with two ways to play:

- **Team (LAN multiplayer):** a Game Master secretly holds the 4-card **attack chain**;
  Defenders roll d20s to detect it; Viewers spectate. Cards reveal live as the team finds them.
- **Solo (vs. an AI Incident Master):** one analyst plays against the computer. A local LLM
  (Ollama) narrates the incident like an RPG — the opening scene, why a procedure failed
  ("the EDR license lapsed and those logs were never forwarded"), and what each success
  uncovered with a hint toward the next step.

The hidden-objective guarantee is enforced **server-side**: un-revealed attack cards (and the
detection map, and other players' chat) are never sent to clients that shouldn't see them.

## Setup

```bash
npm install
npm run fetch-cards   # one-time: downloads official Core v3.1 + Expansion art (~56MB)
npm start
```

On startup the server prints all URLs, the Game Master PIN, and the narrator model:

```
Players / Viewers:  http://localhost:3000/
  on your network:   http://192.168.1.42:3000/    <- share on Wi-Fi
Game Master:        http://localhost:3000/gm
Solo (vs AI IM):    http://localhost:3000/solo
Game Master PIN:    7421   (random — set BNB_PIN to fix it)
Narrator (Ollama):  qwen2.5:7b @ http://localhost:11434  (falls back to templates if offline)
```

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP/WS port |
| `BNB_PIN` | random 4-digit | fixed Game Master PIN |
| `BNB_DECK` | `CoreV3.1` | starting deck |
| `BNB_OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint for solo narration |
| `BNB_OLLAMA_MODEL` | `qwen2.5:7b` | model used to narrate solo mode |

```bash
BNB_PIN=1234 PORT=8080 BNB_OLLAMA_MODEL=llama3.1:8b npm start
```

## Roles & capacity (team mode)

| Role | URL | Sees hidden chain? | Can act? | Capacity |
|------|-----|--------------------|----------|----------|
| Game Master | `/gm` (PIN) | Yes | Full control | max 2 |
| Defender | `/` | No (until revealed) | Roll d20, pick procedures, chat | 1–5 (one team) |
| Viewer | `/` | No | Watch, chat (viewers-only) | unlimited |

Below the player minimum the GM can still **Force start** (for testing/demos).

## Playing — team mode

1. **GM** opens `/gm`, picks a deck, then **Randomizes** the scenario or hand-builds it:
   - the **attack chain** (one Initial Compromise / Pivot & Escalate / C2 & Exfil / Persistence card);
   - 4 **Established** procedures;
   - an optional **detection map** (which procedures detect each attack card — read off the
     card art) that enables auto-reveal;
   - **rules** (all GM-editable, with defaults): turn limit `10`, established success `≥11`,
     not-established success `≥17`, inject nudge after `3` fails, **cooldown `3` turns**.
2. **Defenders** pick a Procedure and **roll d20** (the result die animates). Established
   procedures succeed on 11+, others on 17+. A `±modifier` field is available too.
3. **Detection / reveal** on a success:
   - with a detection map: the matching card auto-reveals; if several match, the GM is
     prompted to choose; if none match, nothing is revealed;
   - without a map: if one card remains it auto-reveals, otherwise the GM picks.
4. **Cooldown:** after a procedure is rolled it's locked for *N* turns (default 3, GM-editable,
   0 = off); cooled cards show a ❄ badge and are disabled in the roll picker.
5. **Injects:** the GM plays Inject cards (the UI nudges after 3 consecutive fails). A **natural
   1 or 20 auto-plays an Inject**. An inject can carry a **standing roll modifier** (e.g. "−3 to
   all procedures") that the GM sets — it then applies to every roll until cleared.
6. **Consultants:** the GM hands one-time Consultant helps to the team.
7. **Chat:** Defenders chat on a **team** channel; Viewers chat on a **viewers** channel; the
   GM sees both and can address either. Viewers never see team chat and vice-versa.
8. **Win** when all 4 attack cards are detected. **Lose** when the turn limit is hit first.

Click any card (objective, procedure, inject, consultant) to enlarge it in a lightbox.

## Playing — solo mode

Open `/solo`, enter a name and an optional scenario flavor ("a regional hospital", "a fintech
startup"), and **Begin**. The server:

- generates a random attack chain + established procedures and starts immediately (you are the
  Defender; the system is the Incident Master);
- on **Begin**, the AI narrates the **opening scene**;
- each turn you pick a procedure and roll. A **success** detects the next stage of the chain in
  order, and the AI narrates **what you found** and hints at the next step; a **failure** gets a
  realistic in-world **reason** it turned up nothing; injects and win/lose are narrated too.

Solo progression is deterministic, so the game is fully playable **even if Ollama isn't
running** — narration just falls back to built-in templated flavor text. `↺ New incident`
starts a fresh scenario.

## Project layout

```
server.js              HTTP static + WebSocket; team room + per-player solo rooms; role-filtered
                       broadcasts; solo narration hooks
src/game.js            Pure game logic (state machine, redaction, rules, solo mode) — unit-tested
src/narrator.js        Ollama client + offline fallback templates for solo narration
test/game.test.js      node:test suite (35 tests)
scripts/fetch-cards.js Downloads official card data + art into assets/
public/                index.html · app.js (team)   solo.html · solo.js (solo)   styles.css
assets/decks/<Deck>/   carddb.json + card PNGs (git-ignored; regenerate with fetch-cards)
```

Run the tests with `npm test`. Coverage includes objective redaction, roll thresholds,
cooldown, detection-driven/solo reveals, natural-1/20 auto-inject, the active roll modifier,
chat-channel visibility, capacity caps, and win/lose transitions.

## Credits

Backdoors & Breaches is created by **Black Hills Information Security** and is free under
Creative Commons. Card data and art are fetched from the official
[B&B web engine](https://play.backdoorsandbreaches.com/). This is an unofficial local table
built around those cards; solo narration is generated by a local LLM via [Ollama](https://ollama.com/).
