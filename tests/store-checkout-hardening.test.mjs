import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHECKOUT_REQUEST_ID_STORAGE_KEY,
  createCheckoutRequestId,
  getOrCreateCheckoutRequestId,
  isCheckoutRequestId,
  trustedCheckoutName,
} from "../src/lib/store-checkout.js";

test("checkout request IDs are valid and retained across retries", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const bytesCrypto = {
    getRandomValues(bytes) {
      bytes.fill(7);
      return bytes;
    },
  };
  const first = getOrCreateCheckoutRequestId(storage, bytesCrypto);
  const second = getOrCreateCheckoutRequestId(storage, { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
  assert.equal(first, second);
  assert.equal(values.get(CHECKOUT_REQUEST_ID_STORAGE_KEY), first);
  assert.equal(isCheckoutRequestId(first), true);
});

test("checkout request ID has a standards-shaped fallback for old WebViews", () => {
  assert.equal(isCheckoutRequestId(createCheckoutRequestId({})), true);
});

test("email-local placeholders are never prefilled as delivery names", () => {
  assert.equal(trustedCheckoutName({ email: "t_mace@hotmail.com", full_name: "t_mace" }), "");
  assert.equal(trustedCheckoutName({ email: "deneop24@gmail.com", full_name: "deneop24" }), "");
  assert.equal(trustedCheckoutName({ email: "review@example.com", full_name: "googleplayreview", username: "googleplayreview" }), "");
  assert.equal(trustedCheckoutName({ email: "t_mace@hotmail.com", full_name: "Tom Mace" }), "Tom Mace");
});

test("store keeps keyboard hardening while restoring signed AusPost PAC quotes", () => {
  const store = readFileSync(new URL("../src/pages/Store.jsx", import.meta.url), "utf8");
  const orders = readFileSync(new URL("../src/components/admin/OrdersManager.jsx", import.meta.url), "utf8");
  assert.ok(store.includes("window.visualViewport"));
  assert.ok(store.includes("scrollCheckoutFieldIntoView"));
  assert.ok(store.includes("getOrCreateCheckoutRequestId"));
  assert.ok(store.includes('functions.invoke("auspostRates"'));
  assert.ok(store.includes("Shipping (AusPost PAC · domestic AU)"));
  assert.ok(store.includes("selectedRate.signature"));
  assert.ok(store.includes("selectedRate.expires_at"));
  assert.ok(store.includes("Your full delivery address is collected securely in Stripe Checkout."));
  assert.ok(!orders.includes('functions.invoke("auspost'), "order management must not buy or quote postage");
});

test("store requires a fresh PAC selection only for physical shipped carts in calculated mode", () => {
  const store = readFileSync(new URL("../src/pages/Store.jsx", import.meta.url), "utf8");
  // Calculated (AusPost) mode still demands a fresh, selected quote…
  assert.ok(store.includes("!isFixedShipping && cartNeedsShipping && !isPickup && (ratesStale || !selectedRate)"));
  // …while fixed mode sends no client quote (server derives the flat rate).
  assert.ok(store.includes("shipping: !cartNeedsShipping || isPickup || isFixedShipping"));
  assert.ok(store.includes("? null"));
  assert.ok(store.includes("freeShippingThresholdAud(storeSettings)"));
  // Summary postage: fixed → flatShippingCents, calculated → the signed PAC quote.
  assert.ok(store.includes("flatShippingCents"));
  assert.ok(store.includes("selectedRate && !ratesStale ? toCents(selectedRate.price_aud) : 0"));
  // No hardcoded flat constant — the flat rate is admin-configurable and
  // recomputed server-side, not baked into the storefront.
  assert.ok(!store.includes("FLAT_AU_SHIPPING_AUD"));
  assert.ok(!store.includes("$15 flat-rate"));
});

test("fixed and PAC modes remain selectable while PAC services can be toggled independently", () => {
  const settings = readFileSync(new URL("../src/components/admin/SiteSettingsManager.jsx", import.meta.url), "utf8");
  const rates = readFileSync(new URL("../supabase/functions/auspostRates/index.ts", import.meta.url), "utf8");
  const checkout = readFileSync(new URL("../supabase/functions/createCheckout/index.ts", import.meta.url), "utf8");

  assert.ok(settings.includes('value="fixed"'));
  assert.ok(settings.includes('value="calculated"'));
  assert.ok(settings.includes("shipping_standard_enabled"));
  assert.ok(settings.includes("shipping_express_enabled"));
  assert.ok(settings.includes("Both PAC services are off"));
  assert.ok(rates.includes("shipping_standard_enabled"));
  assert.ok(rates.includes("shipping_express_enabled"));
  assert.ok(rates.includes("serviceEnabled"));
  assert.ok(checkout.includes("shippingServiceEnabled"));
  assert.ok(checkout.includes("is currently unavailable"));
  assert.ok(!settings.includes("Checkout charges $15 nationwide"));
});

test("PAC restoration preserves hardened checkout, promos and verified returns", () => {
  const store = readFileSync(new URL("../src/pages/Store.jsx", import.meta.url), "utf8");
  for (const token of [
    "trustedCheckoutName(user)",
    "scrollCheckoutFieldIntoView",
    "promoCode: appliedPromoIsCurrent ? appliedPromo.code",
    "checkoutRequestId",
    "checkoutStatus",
    "isVerifiedPaid",
    'localStorage.removeItem("rlt_cart")',
    'checkoutUrl.hostname !== "checkout.stripe.com"',
  ]) {
    assert.ok(store.includes(token), `Store must retain ${token}`);
  }
});

test("server checkout keeps legacy clients compatible but returns a session for native polling", () => {
  const checkout = readFileSync(new URL("../supabase/functions/createCheckout/index.ts", import.meta.url), "utf8");
  assert.ok(checkout.includes(": crypto.randomUUID()"));
  assert.ok(checkout.includes("checkout_request_id"));
  assert.ok(checkout.includes("idempotencyKey: `rlt_checkout_${checkoutRequestId}`"));
  assert.ok(checkout.includes("sessionId: session.id"));
  assert.ok(checkout.includes("product.coming_soon === true"));
  assert.ok(checkout.includes("variant.stock_quantity < item.quantity"));
});

test("shipped orders require structured address, carrier and tracking in UI and database", () => {
  const orders = readFileSync(new URL("../src/components/admin/OrdersManager.jsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/0021_store_checkout_and_fulfilment_hardening.sql", import.meta.url), "utf8");
  assert.ok(orders.includes("hasStructuredAddress"));
  assert.ok(orders.includes("Tracking details required"));
  assert.ok(migration.includes("A complete structured Australian shipping address is required before shipping"));
  assert.ok(migration.includes("Carrier and tracking number are required before shipping"));
});
