import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const migration = read("../supabase/migrations/0037_order_customer_phone.sql");
const webhook = read("../supabase/functions/stripeWebhook/index.ts");
const orders = read("../src/components/admin/OrdersManager.jsx");
const checkout = read("../supabase/functions/createCheckout/index.ts");

// Owner: "on the excel of all the purchases and shipment info can we add a
// telephone number please? Has address and all other details but no telephone."
// Stripe was already collecting the number; the webhook simply never stored it.

test("checkout really does collect a phone number", () => {
  // If this ever gets turned off, the whole feature silently goes empty.
  assert.match(checkout, /phone_number_collection:\s*\{\s*enabled:\s*true\s*\}/);
});

test("the order table has somewhere to put it", () => {
  assert.match(migration, /add column if not exists customer_phone text/);
});

test("the webhook stores the phone without risking the payment", () => {
  assert.match(webhook, /customer_details\?\.phone/);
  assert.match(webhook, /customer_phone: customerPhone/);
  // Must be written AFTER the payment RPC, and its failure must not throw —
  // a contact detail can never be allowed to fail a payment.
  const rpcAt = webhook.indexOf("process_store_order_payment");
  const phoneAt = webhook.indexOf("customer_phone: customerPhone");
  assert.ok(rpcAt > -1 && phoneAt > rpcAt, "phone is written after the payment RPC");
  const block = webhook.slice(phoneAt - 400, phoneAt + 400);
  assert.match(block, /console\.error\('customer_phone update failed/, "a failed phone write is logged, not thrown");
});

test("both order exports carry a phone column", () => {
  assert.match(orders, /"Date", "Order", "Customer", "Email", "Phone",/);
  assert.match(orders, /orderPhone\(o\)/);
  const exporter = read("../src/components/admin/DataExporter.jsx");
  assert.match(exporter, /key: "customer_phone", label: "Customer Phone"/);
});

test("the phone reads from a real column, not an invented one", () => {
  // shipping_phone / contact_phone do not exist on store_orders; referencing
  // them would have silently produced blanks forever.
  const helper = orders.split("function orderPhone")[1].split("}")[0];
  assert.match(helper, /order\.customer_phone/);
  assert.doesNotMatch(helper, /shipping_phone|contact_phone/);
});

test("older orders are backfilled, and a backfill never overwrites a real number", () => {
  // From our own data...
  assert.match(migration, /from public\.interest_registrations/);
  assert.match(migration, /from public\.profiles/);
  assert.match(migration, /coalesce\(o\.customer_phone, ''\) = ''/, "only fills blanks");
  // ...and from Stripe for the rest.
  const backfill = read("../supabase/functions/backfillOrderPhones/index.ts");
  assert.match(backfill, /me\.role !== 'admin'/, "admin only");
  assert.match(backfill, /checkout\.sessions\.retrieve/);
  assert.match(backfill, /customer_phone\.is\.null,customer_phone\.eq\./, "only targets orders with no phone");
});
