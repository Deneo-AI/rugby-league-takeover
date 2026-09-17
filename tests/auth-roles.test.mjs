import test from "node:test";
import assert from "node:assert/strict";

import { hasAdminRole, hasModeratorRole } from "../src/lib/auth-roles.js";

test("detects admin users across common role shapes", () => {
  assert.equal(hasAdminRole({ role: "admin" }), true);
  assert.equal(hasAdminRole({ role: "Admin" }), true);
  assert.equal(hasAdminRole({ roles: ["member", "admin"] }), true);
  assert.equal(hasAdminRole({ is_admin: true }), true);
});

test("does not grant admin access to non-admin users", () => {
  assert.equal(hasAdminRole({ role: "user" }), false);
  assert.equal(hasAdminRole({ roles: ["member"] }), false);
  assert.equal(hasAdminRole({}), false);
  assert.equal(hasAdminRole(null), false);
});

test("admin detection also reads camelCase, app_role and permissions", () => {
  assert.equal(hasAdminRole({ isAdmin: true }), true);
  assert.equal(hasAdminRole({ app_role: "  ADMIN  " }), true, "role values are trimmed and case-folded");
  assert.equal(hasAdminRole({ permissions: ["read", "admin"] }), true);
  assert.equal(hasAdminRole({ is_admin: "true" }), false, "only a real boolean grants the flag shortcut");
  assert.equal(hasAdminRole({ roles: "admin" }), false, "a non-array roles field is ignored");
  assert.equal(hasAdminRole({ role: null, roles: null, permissions: null }), false);
});

test("moderators are detected across the same role shapes", () => {
  assert.equal(hasModeratorRole({ role: "moderator" }), true);
  assert.equal(hasModeratorRole({ app_role: "Moderator" }), true);
  assert.equal(hasModeratorRole({ roles: ["member", "moderator"] }), true);
  assert.equal(hasModeratorRole({ permissions: ["moderator"] }), true);
});

test("admins inherit moderator powers, plain members get neither", () => {
  assert.equal(hasModeratorRole({ role: "admin" }), true);
  assert.equal(hasModeratorRole({ is_admin: true }), true);
  assert.equal(hasModeratorRole({ role: "member" }), false);
  assert.equal(hasModeratorRole({}), false);
  assert.equal(hasModeratorRole(null), false);
});

test("moderator status never implies admin status", () => {
  assert.equal(hasAdminRole({ role: "moderator" }), false);
  assert.equal(hasAdminRole({ roles: ["moderator"] }), false);
});
