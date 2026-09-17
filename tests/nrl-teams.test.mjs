import test from "node:test";
import assert from "node:assert/strict";
import { NRL_TEAMS, SUPER_LEAGUE_TEAMS, ALL_TEAMS } from "../src/lib/nrl-teams.js";

const shape = (teams, label) => {
  const names = new Set();
  const shortNames = new Set();
  for (const team of teams) {
    assert.ok(team.name && typeof team.name === "string", `${label} entry missing name`);
    assert.ok(team.short_name && typeof team.short_name === "string", `${team.name} missing short_name`);
    assert.equal(team.name.trim(), team.name, `${team.name} has stray whitespace`);
    assert.equal(team.short_name.trim(), team.short_name, `${team.short_name} has stray whitespace`);
    assert.ok(!names.has(team.name), `${label} has duplicate name ${team.name}`);
    assert.ok(!shortNames.has(team.short_name), `${label} has duplicate short_name ${team.short_name}`);
    names.add(team.name);
    shortNames.add(team.short_name);
  }
};

test("the NRL roster is the full 17-club competition, uniquely named", () => {
  assert.equal(NRL_TEAMS.length, 17);
  shape(NRL_TEAMS, "NRL_TEAMS");
});

test("the Super League roster is the full 13-club competition, uniquely named", () => {
  assert.equal(SUPER_LEAGUE_TEAMS.length, 13);
  shape(SUPER_LEAGUE_TEAMS, "SUPER_LEAGUE_TEAMS");
});

test("ALL_TEAMS tags every club with its league without dropping or merging any", () => {
  assert.equal(ALL_TEAMS.length, NRL_TEAMS.length + SUPER_LEAGUE_TEAMS.length);
  shape(ALL_TEAMS, "ALL_TEAMS");

  const byLeague = ALL_TEAMS.reduce((acc, t) => {
    acc[t.league] = (acc[t.league] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byLeague, { NRL: 17, "Super League": 13 });
});

test("ALL_TEAMS copies the source rosters instead of mutating them", () => {
  const nrlEntry = ALL_TEAMS.find((t) => t.name === "Brisbane Broncos");
  const source = NRL_TEAMS.find((t) => t.name === "Brisbane Broncos");
  assert.equal(nrlEntry.league, "NRL");
  assert.equal(source.league, undefined, "the picker must not write league back onto NRL_TEAMS");
  assert.notEqual(nrlEntry, source);
});

test("crests are left unset so TeamCrest renders a monogram", () => {
  for (const team of ALL_TEAMS) {
    assert.ok(!team.logo_url, `${team.name} must not ship a copyrighted crest URL`);
  }
});
