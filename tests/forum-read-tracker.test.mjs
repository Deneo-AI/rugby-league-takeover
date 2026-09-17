import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./local-storage-stub.mjs";

const { storage } = installLocalStorage();
const STORAGE_KEY = "rlt_forum_read";

const {
  getReadTimestamps,
  markThreadRead,
  getUnreadReplyCount,
  hasUnreadReplies,
} = await import("../src/lib/forum-read-tracker.js");

const reset = () => storage.clear();
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

test("read timestamps survive corrupted storage without throwing", () => {
  reset();
  assert.deepEqual(getReadTimestamps(), {}, "missing key reads as empty");

  storage.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(getReadTimestamps(), {}, "corrupted JSON must not break the forum");
});

test("markThreadRead records a timestamp per thread", () => {
  reset();
  const before = Date.now();
  markThreadRead("thread-1");
  markThreadRead("thread-2");

  const stamps = getReadTimestamps();
  assert.deepEqual(Object.keys(stamps).sort(), ["thread-1", "thread-2"]);
  assert.ok(stamps["thread-1"] >= before);
});

test("markThreadRead keeps only the 200 most recently read threads", () => {
  reset();
  // Seed 250 threads with increasing recency so the oldest are the low indexes.
  const seeded = {};
  for (let i = 0; i < 250; i += 1) seeded[`thread-${i}`] = 1000 + i;
  storage.setItem(STORAGE_KEY, JSON.stringify(seeded));

  markThreadRead("thread-new");
  const stamps = getReadTimestamps();

  assert.equal(Object.keys(stamps).length, 200, "LRU cap keeps storage bounded");
  assert.ok(stamps["thread-new"], "the thread just read is always kept");
  assert.ok(stamps["thread-249"], "recent reads are kept");
  assert.equal(stamps["thread-0"], undefined, "the oldest reads are evicted");
});

test("getUnreadReplyCount counts every reply until the thread has been opened", () => {
  const replies = [
    { created_date: isoAgo(60_000) },
    { created_date: isoAgo(30_000) },
    { created_date: isoAgo(10_000) },
  ];
  assert.equal(getUnreadReplyCount("thread-1", replies, null), 3);
  assert.equal(getUnreadReplyCount("thread-1", replies, Date.now() - 45_000), 2);
  assert.equal(getUnreadReplyCount("thread-1", replies, Date.now()), 0);
  assert.equal(getUnreadReplyCount("thread-1", [], null), 0);
});

test("hasUnreadReplies flags only replies newer than the last visit", () => {
  reset();
  assert.equal(hasUnreadReplies("thread-1", [{ created_date: isoAgo(1000) }]), true);
  assert.equal(hasUnreadReplies("thread-1", []), false, "an empty thread is never unread");

  markThreadRead("thread-1");
  assert.equal(hasUnreadReplies("thread-1", [{ created_date: isoAgo(60_000) }]), false);
  assert.equal(
    hasUnreadReplies("thread-1", [{ created_date: new Date(Date.now() + 60_000).toISOString() }]),
    true,
    "a reply posted after the visit re-flags the thread",
  );
});
