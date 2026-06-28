import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/game.js";

// --- helpers ---------------------------------------------------------------

function makeCatalog() {
  const cards = [];
  const add = (type, n) => {
    for (let i = 1; i <= n; i++) {
      cards.push({ id: `${type}-${i}`, name: `${type} ${i}`, image: `img/${type}${i}.png`, type });
    }
  };
  add("initial", 3);
  add("pivot", 3);
  add("c2", 3);
  add("persist", 3);
  add("procedure", 6);
  add("inject", 3);
  add("consultant", 3);
  return {
    deckTitle: "Test",
    cards,
    backs: {
      initial: "b-init.png",
      pivot: "b-piv.png",
      c2: "b-c2.png",
      persist: "b-pers.png",
      inject: "b-inj.png",
      consultant: "b-con.png",
    },
  };
}

// A Game wired with a queue of forced d20 values for deterministic rolls.
function makeGame(d20queue = []) {
  const q = [...d20queue];
  return new Game(makeCatalog(), { d20: () => (q.length ? q.shift() : 1) });
}

// Standard fixed setup so tests don't depend on randomness.
function fixedSetup(game, detection) {
  game.setup(
    {
      objective: { initial: "initial-1", pivot: "pivot-1", c2: "c2-1", persist: "persist-1" },
      established: ["procedure-1", "procedure-2", "procedure-3", "procedure-4"],
      detection,
    },
    "gm1"
  );
}

function startGame(game, players = 3) {
  game.join("gm1", { name: "GM", role: "gm" });
  for (let i = 0; i < players; i++) game.join(`p${i}`, { name: `P${i}`, role: "player" });
  fixedSetup(game);
  const r = game.start({}, "gm1");
  assert.equal(r.ok, true, r.error);
}

// --- redaction -------------------------------------------------------------

test("player projection never contains hidden objective card identities", () => {
  const game = makeGame();
  startGame(game);
  const blob = JSON.stringify(game.project("player"));
  assert.ok(!blob.includes("initial-1"), "hidden initial id leaked");
  assert.ok(!blob.includes("img/initial1.png"), "hidden initial art leaked");
  // GM projection DOES contain it.
  assert.ok(JSON.stringify(game.project("gm")).includes("initial-1"));
});

test("revealed objective slot becomes visible to players", () => {
  const game = makeGame();
  startGame(game);
  game.reveal({ slot: "initial" }, "gm1");
  const proj = game.project("player");
  assert.equal(proj.objective.initial.locked, undefined);
  assert.equal(proj.objective.initial.id, "initial-1");
  assert.equal(proj.objective.pivot.locked, true); // still hidden
});

// --- roll resolution -------------------------------------------------------

test("roll: established success at threshold, modifier applied, consecutiveFails resets", () => {
  const game = makeGame([10, 8]); // first die 10, second die 8
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1"); // isolate from cooldown
  // established threshold 11. die 10 + modifier 0 = 10 -> FAIL
  let r = game.roll({ connId: "p0", procedureId: "procedure-1", modifier: 0 });
  assert.equal(r.ok, true);
  assert.equal(game.state.lastRoll.success, false);
  assert.equal(game.state.failures, 1);
  assert.equal(game.state.consecutiveFails, 1);
  // die 8 + modifier 3 = 11 -> SUCCESS (>=11), consecutiveFails resets
  r = game.roll({ connId: "p0", procedureId: "procedure-1", modifier: 3 });
  assert.equal(game.state.lastRoll.success, true);
  assert.equal(game.state.consecutiveFails, 0);
  assert.equal(game.state.failures, 1); // unchanged on success
  assert.equal(game.state.turn, 2);
});

test("not-established procedure gets no bonus and needs the full threshold", () => {
  const game = makeGame([13, 14]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1"); // isolate from cooldown
  // procedure-5 is NOT established (no +3). die 13 -> 13 < 14 -> fail
  game.roll({ connId: "p0", procedureId: "procedure-5" });
  assert.equal(game.state.lastRoll.establishedBonus, 0);
  assert.equal(game.state.lastRoll.success, false);
  // die 14 -> 14 >= 14 -> success
  game.roll({ connId: "p0", procedureId: "procedure-5" });
  assert.equal(game.state.lastRoll.success, true);
});

test("an established procedure adds its bonus to the roll total", () => {
  const game = makeGame([10]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // established
  const r = game.state.lastRoll;
  assert.equal(r.established, true);
  assert.equal(r.establishedBonus, 3); // classic default
  assert.equal(r.total, 13); // d20 10 + 3
});

test("a non-established procedure gets no bonus", () => {
  const game = makeGame([10]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-5" }); // not established
  const r = game.state.lastRoll;
  assert.equal(r.establishedBonus, 0);
  assert.equal(r.total, 10);
});

test("an inject modifier subtracts from an established roll's total (bonus included)", () => {
  const game = makeGame([10]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.setModifier({ value: -3 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 10 + 3 (est) - 3 (inject) = 10
  assert.equal(game.state.lastRoll.total, 10);
});

test("GM config edits change the bonus and threshold", () => {
  const game = makeGame([15, 15]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0, successThreshold: 25, establishedBonus: 6 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 15 + 6 = 21 < 25 -> fail
  assert.equal(game.state.lastRoll.success, false);
  game.setConfig({ successThreshold: 20 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 15 + 6 = 21 >= 20 -> success
  assert.equal(game.state.lastRoll.success, true);
});

// --- cooldown house-rule ---------------------------------------------------

test("rolling a procedure puts it on cooldown for N turns", () => {
  const game = makeGame([5, 5, 5]);
  startGame(game);
  game.setConfig({ cooldownTurns: 1 }, "gm1");
  const r1 = game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(r1.ok, true);
  // immediate re-roll of the same procedure is blocked
  const r2 = game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /cooldown/i);
  assert.equal(game.state.turn, 1); // blocked roll did not consume a turn
  // a different procedure still works and advances the turn
  const r3 = game.roll({ connId: "p0", procedureId: "procedure-2" });
  assert.equal(r3.ok, true);
  assert.equal(game.state.turn, 2);
  // now procedure-1 has cooled down
  const r4 = game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(r4.ok, true);
  assert.equal(game.state.turn, 3);
});

test("cooldownTurns 0 disables the cooldown rule", () => {
  const game = makeGame([5, 5]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  assert.equal(game.roll({ connId: "p0", procedureId: "procedure-1" }).ok, true);
  assert.equal(game.roll({ connId: "p0", procedureId: "procedure-1" }).ok, true);
  assert.equal(game.state.turn, 2);
});

test("projection reports remaining cooldown turns per procedure", () => {
  const game = makeGame([5, 5]);
  startGame(game);
  game.setConfig({ cooldownTurns: 2 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(game.project("player").cooldowns["procedure-1"], 2);
  game.roll({ connId: "p0", procedureId: "procedure-2" });
  assert.equal(game.project("player").cooldowns["procedure-1"], 1);
});

// --- detection / auto-reveal -----------------------------------------------

function startGameDet(game, detection, players = 1) {
  game.join("gm1", { name: "GM", role: "gm" });
  for (let i = 0; i < players; i++) game.join(`p${i}`, { name: `P${i}`, role: "player" });
  fixedSetup(game, detection);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  assert.equal(game.start({}, "gm1").ok, true);
}

test("success auto-reveals when the procedure detects exactly one unrevealed card", () => {
  const game = makeGame([15]);
  startGameDet(game, { initial: ["procedure-1"], pivot: ["procedure-2"] });
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // detects only initial
  assert.equal(game.state.revealed.initial, true);
  assert.equal(game.state.successes, 1);
  assert.equal(game.state.pendingReveal, null);
});

test("success with multiple detected cards waits for the GM to choose", () => {
  const game = makeGame([15]);
  startGameDet(game, { initial: ["procedure-1"], pivot: ["procedure-1"] });
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // detects initial AND pivot
  assert.equal(game.state.revealed.initial, false);
  assert.equal(game.state.pendingReveal.options.sort().join(), "initial,pivot");
  // GM picks one
  game.reveal({ slot: "pivot" }, "gm1");
  assert.equal(game.state.revealed.pivot, true);
  assert.equal(game.state.pendingReveal, null);
});

test("success that detects nothing reveals nothing (with a detection map)", () => {
  const game = makeGame([15]);
  startGameDet(game, { initial: ["procedure-2"] });
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // procedure-1 detects nothing
  assert.equal(game.state.successes, 0);
  assert.equal(game.state.pendingReveal, null);
});

test("without a detection map, a success with one card left auto-reveals it", () => {
  const game = makeGame([15]);
  startGameDet(game, undefined);
  game.reveal({ slot: "initial" }, "gm1");
  game.reveal({ slot: "pivot" }, "gm1");
  game.reveal({ slot: "c2" }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // only persist left -> auto
  assert.equal(game.state.revealed.persist, true);
  assert.equal(game.state.phase, "won");
});

// --- solo mode -------------------------------------------------------------

test("solo mode reveals the attack chain in order on each success", () => {
  const game = makeGame([15, 15, 15, 15]);
  game.join("gm1", { name: "IM", role: "gm" });
  game.join("p0", { name: "Solo", role: "player" });
  fixedSetup(game);
  game.setMode("solo");
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  assert.equal(game.start({}, "gm1").ok, true);
  assert.equal(game.state.mode, "solo");

  game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(game.state.revealed.initial, true);
  assert.equal(game.state.revealed.pivot, false);
  game.roll({ connId: "p0", procedureId: "procedure-2" });
  assert.equal(game.state.revealed.pivot, true);
  game.roll({ connId: "p0", procedureId: "procedure-3" });
  assert.equal(game.state.revealed.c2, true);
  game.roll({ connId: "p0", procedureId: "procedure-4" });
  assert.equal(game.state.revealed.persist, true);
  assert.equal(game.state.phase, "won");
});

test("solo mode: a failed roll reveals nothing", () => {
  const game = makeGame([3]);
  game.join("gm1", { name: "IM", role: "gm" });
  game.join("p0", { name: "Solo", role: "player" });
  fixedSetup(game);
  game.setMode("solo");
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.start({}, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 3 < 11
  assert.equal(game.state.successes, 0);
  assert.equal(game.state.revealed.initial, false);
});

test("narrative entries are recorded and projected", () => {
  const game = makeGame();
  game.setMode("solo");
  game.addNarrative("The SOC phone rings at 3am.");
  assert.equal(game.state.narrative.length, 1);
  assert.equal(game.project("player").narrative[0].text, "The SOC phone rings at 3am.");
});

// --- auto-inject on natural 1 / 20 -----------------------------------------

test("a natural 20 auto-plays an inject", () => {
  const game = makeGame([20]);
  startGameDet(game, { initial: ["procedure-2"] }); // detects nothing, so no win interference
  game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(game.state.playedInjects.length, 1);
  assert.equal(game.byId.get(game.state.playedInjects[0]).type, "inject");
});

test("a natural 1 auto-plays an inject; a middling roll does not", () => {
  const g1 = makeGame([1]);
  startGameDet(g1, { initial: ["procedure-2"] });
  g1.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(g1.state.playedInjects.length, 1);

  const g2 = makeGame([10]);
  startGameDet(g2, { initial: ["procedure-2"] });
  g2.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(g2.state.playedInjects.length, 0);
});

// --- config default --------------------------------------------------------

test("default cooldown is 3 turns", () => {
  const game = makeGame();
  assert.equal(game.state.config.cooldownTurns, 3);
});

// --- active (inject) roll modifier -----------------------------------------

test("active roll modifier is applied to every roll", () => {
  const game = makeGame([13]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.setModifier({ value: -3 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 13 + 3 (est) - 3 = 13, threshold 14
  assert.equal(game.state.lastRoll.activeModifier, -3);
  assert.equal(game.state.lastRoll.total, 13);
  assert.equal(game.state.lastRoll.success, false);
});

test("playing an inject can set the active roll modifier", () => {
  const game = makeGame([13]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.playInject({ cardId: "inject-1", modifier: -3 }, "gm1");
  assert.equal(game.state.activeModifier, -3);
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // 13 + 3 (est) - 3 = 13
  assert.equal(game.state.lastRoll.total, 13);
});

test("the active modifier stacks with a per-roll modifier", () => {
  const game = makeGame([13]);
  startGame(game);
  game.setConfig({ cooldownTurns: 0 }, "gm1");
  game.setModifier({ value: -3 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1", modifier: 2 }); // 13 + 3 (est) + 2 - 3 = 15
  assert.equal(game.state.lastRoll.total, 15);
  assert.equal(game.state.lastRoll.success, true); // >= 14
});

test("only the GM can change the active modifier", () => {
  const game = makeGame();
  startGame(game);
  assert.equal(game.setModifier({ value: -3 }, "p0").ok, false);
});

// --- chat visibility -------------------------------------------------------

function chatTable() {
  const game = makeGame();
  game.join("gm1", { name: "GM", role: "gm" });
  game.join("p0", { name: "Ann", role: "player" });
  game.join("v0", { name: "Eve", role: "viewer" });
  return game;
}

test("player chat is seen by players and GM but not viewers", () => {
  const game = chatTable();
  game.postChat({ connId: "p0", text: "team, focus DNS" });
  assert.deepEqual(game.chatFor("player").map((m) => m.text), ["team, focus DNS"]);
  assert.deepEqual(game.chatFor("gm").map((m) => m.text), ["team, focus DNS"]);
  assert.deepEqual(game.chatFor("viewer").map((m) => m.text), []);
});

test("viewer chat is seen by viewers and GM but not players", () => {
  const game = chatTable();
  game.postChat({ connId: "v0", text: "they'll never get it" });
  assert.deepEqual(game.chatFor("viewer").map((m) => m.text), ["they'll never get it"]);
  assert.deepEqual(game.chatFor("gm").map((m) => m.text), ["they'll never get it"]);
  assert.deepEqual(game.chatFor("player").map((m) => m.text), []);
});

test("GM can address either the players or the viewers channel", () => {
  const game = chatTable();
  game.postChat({ connId: "gm1", text: "hint for the team", channel: "players" });
  game.postChat({ connId: "gm1", text: "psst, spectators", channel: "viewers" });
  assert.deepEqual(game.chatFor("player").map((m) => m.text), ["hint for the team"]);
  assert.deepEqual(game.chatFor("viewer").map((m) => m.text), ["psst, spectators"]);
  assert.equal(game.chatFor("gm").length, 2);
});

test("projection carries the role-filtered chat", () => {
  const game = chatTable();
  game.postChat({ connId: "p0", text: "p" });
  game.postChat({ connId: "v0", text: "v" });
  assert.deepEqual(game.project("viewer").chat.map((m) => m.text), ["v"]);
  assert.deepEqual(game.project("player").chat.map((m) => m.text), ["p"]);
  assert.equal(game.project("gm").chat.length, 2);
});

// --- win / lose ------------------------------------------------------------

test("revealing all 4 attack cards wins the game", () => {
  const game = makeGame();
  startGame(game);
  for (const slot of ["initial", "pivot", "c2", "persist"]) {
    assert.equal(game.state.phase, "playing");
    game.reveal({ slot }, "gm1");
  }
  assert.equal(game.state.phase, "won");
  assert.equal(game.state.successes, 4);
});

test("reaching the turn limit without all 4 revealed loses", () => {
  const game = makeGame(Array(10).fill(1)); // all fails
  startGame(game);
  game.setConfig({ turnLimit: 3, cooldownTurns: 0 }, "gm1"); // isolate from cooldown
  game.roll({ connId: "p0", procedureId: "procedure-1" });
  game.roll({ connId: "p0", procedureId: "procedure-1" });
  assert.equal(game.state.phase, "playing");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // turn 3 == limit
  assert.equal(game.state.phase, "lost");
});

// --- role permission guards ------------------------------------------------

test("defender cannot reveal objective cards", () => {
  const game = makeGame();
  startGame(game);
  const r = game.reveal({ slot: "initial" }, "p0");
  assert.equal(r.ok, false);
  assert.equal(game.state.revealed.initial, false);
});

test("viewer cannot roll", () => {
  const game = makeGame([20]);
  startGame(game);
  game.join("v1", { name: "V", role: "viewer" });
  const r = game.roll({ connId: "v1", procedureId: "procedure-1" });
  assert.equal(r.ok, false);
  assert.equal(game.state.turn, 0);
});

// --- capacity --------------------------------------------------------------

test("third Game Master is rejected", () => {
  const game = makeGame();
  assert.equal(game.join("g1", { name: "A", role: "gm" }).ok, true);
  assert.equal(game.join("g2", { name: "B", role: "gm" }).ok, true);
  const r = game.join("g3", { name: "C", role: "gm" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Game Master/i);
});

test("sixth player is rejected, viewers are unlimited, seats reopen on disconnect", () => {
  const game = makeGame();
  for (let i = 0; i < 5; i++) assert.equal(game.join(`p${i}`, { name: `P${i}`, role: "player" }).ok, true);
  assert.equal(game.join("p5", { name: "P5", role: "player" }).ok, false);
  // viewers unlimited
  for (let i = 0; i < 20; i++) assert.equal(game.join(`v${i}`, { name: `V${i}`, role: "viewer" }).ok, true);
  // disconnect frees a player seat
  game.leave("p0");
  assert.equal(game.join("p5", { name: "P5", role: "player" }).ok, true);
  assert.equal(game.counts().player, 5);
});

test("default minimum players is 1", () => {
  const game = makeGame();
  assert.equal(game.state.capacity.playerMin, 1);
});

test("one player meets the minimum and can start without force", () => {
  const game = makeGame();
  game.join("gm1", { name: "GM", role: "gm" });
  game.join("p0", { name: "P0", role: "player" });
  fixedSetup(game);
  const r = game.start({}, "gm1");
  assert.equal(r.ok, true, r.error);
  assert.equal(game.state.phase, "playing");
});

test("start with zero players requires force", () => {
  const game = makeGame();
  game.join("gm1", { name: "GM", role: "gm" });
  fixedSetup(game);
  const r = game.start({}, "gm1");
  assert.equal(r.ok, false);
  assert.equal(r.needForce, true);
  const r2 = game.start({ force: true }, "gm1");
  assert.equal(r2.ok, true);
  assert.equal(game.state.phase, "playing");
});
