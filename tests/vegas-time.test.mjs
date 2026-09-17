import test from "node:test";
import assert from "node:assert/strict";
import {
  LAS_VEGAS_TIME_ZONE,
  formatVegasDate,
  formatVegasTime,
  formatVegasDateTime,
  hasTimeValue,
  formatVegasEventTime,
} from "../src/lib/vegas-time.js";

test("the app pins all public dates to the Las Vegas zone", () => {
  assert.equal(LAS_VEGAS_TIME_ZONE, "America/Los_Angeles");
});

test("a date-only value is not dragged back a day by the timezone shift", () => {
  // Parsed at noon UTC on purpose: a bare "2026-03-01" would be midnight UTC
  // and render as Feb 28 in Las Vegas.
  const formatted = formatVegasDate("2026-03-01");
  assert.match(formatted, /1 Mar 2026/);
  assert.match(formatted, /^Sun/);
});

test("an instant is rendered in Vegas local time, not UTC", () => {
  // 2026-03-01T02:00Z is still 18:00 on Feb 28 in Las Vegas.
  assert.match(formatVegasDate("2026-03-01T02:00:00Z"), /28 Feb 2026/);
  assert.match(formatVegasTime("2026-03-01T02:00:00Z"), /^6:00 pm/i);

  const dateTime = formatVegasDateTime("2026-03-01T02:00:00Z");
  assert.match(dateTime, /28 Feb/);
  assert.match(dateTime, /6:00 pm/i);
  assert.match(dateTime, /^Sat/);
});

test("formatters echo unusable input instead of printing 'Invalid Date'", () => {
  for (const fn of [formatVegasDate, formatVegasTime, formatVegasDateTime]) {
    assert.equal(fn("not a date"), "not a date");
    assert.equal(fn(""), "");
    assert.equal(fn(null), "");
    assert.equal(fn(undefined), "");
  }
});

test("hasTimeValue only recognises timestamps that carry a clock time", () => {
  assert.equal(hasTimeValue("2026-03-01T19:35:00Z"), true);
  assert.equal(hasTimeValue("2026-03-01T19:35"), true);
  assert.equal(hasTimeValue("2026-03-01"), false);
  assert.equal(hasTimeValue(""), false);
  assert.equal(hasTimeValue(null), false);
});

test("event times prefer the timestamp, then the typed start_time, then nothing", () => {
  assert.match(
    formatVegasEventTime({ event_date: "2026-03-01T02:00:00Z", start_time: "7pm" }),
    /6:00 pm/i,
  );
  assert.equal(
    formatVegasEventTime({ event_date: "2026-03-01", start_time: "7:00 PM" }),
    "7:00 PM Las Vegas time",
  );
  assert.equal(formatVegasEventTime({ event_date: "2026-03-01" }), "");
  assert.equal(formatVegasEventTime(null), "");
});
