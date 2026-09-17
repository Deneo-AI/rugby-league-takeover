import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./local-storage-stub.mjs";

const { storage } = installLocalStorage();

const { readJson, writeJson } = await import("../src/components/forum/tipping/storage.js");

const reset = () => storage.clear();

test("readJson returns the fallback when nothing is stored", () => {
  reset();
  assert.deepEqual(readJson("rlt_footy_tips_v2", {}), {});
  assert.deepEqual(readJson("rlt_footy_tips_v2", []), []);
  assert.equal(readJson("rlt_footy_points", 0), 0);
});

test("writeJson/readJson round-trip tip maps and scalars", () => {
  reset();
  const tips = { "game-1": { selected_team: "Storm", margin: 12, tipped_at: "2026-03-01T00:00:00Z" } };
  writeJson("rlt_footy_tips_v2", tips);
  assert.deepEqual(readJson("rlt_footy_tips_v2", {}), tips);

  writeJson("rlt_footy_points", 42);
  assert.equal(readJson("rlt_footy_points", 0), 42);
});

test("corrupted JSON is cleared instead of crashing the tipping page", () => {
  reset();
  storage.setItem("rlt_footy_tips_v2", "{not json");
  assert.deepEqual(readJson("rlt_footy_tips_v2", {}), {});
  assert.equal(storage.getItem("rlt_footy_tips_v2"), null, "bad data is removed so it cannot fail twice");
});

test("a shape mismatch against an object fallback is treated as corruption", () => {
  reset();
  // An array or null where a tip map is expected would make Object.entries()
  // callers behave strangely, so it is reset rather than returned.
  for (const bad of ["[1,2,3]", "null", '"a string"', "7"]) {
    storage.setItem("rlt_footy_tips_v2", bad);
    assert.deepEqual(readJson("rlt_footy_tips_v2", {}), {}, `${bad} should reset`);
    assert.equal(storage.getItem("rlt_footy_tips_v2"), null);
  }
});

test("array and scalar fallbacks accept any parsed value", () => {
  reset();
  storage.setItem("rlt_tip_streak", "null");
  assert.equal(readJson("rlt_tip_streak", 0), null, "scalar fallbacks do not run the object shape guard");

  storage.setItem("rlt_history", "[1,2]");
  assert.deepEqual(readJson("rlt_history", []), [1, 2]);
});

test("writes never throw when storage is blocked or full", () => {
  installLocalStorage({ throwOnWrite: true });
  assert.doesNotThrow(() => writeJson("rlt_footy_points", 1));
  installLocalStorage();
});
