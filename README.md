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

Requires **Node 18+** (uses native `fetch`/WebSocket streaming). Solo narration additionally
uses a local [Ollama](https://ollama.com/) model, but degrades gracefully without it.

## Setup

```bash
git clone https://github.com/xD4O/bnb-table.git
cd bnb-table
npm install
npm run fetch-cards   # one-time: downloads official Core v3.1 + Expansion art (~56MB)
npm start
```

On startup the server prints all URLs, the Game Master PIN, and the narrator model:

```
Home / launcher:    http://localhost:3000/
  on your network:   http://192.168.1.42:3000/    <- share on Wi-Fi
Players / Viewers:  http://localhost:3000/play
Game Master:        http://localhost:3000/gm
Solo (vs AI IM):    http://localhost:3000/solo
How-to-Play guide:  http://localhost:3000/help
Game Master PIN:    7421   (random — set BNB_PIN to fix it)
Narrator (Ollama):  qwen2.5:7b @ http://localhost:11434  (falls back to templates if offline)
```

The **home page (`/`)** is a launcher: pick **Solo / Game Master / Defender / Viewer**, and
open the **AI Incident Master settings** — choose **local Ollama** (customizable endpoint,
lists your installed models) or an **OpenAI-compatible API** with one-click **provider presets**
(OpenAI, Groq, OpenRouter, Together, DeepSeek, Mistral, local Ollama, or a custom base URL) plus
an API key and a model picker. Settings are stored in your browser and used by Solo mode; it
falls back to built-in narration if the provider is unreachable.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP/WS port |
| `BNB_PIN` | random 4-digit | fixed Game Master PIN |
| `BNB_DECK` | `CoreV3.1` | starting deck |
| `BNB_OLLAMA_URL` | `http://localhost:11434` | default Ollama endpoint for solo narration |
| `BNB_OLLAMA_MODEL` | `qwen2.5:7b` | default narrator model |
| `BNB_API_URL` | `https://api.openai.com/v1` | default base URL for the OpenAI-compatible API provider |
| `BNB_API_KEY` | — | default API key for the API provider (usually set per-browser in Settings instead) |

The narrator provider/model/endpoint/key are normally chosen in the in-app **Settings** (home
page or the Solo screen) and persist per-browser; these env vars only supply defaults.

```bash
BNB_PIN=1234 PORT=8080 BNB_OLLAMA_MODEL=llama3.1:8b npm start
```

New to the game? Open **`/help`** for the in-app How-to-Play guide (roles, setup, rules, solo).

## Interface

The UI is a cohesive "SOC command console" theme: glassmorphic panels over an animated grid
backdrop, the Rajdhani / JetBrains-Mono type pairing, a HUD-style tracker bar, colour-coded
attack-chain "case file" cards that glow on reveal, a premium animated d20, click-to-enlarge
cards, and consistent hover/focus states. Responsive down to phones; web fonts degrade
gracefully to system fonts offline. Pages: `/` (launcher + settings), `/play` (player/viewer),
`/gm`, `/solo`, `/help`.

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
   - **rules** (all GM-editable, with defaults): turn limit `10`, success threshold `≥14`,
     **Established bonus `+3`** added to the roll, inject nudge after `3` fails, **cooldown `3` turns**.
2. **Defenders** pick a Procedure and **roll d20** (the result die animates). Established
   the d20 result animates. The total is `d20 + Established bonus (if established) + modifiers`
   and succeeds at the threshold — so with the classic defaults (`+3`, threshold `14`) an
   Established procedure effectively needs 11+ and others 14+, with the `+3` added visibly to the
   roll. A `±modifier` field is available too, and a negative inject modifier subtracts from the
   total (bonus included).
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

Every incident gets a **freshly randomized brief** — sector, threat actor, tooling, and a
consistent set of IOCs (attacker IP, C2 domain/port, file hash, compromised account, host,
CVE, MITRE ATT&CK techniques) — which the narrator weaves through the whole story. Combined
with a random model seed and the running story-so-far, no two games narrate alike. Pick the
narrator model on the start screen.

Solo progression is deterministic, so the game is fully playable **even if Ollama isn't
running** — narration falls back to IOC-filled templates (still randomized per game). `↺ New
incident` starts a fresh scenario.

## Project layout

```
server.js              HTTP static + WebSocket; team room + per-player solo rooms; role-filtered
                       broadcasts; solo narration hooks
src/game.js            Pure game logic (state machine, redaction, rules, solo mode) — unit-tested
src/narrator.js        Ollama client + offline fallback templates for solo narration
test/game.test.js      node:test suite (35 tests)
scripts/fetch-cards.js Downloads official card data + art into assets/
src/scenario.js        Randomized per-incident IOC brief for solo narration
public/                index.html · app.js (team)   solo.html · solo.js (solo)
                       home.html (launcher)   settings.js (shared narrator settings)
                       help.html (How-to-Play guide)   styles.css (design system)
assets/decks/<Deck>/   carddb.json + card PNGs (git-ignored; regenerate with fetch-cards)
```

Run the tests with `npm test`. Coverage includes objective redaction, roll thresholds,
cooldown, detection-driven/solo reveals, natural-1/20 auto-inject, the active roll modifier,
chat-channel visibility, capacity caps, and win/lose transitions.

## Credits & attribution

**Backdoors & Breaches** is created by **Black Hills Information Security** and is free under
Creative Commons. This is an **unofficial** fan-made local table built around those cards and is
not affiliated with or endorsed by Black Hills InfoSec.

- **Card data & art** are downloaded at build time from the official
  [B&B web engine](https://play.backdoorsandbreaches.com/) by `scripts/fetch-cards.js`. The art
  is **not redistributed in this repository** (`assets/decks/` is git-ignored) — each user fetches
  it themselves, and it remains © Black Hills InfoSec under its Creative Commons terms.
- **Solo narration** is generated locally by an [Ollama](https://ollama.com/) model.

The application **code** in this repository is provided as-is for local/personal use. Please
respect Black Hills InfoSec's licensing for the game and its cards.
