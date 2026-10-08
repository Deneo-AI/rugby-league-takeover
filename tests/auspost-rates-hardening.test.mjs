import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("AusPost rates reject unsafe requests and bound cart work", () => {
  const rates = read("supabase/functions/auspostRates/index.ts");

  assert.match(rates, /req\.method !== ['"]POST['"]/);
  assert.match(rates, /MAX_REQUEST_BYTES/);
  assert.match(rates, /MAX_CART_LINES/);
  assert.match(rates, /MAX_ITEM_QUANTITY/);
  assert.match(rates, /MAX_CART_UNITS/);
  assert.match(rates, /claim_checkout_attempt/);
  assert.match(rates, /\.in\(['"]id['"], productIds\)/);
  assert.match(rates, /AbortSignal\.timeout/);
  assert.match(rates, /Shipping rates are temporarily unavailable/);
});

test("PAC service switches are applied to quotes and rechecked at checkout", () => {
  const rates = read("supabase/functions/auspostRates/index.ts");
  const checkout = read("supabase/functions/createCheckout/index.ts");
  const settings = read("src/components/admin/SiteSettingsManager.jsx");
  const migration = read("supabase/migrations/0026_shipping_service_toggles.sql");

  for (const field of ["shipping_standard_enabled", "shipping_express_enabled"]) {
    assert.ok(rates.includes(field), `rates must read ${field}`);
    assert.ok(checkout.includes(field), `checkout must read ${field}`);
    assert.ok(settings.includes(field), `admin must edit ${field}`);
    assert.ok(migration.includes(field), `migration must add ${field}`);
  }

  assert.ok(rates.includes("serviceEnabled"));
  assert.ok(rates.includes("Australian delivery is temporarily unavailable"));
  assert.ok(checkout.includes("shippingServiceEnabled"));
  assert.ok(checkout.includes("is currently unavailable"));
  assert.match(settings, /Standard Post/);
  assert.match(settings, /Express Post/);
});
