/**
 * Minimal in-memory localStorage for the browser-storage modules under test
 * (forum read tracker, recent-news cache, tipping storage). Not a test file —
 * imported by the *.test.mjs files that need `globalThis.localStorage`.
 */
export function installLocalStorage({ throwOnWrite = false } = {}) {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => {
      if (throwOnWrite) throw new Error("QuotaExceededError");
      store.set(String(key), String(value));
    },
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
  };
  globalThis.localStorage = storage;
  return { storage, store };
}
