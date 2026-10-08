import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLegalContent } from "../src/lib/legal-content.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("legal content parser recognises standalone headings without blank lines", () => {
  assert.deepEqual(
    parseLegalContent("Opening line\n[Privacy]\nFirst line\nSecond line\n\n[Contact]\nEmail us"),
    [
      { type: "paragraph", text: "Opening line" },
      { type: "heading", text: "Privacy" },
      { type: "paragraph", text: "First line\nSecond line" },
      { type: "heading", text: "Contact" },
      { type: "paragraph", text: "Email us" },
    ],
  );
});

test("public legal fallbacks are substantive and contain no placeholder warning", () => {
  const privacy = read("src/pages/Privacy.jsx");
  const terms = read("src/pages/Terms.jsx");

  for (const [name, source] of [["privacy", privacy], ["terms", terms]]) {
    assert.ok(source.length > 3_000, `${name} fallback must be substantive`);
    assert.doesNotMatch(source, /placeholder content/i);
    assert.match(source, /support@rugbyleaguetakeover\.com/);
    assert.match(source, /Effective date: 28 July 2026/);
  }
  assert.match(privacy, /\[Retention and account deletion\]/);
  assert.match(privacy, /Supabase/);
  assert.match(privacy, /Stripe/);
  assert.match(terms, /Australian Consumer Law/);
  assert.match(terms, /fixed rate displayed in the cart/);
  assert.match(terms, /Australia Post service rate/);
  assert.match(terms, /no cash value/);
});

test("delete-account is a public route and is linked from account security", () => {
  const app = read("src/App.jsx");
  const security = read("src/components/account/SecurityTab.jsx");
  const page = read("src/pages/DeleteAccount.jsx");

  assert.match(app, /const DeleteAccount = lazy/);
  assert.match(app, /path="\/delete-account" element=\{<DeleteAccount \/>}/);
  assert.match(security, /to="\/delete-account"/);
  assert.match(page, /confirmation !== "DELETE"/);
  assert.match(page, /isAdmin/);
  assert.match(page, /functions\.invoke\("deleteAccount"/);
  assert.match(page, /Completed order and payment records may be retained/);
});

test("profile saves only real editable columns and makes notification delivery honest", () => {
  const profile = read("src/components/account/ProfileTab.jsx");
  assert.doesNotMatch(profile, /forum_mentions_opt_in/);
  assert.doesNotMatch(profile, /push_opt_in/);
  assert.doesNotMatch(profile, /PushNotificationToggle/);
  assert.match(profile, /in-app notification centre/);
  assert.doesNotMatch(profile, /Receive instant alerts/);
  assert.doesNotMatch(profile, /Browser Push Notifications/);
});

test("account deletion function authenticates, guards admins, and deletes auth last", () => {
  const source = read("supabase/functions/deleteAccount/index.ts");
  const authenticateAt = source.indexOf("svc.auth.getUser(token)");
  const cleanupAt = source.indexOf("svc.rpc('delete_account_data'");
  const deleteAuthAt = source.indexOf("svc.auth.admin.deleteUser");

  assert.ok(authenticateAt >= 0);
  assert.match(source, /confirmation !== 'DELETE'/);
  assert.match(source, /profile\.role === 'admin'/);
  assert.ok(cleanupAt > authenticateAt, "database cleanup follows authentication");
  assert.ok(deleteAuthAt > cleanupAt, "auth user is removed only after database cleanup");
  assert.equal(
    (source.match(/removeOwnedMedia\(userClient\)/g) || []).length,
    2,
    "owned objects are removed both before and after the profile is disabled",
  );
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(source, /svc\.storage\.from\('media'\)\.remove/);
});

test("account deletion migration is idempotent and cannot mass-match blank emails", () => {
  const sql = read("supabase/migrations/0020_account_deletion_and_push_preference.sql");
  assert.match(sql, /add column if not exists push_opt_in/);
  assert.match(sql, /drop policy if exists "media_auth_upload"/);
  assert.match(sql, /where auth_user_id = \(select auth\.uid\(\)\)[\s\S]*disabled = false/);
  assert.match(sql, /drop policy if exists "media_owner_read"/);
  assert.match(sql, /drop policy if exists "media_owner_delete"/);
  assert.match(sql, /owner_id = \(select auth\.uid\(\)::text\)/);
  assert.match(sql, /create or replace function public\.delete_account_data/);
  assert.match(sql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(sql, /v_email <> '' and lower\(coalesce\(user_email, ''\)\) = v_email/);
  assert.match(sql, /retained_order_count/);
  assert.match(sql, /update public\.store_orders[\s\S]*set user_id = null,[\s\S]*user_email = null/);
  assert.match(sql, /revoke all on function public\.delete_account_data\(uuid\) from public, anon, authenticated/);
});

test("account deletion clears community and server-owned progression fields", () => {
  const sql = read("supabase/migrations/0020_account_deletion_and_push_preference.sql");
  for (const table of [
    "product_release_subscriptions",
    "testimonials",
    "interest_registrations",
    "forum_reward_events",
    "achievement_unlocks",
    "notifications",
    "tipping_entries",
    "user_push_tokens",
  ]) {
    assert.match(sql, new RegExp(`delete from public\\.${table}`), `${table} must be cleaned`);
  }
  for (const field of [
    "casino_xp = 0",
    "casino_chips = 0",
    "slot_total_spins = 0",
    "slot_extra_count = 0",
    "daily_bonus_date = null",
    "disabled = true",
  ]) {
    assert.ok(sql.includes(field), `${field} must be reset`);
  }
});
