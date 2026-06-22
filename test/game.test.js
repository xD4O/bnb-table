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
function fixedSetup(game) {
  game.setup(
    {
      objective: { initial: "initial-1", pivot: "pivot-1", c2: "c2-1", persist: "persist-1" },
      established: ["procedure-1", "procedure-2", "procedure-3", "procedure-4"],
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

test("not-established procedure uses the 17 threshold", () => {
  const game = makeGame([16, 17]);
  startGame(game);
  // procedure-5 is NOT established. die 16 -> fail (needs 17)
  game.roll({ connId: "p0", procedureId: "procedure-5" });
  assert.equal(game.state.lastRoll.success, false);
  // die 17 -> success
  game.roll({ connId: "p0", procedureId: "procedure-5" });
  assert.equal(game.state.lastRoll.success, true);
});

test("GM config edits change roll thresholds", () => {
  const game = makeGame([15]);
  startGame(game);
  game.setConfig({ establishedThreshold: 15 }, "gm1");
  game.roll({ connId: "p0", procedureId: "procedure-1" }); // die 15 >= 15 -> success
  assert.equal(game.state.lastRoll.success, true);
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
  game.setConfig({ turnLimit: 3 }, "gm1");
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
