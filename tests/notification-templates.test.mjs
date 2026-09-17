import test from "node:test";
import assert from "node:assert/strict";
import {
  orderShipped,
  orderDelivered,
  forumReply,
  forumMention,
  badgeEarned,
  travelUpdate,
  productDrop,
} from "../src/lib/notification-templates.js";

const USER = { id: "post-1", user_id: "u-1", user_email: "fan@example.com" };
const BRAND = "Rugby League Takeover";
const VALID_TYPES = ["reply", "mention", "system"];

// Every template feeds Notification.create(), so the recipient, the type enum
// and the deep link have to be present on every single shape.
const TEMPLATES = [
  ["orderShipped", orderShipped({ ...USER, tracking_number: "AU123" })],
  ["orderDelivered", orderDelivered(USER)],
  ["forumReply", forumReply(USER, { id: "r-1", body: "nice" }, "Sam B.")],
  ["forumMention", forumMention({ ...USER, title: "Vegas trip" }, "Sam B.")],
  ["badgeEarned", badgeEarned("u-1", "fan@example.com", "High Roller")],
  ["travelUpdate", travelUpdate(USER, "Flights confirmed")],
  ["productDrop", productDrop("u-1", "fan@example.com", { name: "Away Jersey" })],
];

test("every template produces a routable notification for the recipient", () => {
  for (const [name, notification] of TEMPLATES) {
    assert.equal(notification.recipient_id, "u-1", `${name} lost the recipient id`);
    assert.equal(notification.recipient_email, "fan@example.com", `${name} lost the recipient email`);
    assert.ok(VALID_TYPES.includes(notification.type), `${name} has invalid type ${notification.type}`);
    assert.ok(notification.title, `${name} has no title`);
    assert.ok(notification.preview, `${name} has no preview`);
    assert.ok(notification.link?.startsWith("/"), `${name} link must be an in-app route`);
    assert.ok(notification.actor_name, `${name} has no actor name`);
  }
});

test("order notifications show tracking when known and stay generic otherwise", () => {
  assert.equal(orderShipped({ ...USER, tracking_number: "AU123" }).preview, "Tracking: AU123");
  assert.equal(orderShipped(USER).preview, "Your order is on its way.");
  assert.equal(orderShipped(USER).actor_name, BRAND);

  const delivered = orderDelivered(USER);
  assert.equal(delivered.type, "system");
  assert.equal(delivered.link, "/account");
});

test("forum reply notifications are attributed and preview-truncated", () => {
  const long = "x".repeat(500);
  const reply = forumReply(USER, { id: "r-1", body: long }, "Sam B.");
  assert.equal(reply.type, "reply");
  assert.equal(reply.title, "Sam B. replied to your post");
  assert.equal(reply.actor_name, "Sam B.");
  assert.equal(reply.post_id, "post-1");
  assert.equal(reply.preview.length, 120, "preview must be clamped so the bell dropdown stays readable");

  // An empty body (media-only reply) still needs a human-readable preview.
  assert.equal(forumReply(USER, { id: "r-1" }, "Sam B.").preview, "New reply on your post");
});

test("mention notifications quote the thread title when there is one", () => {
  const withTitle = forumMention({ ...USER, title: "Vegas trip" }, "Sam B.");
  assert.equal(withTitle.type, "mention");
  assert.equal(withTitle.title, "Sam B. mentioned you");
  assert.equal(withTitle.preview, 'In "Vegas trip"');
  assert.equal(withTitle.post_id, "post-1");

  assert.equal(forumMention(USER, "Sam B.").preview, "You were mentioned in a post");
});

test("badge, travel and product templates name the thing that happened", () => {
  const badge = badgeEarned("u-1", "fan@example.com", "High Roller");
  assert.ok(badge.title.includes("High Roller"));
  assert.ok(badge.preview.includes("High Roller"));
  assert.equal(badge.link, "/account");

  const travel = travelUpdate(USER, "y".repeat(200));
  assert.equal(travel.preview.length, 120, "travel updates are clamped like replies");

  const drop = productDrop("u-1", "fan@example.com", { name: "Away Jersey" });
  assert.ok(drop.title.includes("Away Jersey"));
  assert.equal(drop.link, "/store", "product drops must land on the store, not the account page");
});
