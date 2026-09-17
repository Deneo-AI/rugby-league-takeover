import test from "node:test";
import assert from "node:assert/strict";

// csv.js talks to the DOM (Blob → object URL → synthetic <a> click), so the
// three browser APIs it touches are stubbed and recorded here.
const calls = { blobs: [], created: [], revoked: [], links: [] };

class FakeBlob {
  constructor(parts, options) {
    this.text = parts.join("");
    this.type = options?.type;
    calls.blobs.push(this);
  }
}

globalThis.Blob = FakeBlob;
globalThis.URL = {
  createObjectURL: (blob) => {
    calls.created.push(blob);
    return `blob:rlt/${calls.created.length}`;
  },
  revokeObjectURL: (url) => calls.revoked.push(url),
};
globalThis.document = {
  createElement: (tag) => {
    const link = { tag, clicked: 0, click: () => { link.clicked += 1; } };
    calls.links.push(link);
    return link;
  },
};

const { downloadCsv } = await import("../src/lib/csv.js");

const lastCsv = () => calls.blobs.at(-1).text;
const lastLink = () => calls.links.at(-1);

test("downloadCsv writes a header row followed by the data rows", () => {
  downloadCsv("orders.csv", ["Name", "Email"], [
    ["Dene Palmer", "deneop24@gmail.com"],
    ["Sam Burgess", "sam@example.com"],
  ]);

  assert.deepEqual(lastCsv().split("\n"), [
    '"Name","Email"',
    '"Dene Palmer","deneop24@gmail.com"',
    '"Sam Burgess","sam@example.com"',
  ]);
});

test("cells are always quoted and embedded quotes are doubled", () => {
  // Unescaped commas/quotes are the classic CSV export bug: they shift every
  // following column in Excel.
  downloadCsv("orders.csv", ["Notes"], [['He said "go", loudly'], ["Vegas, NV"]]);

  assert.deepEqual(lastCsv().split("\n"), [
    '"Notes"',
    '"He said ""go"", loudly"',
    '"Vegas, NV"',
  ]);
});

test("null and undefined cells export as empty strings, not 'null'", () => {
  downloadCsv("orders.csv", ["Tracking"], [[null], [undefined], [0], [false]]);

  assert.deepEqual(lastCsv().split("\n"), ['"Tracking"', '""', '""', '"0"', '"false"']);
});

test("a header-only export is still a valid file", () => {
  downloadCsv("orders.csv", ["Name"], []);
  assert.equal(lastCsv(), '"Name"');
});

test("the download is triggered and the object URL is released", () => {
  downloadCsv("orders-2026.csv", ["Name"], [["Dene"]]);

  const link = lastLink();
  assert.equal(link.tag, "a");
  assert.equal(link.download, "orders-2026.csv");
  assert.ok(link.href.startsWith("blob:rlt/"));
  assert.equal(calls.created.at(-1), calls.blobs.at(-1), "the URL is made from the CSV blob");
  assert.equal(link.clicked, 1);
  assert.equal(calls.blobs.at(-1).type, "text/csv;charset=utf-8;");
  assert.equal(calls.revoked.at(-1), link.href, "the blob URL must be revoked to avoid a leak");
});
