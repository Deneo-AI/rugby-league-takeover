import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_SYMBOLS,
  SLOT_BADGES,
  SPIN_COOLDOWN_MS,
  getBadge,
  weightedSymbol,
  spinReels,
  evaluateReels,
  topBadge,
  parseBadgeIds,
} from "../src/lib/slot-badges.js";

const symbol = (key) => SLOT_SYMBOLS.find((s) => s.key === key);

test("every symbol has exactly one badge and rarer symbols are rarer badges", () => {
  assert.equal(SLOT_SYMBOLS.length, SLOT_BADGES.length);
  const badgeIds = SLOT_BADGES.map((b) => b.id);
  assert.deepEqual(SLOT_SYMBOLS.map((s) => s.key), badgeIds, "a 3-of-a-kind must always map to a badge");
  assert.equal(new Set(badgeIds).size, badgeIds.length, "badge ids must be unique");

  for (const [i, sym] of SLOT_SYMBOLS.entries()) {
    assert.ok(sym.weight > 0, `${sym.key} needs a positive weight`);
    if (i > 0) {
      assert.ok(SLOT_SYMBOLS[i - 1].weight > sym.weight, `${sym.key} must be rarer than the symbol above it`);
      assert.ok(SLOT_BADGES[i - 1].rarity < SLOT_BADGES[i].rarity, `${sym.key} badge rarity must increase with symbol rarity`);
    }
    assert.equal(SLOT_BADGES[i].emoji, sym.emoji, `${sym.key} badge shows a different emoji than the reel`);
    assert.ok(SLOT_BADGES[i].label && SLOT_BADGES[i].tier, `${sym.key} badge missing label/tier`);
  }
});

test("getBadge resolves stored ids and rejects unknown ones", () => {
  assert.equal(getBadge("seven").label, "Triple Seven");
  assert.equal(getBadge("not-a-badge"), null);
  assert.equal(getBadge(undefined), null);
});

test("weightedSymbol only ever returns real symbols and favours common ones", () => {
  const keys = new Set(SLOT_SYMBOLS.map((s) => s.key));
  const counts = {};
  for (let i = 0; i < 4000; i += 1) {
    const s = weightedSymbol();
    assert.ok(keys.has(s.key), `weightedSymbol returned ${s.key}`);
    counts[s.key] = (counts[s.key] || 0) + 1;
  }
  // cherry is weighted 30 vs seven's 2 — over 4000 spins the ordering is stable
  // enough to prove the weighting is applied at all.
  assert.ok(counts.cherry > (counts.seven || 0), "weights must bias the reel toward common symbols");
});

test("weightedSymbol is exhaustive at both ends of the weight table", () => {
  const original = Math.random;
  try {
    Math.random = () => 0; // lowest roll → first (most common) symbol
    assert.equal(weightedSymbol().key, "cherry");
    Math.random = () => 0.999999; // highest roll → last (rarest) symbol
    assert.equal(weightedSymbol().key, "seven");
    Math.random = () => 1; // Math.random never returns 1, but the top of the
    // range must still land on a symbol rather than undefined.
    assert.equal(weightedSymbol().key, "seven");
  } finally {
    Math.random = original;
  }
});

test("spinReels returns three independently drawn reels", () => {
  const reels = spinReels();
  assert.equal(reels.length, 3);
  for (const reel of reels) assert.ok(symbol(reel.key), `unknown reel symbol ${reel.key}`);
});

test("evaluateReels awards a badge only on a genuine 3-of-a-kind", () => {
  const win = evaluateReels([symbol("crown"), symbol("crown"), symbol("crown")]);
  assert.equal(win.type, "win");
  assert.equal(win.symbol.key, "crown");
  assert.equal(win.badge.id, "crown");
  assert.equal(win.badge.tier, "Legendary");
});

test("evaluateReels reports a near miss for any real pair, in any position", () => {
  const cases = [
    [["star", "star", "lemon"], "star"],
    [["lemon", "star", "star"], "star"],
    [["star", "lemon", "star"], "star"],
  ];
  for (const [keys, expected] of cases) {
    const result = evaluateReels(keys.map(symbol));
    assert.equal(result.type, "near", `${keys.join("/")} is a near miss`);
    assert.equal(result.symbol.key, expected);
    assert.equal(result.badge, undefined, "a pair must never hand out a badge");
  }

  const loss = evaluateReels([symbol("cherry"), symbol("lemon"), symbol("bell")]);
  assert.deepEqual(loss, { type: "none" });
});

test("topBadge shows the rarest badge a fan owns", () => {
  assert.equal(topBadge(["cherry", "seven", "star"]).id, "seven");
  assert.equal(topBadge(["cherry"]).id, "cherry");
  assert.equal(topBadge(["cherry", "bogus"]).id, "cherry", "unknown ids are ignored");
  assert.equal(topBadge([]), null);
  assert.equal(topBadge(), null);
  assert.equal(topBadge(null), null);
  assert.equal(topBadge(["bogus"]), null);
});

test("topBadge does not reorder the caller's array", () => {
  const owned = ["cherry", "seven"];
  topBadge(owned);
  assert.deepEqual(owned, ["cherry", "seven"]);
});

test("parseBadgeIds normalises arrays, comma strings and junk", () => {
  assert.deepEqual(parseBadgeIds(["cherry", "seven"]), ["cherry", "seven"]);
  assert.deepEqual(parseBadgeIds(["cherry", "", null]), ["cherry"]);
  assert.deepEqual(parseBadgeIds(" cherry , seven ,"), ["cherry", "seven"]);
  assert.deepEqual(parseBadgeIds(""), []);
  assert.deepEqual(parseBadgeIds(null), []);
  assert.deepEqual(parseBadgeIds(undefined), []);
  assert.deepEqual(parseBadgeIds({ cherry: true }), []);
});

test("the spin cooldown is a full day", () => {
  assert.equal(SPIN_COOLDOWN_MS, 86_400_000);
});
