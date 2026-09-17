import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./local-storage-stub.mjs";

const { storage } = installLocalStorage();
const STORAGE_KEY = "rlt_recent_news";

const { getRecentNews, saveRecentNews } = await import("../src/lib/recent-news.js");

const article = (i) => ({ id: `news-${i}`, title: `Story ${i}` });
const reset = () => storage.clear();

test("an empty or corrupted cache reads as an empty list", () => {
  reset();
  assert.deepEqual(getRecentNews(), []);

  storage.setItem(STORAGE_KEY, "{not json");
  assert.deepEqual(getRecentNews(), [], "corrupted cache must not break the offline News page");

  // A non-array payload (e.g. an old object-shaped cache) is also rejected.
  storage.setItem(STORAGE_KEY, JSON.stringify({ id: "news-1" }));
  assert.deepEqual(getRecentNews(), []);
});

test("saved articles round-trip in order", () => {
  reset();
  const articles = [article(1), article(2)];
  saveRecentNews(articles);
  assert.deepEqual(getRecentNews(), articles);
});

test("the cache is capped at 30 articles, newest first", () => {
  reset();
  saveRecentNews(Array.from({ length: 45 }, (_, i) => article(i)));

  const cached = getRecentNews();
  assert.equal(cached.length, 30);
  assert.equal(cached[0].id, "news-0");
  assert.equal(cached.at(-1).id, "news-29");
});

test("empty or non-array saves leave an existing cache untouched", () => {
  reset();
  saveRecentNews([article(1)]);

  saveRecentNews([]);
  saveRecentNews(null);
  saveRecentNews({ id: "news-2" });

  assert.deepEqual(getRecentNews(), [article(1)], "a failed fetch must not wipe the offline cache");
});

test("a blocked or full storage quota is swallowed", async () => {
  const blocked = installLocalStorage({ throwOnWrite: true });
  assert.doesNotThrow(() => saveRecentNews([article(1)]));
  assert.deepEqual(getRecentNews(), [], "best-effort only — nothing was written");
  blocked.store.clear();
  installLocalStorage();
});
