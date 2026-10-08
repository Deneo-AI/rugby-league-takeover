// Creates an idempotent Stripe-hosted Checkout Session from authoritative
// product/settings data and a signed PAC/AusPost quote. Client product prices,
// stock, tax, fees, discounts and unsigned shipping totals are ignored.
import Stripe from 'npm:stripe@22.2.0';
import {
  getCaller,
  getStripeSecretKey,
  isEmail,
  resolveClientIp,
  serviceClient,
} from './shared.ts';

const MAX_CHECKOUT_QUANTITY = 20;
const MAX_CHECKOUT_LINE_ITEMS = 20;
const MAX_REQUEST_BYTES = 16_384;
const MAX_ORDER_TOTAL_AUD = 50_000;
const CHECKOUT_CURRENCY = 'aud';
const DEFAULT_CHECKOUT_ORIGIN = 'https://www.rugbyleaguetakeover.com';
const DEFAULT_FREE_DOMESTIC_SHIPPING_THRESHOLD_CENTS = 15_000;
const CHECKOUT_SESSION_SECONDS = 30 * 60;
const CHECKOUT_RATE_WINDOW_SECONDS = 10 * 60;
const CHECKOUT_RATE_LIMIT = 8;

const trim = (value: unknown, max = 10_000) => String(value ?? '').trim().slice(0, max);
const toCents = (value: unknown) => Math.round(Number(value || 0) * 100);
const fromCents = (value: number) => Number((value / 100).toFixed(2));
const isUuid = (value: unknown) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const normalizePromoCode = (value: unknown) => trim(value, 32).toUpperCase();
const validPromoCode = (value: string) => /^[A-Z0-9][A-Z0-9-]{1,31}$/.test(value);

const parseOrigin = (value: unknown) => {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:', 'capacitor:', 'ionic:'].includes(url.protocol)) return '';
    return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    return '';
  }
};
const isRltPreview = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:'
      && url.hostname.startsWith('rugby-league-takeover-')
      && url.hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
};
const allowedOrigins = () => new Set([
  DEFAULT_CHECKOUT_ORIGIN,
  'https://rugbyleaguetakeover.com',
  'capacitor://localhost',
  'ionic://localhost',
  ...String(Deno.env.get('CHECKOUT_ALLOWED_ORIGINS') || '').split(',').map(parseOrigin).filter(Boolean),
]);
const originAllowed = (origin: string) => Boolean(origin && (allowedOrigins().has(origin) || isRltPreview(origin)));
const requestOriginAllowed = (req: Request) => !req.headers.get('origin') || originAllowed(parseOrigin(req.headers.get('origin')));
const corsHeaders = (req: Request) => {
  const origin = parseOrigin(req.headers.get('origin'));
  return {
    'Access-Control-Allow-Origin': originAllowed(origin) ? origin : DEFAULT_CHECKOUT_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
};
const responseJson = (req: Request, data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req), ...extra },
  });

async function readJsonBody(req: Request) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
  const raw = await req.text();
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new Error(raw ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('INVALID_JSON');
  }
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// deno-lint-ignore no-explicit-any
function normalizeSizeVariants(raw: any) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((entry) => {
    const size = trim(typeof entry === 'string' ? entry : entry?.size, 20);
    const key = size.toLowerCase();
    if (!size || seen.has(key)) return [];
    seen.add(key);
    const stock = Number(typeof entry === 'string' ? 0 : entry?.stock_quantity);
    return [{ size, stock_quantity: Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0 }];
  });
}
// deno-lint-ignore no-explicit-any
function normalizeItems(raw: any) {
  if (!Array.isArray(raw) || raw.length > MAX_CHECKOUT_LINE_ITEMS * 2) return [];
  const items = new Map<string, { productId: string; size: string; quantity: number }>();
  for (const input of raw) {
    const productId = trim(input?.productId, 128);
    const quantity = Number(input?.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
    const size = trim(input?.size, 20);
    const key = `${productId}::${size.toLowerCase()}`;
    const current = items.get(key) || { productId, size, quantity: 0 };
    current.quantity = Math.min(current.quantity + quantity, MAX_CHECKOUT_QUANTITY);
    items.set(key, current);
    if (items.size > MAX_CHECKOUT_LINE_ITEMS) return [];
  }
  return [...items.values()];
}
// deno-lint-ignore no-explicit-any
function buildProductLines(items: any[], productsById: Map<string, any>) {
  const orderLines = [];
  const stripeLines: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const totalsByProduct = new Map<string, number>();
  for (const item of items) {
    totalsByProduct.set(item.productId, (totalsByProduct.get(item.productId) || 0) + item.quantity);
  }

  for (const item of items) {
    const product = productsById.get(item.productId);
    if (!product || product.is_active === false || product.coming_soon === true) {
      return { error: 'An item in your cart is no longer available.', status: 409 };
    }
    const unitCents = toCents(product.price_aud);
    if (!Number.isSafeInteger(unitCents) || unitCents <= 0) {
      return { error: 'An item in your cart cannot be purchased right now.', status: 409 };
    }
    const totalStock = Number(product.stock_quantity);
    const requestedTotal = totalsByProduct.get(item.productId) || item.quantity;
    if (Number.isFinite(totalStock) && Math.max(0, Math.floor(totalStock)) < requestedTotal) {
      return { error: `Not enough stock for ${trim(product.name, 120) || 'an item'}.`, status: 409 };
    }

    const variants = normalizeSizeVariants(product.sizes);
    let canonicalSize = '';
    if (variants.length) {
      const variant = variants.find((entry) => entry.size.toLowerCase() === item.size.toLowerCase());
      if (!item.size || !variant) return { error: `Please select an available size for ${trim(product.name, 120)}.`, status: 409 };
      if (variant.stock_quantity < item.quantity) return { error: `Not enough stock for ${trim(product.name, 120)} in size ${variant.size}.`, status: 409 };
      canonicalSize = variant.size;
    } else if (item.size) {
      return { error: `${trim(product.name, 120)} does not use size options.`, status: 409 };
    }

    const name = trim(product.name, 120);
    let image: string | undefined;
    try {
      const url = new URL(String(product.image_url || ''));
      if (url.protocol === 'https:') image = url.toString();
    } catch { /* no safe image */ }
    orderLines.push({
      product_id: product.id,
      name,
      size: canonicalSize,
      quantity: item.quantity,
      price_aud: fromCents(unitCents),
    });
    stripeLines.push({
      quantity: item.quantity,
      price_data: {
        currency: CHECKOUT_CURRENCY,
        unit_amount: unitCents,
        product_data: {
          name: canonicalSize ? `${name} — Size ${canonicalSize}` : name,
          description: trim(product.description, 500) || undefined,
          images: image ? [image] : undefined,
        },
      },
    });
  }
  return { orderLines, stripeLines };
}

const clampPercent = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
};
// deno-lint-ignore no-explicit-any
function calculateTotals(goods: number, shipping: number, settings: any) {
  const gstEnabled = settings?.gst_enabled !== false;
  const gstRate = clampPercent(settings?.gst_rate_percent, 6.5);
  const gstIncluded = settings?.gst_mode === 'absorbed';
  const taxable = goods + shipping;
  const gst = !gstEnabled || gstRate <= 0
    ? 0
    : gstIncluded
      ? Math.round(taxable * gstRate / (100 + gstRate))
      : Math.round(taxable * gstRate / 100);
  const afterTax = taxable + (gstIncluded ? 0 : gst);

  const cardEnabled = settings?.card_fee_enabled === true;
  const cardPercent = clampPercent(settings?.card_fee_percent, 1.75);
  const fixed = Math.max(0, toCents(settings?.card_fee_fixed_aud ?? 0.3));
  const cardIncluded = settings?.card_fee_mode !== 'added';
  let card = 0;
  if (cardEnabled && afterTax > 0) {
    if (cardIncluded) card = Math.round(afterTax * cardPercent / 100) + fixed;
    else {
      const rate = cardPercent / 100;
      card = rate < 1 ? Math.max(0, Math.round((afterTax + fixed) / (1 - rate)) - afterTax) : 0;
    }
  }
  return {
    goods,
    shipping,
    gst,
    gstRate,
    gstIncluded,
    gstLabel: trim(settings?.gst_label || 'GST', 80),
    card,
    cardIncluded,
    cardLabel: trim(settings?.card_fee_label || 'Card processing fee', 80),
    total: afterTax + (cardIncluded ? 0 : card),
  };
}

// PAC quotes are signed by auspostRates over the service, price, postcode,
// normalized cart and expiry. Checkout verifies that exact payload before
// trusting the quoted amount, then independently applies any free-postage rule.
// deno-lint-ignore no-explicit-any
function cartFingerprint(items: any[]) {
  return (items || [])
    .map((item) => `${trim(item?.productId ?? item?.product_id, 128)}:${Math.max(1, Math.floor(Number(item?.quantity) || 1))}`)
    .filter((entry) => !entry.startsWith(':'))
    .sort()
    .join(',');
}

function quotePayload(code: string, priceCents: number, postcode: string, cartHash: string, expiresAt: number) {
  return [code, priceCents, postcode, cartHash, expiresAt].join('|');
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyQuoteSignature(payload: string, rawSignature: unknown) {
  const secret = Deno.env.get('SHIPPING_QUOTE_SECRET');
  const signature = trim(rawSignature, 128).toLowerCase();
  if (!secret || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signature);
}

type ShippingSelection = {
  code: string;
  name: string;
  postcode: string;
  priceCents: number;
  expiresAt: number;
  signature: string;
};

function canonicalShippingServiceName(code: string) {
  const normalized = code.toUpperCase();
  if (normalized === 'AUS_PARCEL_REGULAR') return 'Parcel Post';
  if (normalized === 'AUS_PARCEL_EXPRESS') return 'Express Post';
  if (normalized.startsWith('AUS_PARCEL_REGULAR_')) return 'Parcel Post';
  if (normalized.startsWith('AUS_PARCEL_EXPRESS_')) return 'Express Post';
  // The quote signature authenticates the code but not PAC's display name.
  // Unknown future PAC service codes remain usable without persisting a
  // shopper-controlled label into Stripe or the fulfilment dashboard.
  return 'AusPost delivery';
}

// deno-lint-ignore no-explicit-any
function normalizeShippingSelection(raw: any): ShippingSelection | null {
  const code = trim(raw?.code, 100);
  const name = canonicalShippingServiceName(code);
  const postcode = trim(raw?.postcode, 4);
  const price = Number(raw?.price_aud);
  const priceCents = Math.round(price * 100);
  const expiresAt = Number(raw?.expires_at);
  const signature = trim(raw?.signature, 128).toLowerCase();
  if (
    !code
    || !/^\d{4}$/.test(postcode)
    || !Number.isFinite(price)
    || !Number.isSafeInteger(priceCents)
    || priceCents < 0
    || priceCents > 100_000
    || !Number.isSafeInteger(expiresAt)
    || !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return null;
  }
  return {
    code,
    name,
    postcode,
    priceCents,
    expiresAt,
    signature,
  };
}

const PARCEL_RANK: Record<string, number> = { satchel: 0, small: 1, medium: 2, large: 3 };
const DEFAULT_PARCEL_SIZE = 'satchel';
const PARCEL_SIZE_WORDS: [string, string][] = [
  ['extra large', 'large'],
  ['extralarge', 'large'],
  ['large', 'large'],
  ['medium', 'medium'],
  ['small', 'small'],
  ['satchel', 'satchel'],
];
const normalizeParcelSize = (value: unknown) => {
  const size = trim(value, 20).toLowerCase();
  return size in PARCEL_RANK ? size : DEFAULT_PARCEL_SIZE;
};
function serviceParcelSize(service: Pick<ShippingSelection, 'code' | 'name'>): string | null {
  const searchable = `${service.code} ${service.name}`.toLowerCase();
  for (const [word, size] of PARCEL_SIZE_WORDS) {
    if (searchable.includes(word)) return size;
  }
  return null;
}
function freeShippingThresholdCents(settings: any) {
  const threshold = Number(settings?.free_shipping_threshold_aud);
  return Number.isFinite(threshold) && threshold >= 0
    ? toCents(threshold)
    : DEFAULT_FREE_DOMESTIC_SHIPPING_THRESHOLD_CENTS;
}

// ── Fixed (flat-rate) shipping ──────────────────────────────────────────────
// Mirror of shippingModeSettings/computeFlatShippingCents in
// src/lib/money-rules.js — keep the two in sync. In fixed mode there is no
// signed AusPost quote; postage is derived here from the saved products and
// settings, never from anything the client sends.
// deno-lint-ignore no-explicit-any
function shippingModeOf(settings: any) {
  return settings?.shipping_mode === 'fixed' ? 'fixed' : 'calculated';
}
function shippingServiceEnabled(selection: ShippingSelection, settings: any) {
  const express = /EXPRESS/i.test(selection.code);
  return express
    ? settings?.shipping_express_enabled !== false
    : settings?.shipping_standard_enabled !== false;
}
const FLAT_RATE_CAP_AUD = 1000; // guardrail against a fat-fingered postage value
function clampFlatRateCents(value: unknown, fallbackAud: number) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= FLAT_RATE_CAP_AUD ? toCents(n) : toCents(fallbackAud);
}
// Per-product override shares the store rate's [0, $1000] ceiling. 0 = none.
function clampOverrideCents(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(toCents(n), toCents(FLAT_RATE_CAP_AUD)) : 0;
}
// deno-lint-ignore no-explicit-any
function productShipsUnderMode(product: any, mode: string) {
  if (product?.shipping_required !== false) return true;
  if (mode === 'fixed') {
    const override = Number(product?.flat_shipping_aud);
    return Number.isFinite(override) && override > 0;
  }
  return false;
}
// deno-lint-ignore no-explicit-any
function computeFixedShippingCents(items: any[], productsById: Map<string, any>, settings: any) {
  const single = clampFlatRateCents(settings?.shipping_flat_single_aud, 12.5);
  const multi = clampFlatRateCents(settings?.shipping_flat_multi_aud, 15.9);
  let units = 0;
  let overrideMaxCents = 0;
  for (const item of items || []) {
    const product = productsById.get(trim(item?.productId ?? item?.product_id, 128));
    if (!product) continue;
    const qty = Math.max(0, Math.floor(Number(item?.quantity) || 0));
    if (qty <= 0) continue;
    const overrideCents = clampOverrideCents(product.flat_shipping_aud);
    if (product.shipping_required === false && overrideCents <= 0) continue;
    units += qty;
    if (overrideCents > 0) overrideMaxCents = Math.max(overrideMaxCents, overrideCents);
  }
  if (units <= 0) return 0;
  return Math.max(units >= 2 ? multi : single, overrideMaxCents);
}

// deno-lint-ignore no-explicit-any
function resolveFulfilment(
  method: unknown,
  country: unknown,
  settings: any,
  requiresShipping: boolean,
  rawShipping: unknown,
  shippingMode: string,
) {
  if (!requiresShipping) return { method: 'none', label: 'No shipping required', shipping: null };
  const choice = trim(method, 16).toLowerCase() || 'shipping';
  const australian = ['AU', 'AUS', 'AUSTRALIA'].includes(trim(country, 32).toUpperCase());
  const pickupEnabled = settings?.pickup_enabled === true;
  const pickupAudience = trim(settings?.pickup_audience || 'international', 20).toLowerCase();
  if (choice === 'pickup') {
    // AusPost is domestic-only, so collection is the ONLY route for an overseas
    // buyer — it can never be switched off for them, or they cannot order at
    // all. The admin toggle governs Australian customers only: whether they may
    // also collect instead of paying postage.
    if (australian && !(pickupEnabled && pickupAudience === 'everyone')) {
      return { error: 'Collection is for international orders only — please choose shipping.' };
    }
    return { method: 'pickup', label: trim(settings?.pickup_label || 'Collect in Las Vegas', 120), shipping: null };
  }
  if (choice !== 'shipping') return { error: "Choose how you'd like to receive your order." };
  if (country && !australian) {
    return { error: 'We only ship within Australia — choose collection in Las Vegas instead.' };
  }
  // Fixed mode: no AusPost quote to verify — postage is computed server-side
  // from the cart. Stripe still collects the delivery address.
  if (shippingMode === 'fixed') {
    return { method: 'shipping', label: 'Standard shipping', shipping: null };
  }
  const shipping = normalizeShippingSelection(rawShipping);
  if (!shipping) {
    return { error: 'A current AusPost shipping quote is required — please calculate shipping again.' };
  }
  return { method: 'shipping', label: shipping.name, shipping };
}

// deno-lint-ignore no-explicit-any
function couponIdFor(promotion: any) {
  const current = promotion?.promotion?.coupon;
  if (typeof current === 'string') return current;
  if (current?.id) return current.id;
  const legacy = promotion?.coupon;
  return typeof legacy === 'string' ? legacy : legacy?.id || '';
}
// deno-lint-ignore no-explicit-any
async function resolvePromotion(stripe: Stripe, rawCode: unknown, eligibleSubtotal: number) {
  const code = normalizePromoCode(rawCode);
  if (!code) return { code: '', id: '', discount: 0 };
  if (!validPromoCode(code)) return { error: 'Enter a valid promo code.' };
  const promotion = (await stripe.promotionCodes.list({ code, active: true, limit: 1 })).data[0];
  const couponId = couponIdFor(promotion);
  if (!promotion || !couponId) return { error: 'That promo code is not valid.' };
  const coupon = await stripe.coupons.retrieve(couponId);
  const now = Math.floor(Date.now() / 1000);
  const minimum = Number(promotion.restrictions?.currency_options?.aud?.minimum_amount
    ?? promotion.restrictions?.minimum_amount ?? 0);
  if (!promotion.active || coupon.valid === false || (promotion.expires_at && promotion.expires_at <= now)
    || (promotion.max_redemptions && Number(promotion.times_redeemed || 0) >= promotion.max_redemptions)) {
    return { error: 'That promo code is no longer available.' };
  }
  if (minimum > eligibleSubtotal) return { error: `Spend at least $${(minimum / 100).toFixed(2)} AUD to use this code.` };
  if (coupon.amount_off && String(coupon.currency || '').toLowerCase() !== CHECKOUT_CURRENCY) return { error: 'That promo code is not available for AUD orders.' };
  const discount = Number(coupon.amount_off) > 0
    ? Math.min(eligibleSubtotal, Number(coupon.amount_off))
    : Math.min(eligibleSubtotal, Math.round(eligibleSubtotal * Number(coupon.percent_off || 0) / 100));
  return discount > 0
    ? { code: promotion.code || code, id: promotion.id, discount }
    : { error: 'That promo code has no available discount.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return requestOriginAllowed(req)
      ? new Response(null, { status: 204, headers: corsHeaders(req) })
      : responseJson(req, { error: 'Origin is not allowed.' }, 403);
  }
  if (req.method !== 'POST') return responseJson(req, { error: 'Method not allowed.' }, 405, { Allow: 'POST, OPTIONS' });
  if (!requestOriginAllowed(req)) return responseJson(req, { error: 'Origin is not allowed.' }, 403);

  let input;
  try {
    input = await readJsonBody(req);
  } catch (error) {
    const tooLarge = (error as Error).message === 'REQUEST_TOO_LARGE';
    return responseJson(req, { error: tooLarge ? 'Checkout request is too large.' : 'Invalid checkout request.' }, tooLarge ? 413 : 400);
  }

  const items = normalizeItems(input?.items);
  const svc = serviceClient();
  const user = await getCaller(req, svc);
  const customerName = trim(input?.customerName, 120);
  const customerEmail = trim(input?.customerEmail || user?.email, 254).toLowerCase();
  // New clients retain this UUID across retries. The server fallback keeps
  // already-published clients compatible while the native update rolls out.
  const checkoutRequestId = isUuid(input?.checkoutRequestId)
    ? String(input.checkoutRequestId).toLowerCase()
    : crypto.randomUUID();

  if (!items.length) return responseJson(req, { error: 'Your cart contains invalid or too many items.' }, 400);
  if (customerName.length < 2) return responseJson(req, { error: 'Please enter your full name.' }, 400);
  if (!isEmail(customerEmail)) return responseJson(req, { error: 'Please enter a valid receipt email.' }, 400);

  try {
    const ip = resolveClientIp(req);
    for (const claim of [
      { value: `email|${customerEmail}`, limit: CHECKOUT_RATE_LIMIT },
      ...(ip ? [{ value: `ip|${ip}`, limit: 20 }] : []),
    ]) {
      const { data, error } = await svc.rpc('claim_checkout_attempt', {
        p_key_hash: await sha256(claim.value),
        p_limit: claim.limit,
        p_window_seconds: CHECKOUT_RATE_WINDOW_SECONDS,
      }).single();
      if (error) throw error;
      const throttle = data as { allowed?: boolean; retry_after_seconds?: number } | null;
      if (!throttle?.allowed) {
        const retryAfter = Math.max(1, Number(throttle?.retry_after_seconds || CHECKOUT_RATE_WINDOW_SECONDS));
        return responseJson(req, { error: 'Too many checkout attempts. Please wait a few minutes and try again.', retryAfter }, 429, { 'Retry-After': String(retryAfter) });
      }
    }

    const productIds = [...new Set(items.map((item) => item.productId))];
    const { data: products, error: productsError } = await svc.from('products').select('*').in('id', productIds);
    if (productsError) throw productsError;
    const productsById = new Map((products || []).map((product) => [product.id, product]));
    const missing = productIds.filter((id) => !productsById.has(id));
    if (missing.length) return responseJson(req, {
      error: 'Some items in your cart are no longer available. Please review your cart.',
      unavailableProductIds: missing,
    }, 409);

    const lines = buildProductLines(items, productsById);
    if ('error' in lines) return responseJson(req, { error: lines.error }, lines.status);
    const merchandiseSubtotal = lines.orderLines.reduce(
      (sum, item) => sum + toCents(item.price_aud) * Number(item.quantity || 0),
      0,
    );
    const { data: settings, error: settingsError } = await svc
      .from('site_settings')
      .select('pickup_enabled,pickup_audience,pickup_label,pickup_instructions,gst_enabled,gst_rate_percent,gst_mode,gst_label,card_fee_enabled,card_fee_percent,card_fee_fixed_aud,card_fee_mode,card_fee_label,free_shipping_threshold_aud,shipping_mode,shipping_flat_single_aud,shipping_flat_multi_aud,shipping_standard_enabled,shipping_express_enabled')
      .order('updated_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (settingsError) throw settingsError;
    const shippingMode = shippingModeOf(settings || {});
    const requiresShipping = [...productsById.values()].some((product) => productShipsUnderMode(product, shippingMode));
    const fulfilment = resolveFulfilment(
      input?.fulfilment,
      input?.country,
      settings || {},
      requiresShipping,
      input?.shipping,
      shippingMode,
    );
    if ('error' in fulfilment) return responseJson(req, { error: fulfilment.error }, 400);
    if (
      shippingMode === 'calculated'
      && fulfilment.method === 'shipping'
      && fulfilment.shipping
      && !shippingServiceEnabled(fulfilment.shipping, settings || {})
    ) {
      const disabledService = /EXPRESS/i.test(fulfilment.shipping.code) ? 'Express Post' : 'Standard Post';
      return responseJson(req, {
        error: `${disabledService} is currently unavailable — please calculate shipping again.`,
      }, 400);
    }

    // Re-derive the maximum parcel size from the saved products. The storefront
    // filters oversized PAC services too, but a crafted client must not be able
    // to send a signed Large-box quote for a satchel-sized order.
    if (fulfilment.method === 'shipping' && fulfilment.shipping) {
      let requiredSize = DEFAULT_PARCEL_SIZE;
      for (const product of productsById.values()) {
        if (product.shipping_required === false) continue;
        const productSize = normalizeParcelSize(product.parcel_size);
        if (PARCEL_RANK[productSize] > PARCEL_RANK[requiredSize]) requiredSize = productSize;
      }
      const selectedSize = serviceParcelSize(fulfilment.shipping);
      if (selectedSize !== null && PARCEL_RANK[selectedSize] > PARCEL_RANK[requiredSize]) {
        return responseJson(req, {
          error: 'That shipping option is too large for this order — please calculate shipping again.',
        }, 400);
      }
    }

    let quotedShippingCents = 0;
    if (fulfilment.method === 'shipping' && fulfilment.shipping) {
      const quote = fulfilment.shipping;
      const payload = quotePayload(
        quote.code,
        quote.priceCents,
        quote.postcode,
        cartFingerprint(items),
        quote.expiresAt,
      );
      const signatureValid = await verifyQuoteSignature(payload, quote.signature);
      if (!signatureValid) {
        return responseJson(req, {
          error: 'Shipping quote could not be verified — please calculate shipping again.',
        }, 400);
      }
      if (Date.now() > quote.expiresAt) {
        return responseJson(req, {
          error: 'That shipping quote has expired — please calculate shipping again.',
        }, 400);
      }
      quotedShippingCents = quote.priceCents;
    } else if (fulfilment.method === 'shipping' && shippingMode === 'fixed') {
      // No signed quote in fixed mode — compute the flat rate from the cart.
      quotedShippingCents = computeFixedShippingCents(items, productsById, settings || {});
    }
    const shippingCents = fulfilment.method === 'shipping'
      && merchandiseSubtotal < freeShippingThresholdCents(settings || {})
      ? quotedShippingCents
      : 0;
    const totals = calculateTotals(merchandiseSubtotal, shippingCents, settings || {});
    const stripe = new Stripe(getStripeSecretKey());
    const promotion = await resolvePromotion(stripe, input?.promoCode, totals.total - shippingCents);
    if ('error' in promotion) return responseJson(req, { error: promotion.error, promoCodeInvalid: true }, 400);
    const provisionalTotal = totals.total - promotion.discount;
    if (provisionalTotal < 50 || provisionalTotal > MAX_ORDER_TOTAL_AUD * 100) {
      return responseJson(req, {
        error: promotion.id
          ? 'This promo code would reduce the order below Stripe’s minimum checkout amount.'
          : 'The cart total is outside the supported checkout range.',
        ...(promotion.id ? { promoCodeInvalid: true } : {}),
      }, 400);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_SECONDS;
    const shippingSelection = fulfilment.method === 'shipping' ? fulfilment.shipping : null;
    const shippingCode = shippingSelection?.code
      || (fulfilment.method === 'pickup' ? 'PICKUP' : fulfilment.method === 'shipping' ? 'FLAT' : 'NONE');
    const shippingName = shippingSelection?.name || fulfilment.label;
    const customerPostcode = shippingSelection?.postcode || '';
    const { data: existing, error: existingError } = await svc
      .from('store_orders').select('*').eq('checkout_request_id', checkoutRequestId).maybeSingle();
    if (existingError) throw existingError;
    let order = existing;
    if (order) {
      const same = order.customer_email === customerEmail
        && order.customer_name === customerName
        && order.fulfilment_method === fulfilment.method
        && String(order.customer_postcode || '') === customerPostcode
        && String(order.shipping_service_code || '') === shippingCode
        && Number(order.shipping_cost_aud || 0) === fromCents(shippingCents)
        && Number(order.merchandise_subtotal_aud) === fromCents(merchandiseSubtotal)
        && String(order.promo_code || '') === String(promotion.code || '')
        && JSON.stringify(order.line_items || []) === JSON.stringify(lines.orderLines);
      if (!same || order.status !== 'pending') {
        return responseJson(req, {
          error: 'This checkout request has already been used. Please try again.',
          checkoutRequestInvalid: true,
        }, 409);
      }
      if (order.stripe_session_id) {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        if (session.status === 'open' && session.url) {
          return responseJson(req, { url: session.url, sessionId: session.id, expiresAt: session.expires_at, reused: true });
        }
        return responseJson(req, {
          error: 'This checkout session is no longer available. Please try again.',
          checkoutRequestInvalid: true,
        }, 409);
      }
    } else {
      const { data: created, error } = await svc.from('store_orders').insert({
        id: crypto.randomUUID(),
        checkout_request_id: checkoutRequestId,
        checkout_expires_at: new Date(expiresAt * 1000).toISOString(),
        customer_name: customerName,
        customer_email: customerEmail,
        status: 'pending',
        total_aud: fromCents(provisionalTotal),
        merchandise_subtotal_aud: fromCents(merchandiseSubtotal),
        subtotal_aud: fromCents(merchandiseSubtotal),
        discount_amount_aud: fromCents(promotion.discount),
        promo_code: promotion.code || null,
        stripe_promotion_code_id: promotion.id || null,
        line_items: lines.orderLines,
        user_email: user?.email || customerEmail,
        user_id: user?.id || null,
        customer_postcode: customerPostcode,
        shipping_service_code: shippingCode,
        shipping_service_name: shippingName,
        shipping_cost_aud: fromCents(shippingCents),
        fulfilment_method: fulfilment.method,
        gst_amount_aud: fromCents(totals.gst),
        gst_rate_percent: totals.gstRate,
        gst_included: totals.gstIncluded,
        card_fee_aud: fromCents(totals.card),
        card_fee_included: totals.cardIncluded,
        ...(fulfilment.method === 'pickup' ? {
          shipping_address: settings?.pickup_instructions || settings?.pickup_label || 'Collect in Las Vegas at the event',
          customer_status_note: 'Collect in Las Vegas at the event — bring your order number and ID.',
        } : { customer_status_note: 'Awaiting secure payment through Stripe.' }),
        timeline: [{ action: 'checkout_started', timestamp: new Date().toISOString(), note: 'Stripe Checkout session requested', actor: 'system' }],
      }).select('*').single();
      if (error) throw error;
      order = created;
    }

    const stripeLines: Stripe.Checkout.SessionCreateParams.LineItem[] = [...lines.stripeLines];
    if (!totals.gstIncluded && totals.gst > 0) stripeLines.push({
      quantity: 1,
      price_data: {
        currency: CHECKOUT_CURRENCY,
        unit_amount: totals.gst,
        product_data: { name: `${totals.gstLabel} (${totals.gstRate}%)` },
      },
    });
    if (!totals.cardIncluded && totals.card > 0) stripeLines.push({
      quantity: 1,
      price_data: {
        currency: CHECKOUT_CURRENCY,
        unit_amount: totals.card,
        product_data: { name: totals.cardLabel },
      },
    });
    const metadata = {
      rlt_app_id: trim(Deno.env.get('RLT_APP_ID') || 'rugby-league-takeover', 40),
      order_id: order.id,
      checkout_request_id: checkoutRequestId,
      expected_total_aud: fromCents(provisionalTotal).toFixed(2),
      promo_code: promotion.code || '',
      fulfilment_method: fulfilment.method,
    };
    const origin = (() => {
      const requested = parseOrigin(req.headers.get('origin'));
      if (requested.startsWith('http') && originAllowed(requested)) return requested;
      return parseOrigin(Deno.env.get('CHECKOUT_DEFAULT_ORIGIN') || DEFAULT_CHECKOUT_ORIGIN) || DEFAULT_CHECKOUT_ORIGIN;
    })();

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: order.id,
        customer_email: customerEmail,
        success_url: `${origin}/store?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/store?checkout=cancelled`,
        expires_at: expiresAt,
        line_items: stripeLines,
        ...(fulfilment.method === 'shipping' ? {
          shipping_address_collection: { allowed_countries: ['AU'] },
          shipping_options: [{
            shipping_rate_data: {
              type: 'fixed_amount',
              // AusPost quotes carry the carrier name; fixed rates don't.
              display_name: (() => {
                const suffix = shippingMode === 'fixed' ? '' : ' (AusPost)';
                return shippingCents > 0
                  ? `${shippingName}${suffix}`
                  : `Free ${shippingName}${suffix}`;
              })(),
              fixed_amount: { amount: shippingCents, currency: CHECKOUT_CURRENCY },
              metadata: { rlt_shipping_code: shippingCode },
            },
          }],
        } : {}),
        ...(promotion.id ? { discounts: [{ promotion_code: promotion.id }] } : {}),
        phone_number_collection: { enabled: true },
        metadata,
        payment_intent_data: { metadata },
      }, { idempotencyKey: `rlt_checkout_${checkoutRequestId}` });
      if (!session.url) throw new Error('Stripe did not return a checkout URL');

      const authoritativeTotal = Number(session.amount_total ?? provisionalTotal);
      if (authoritativeTotal < 50 || authoritativeTotal > MAX_ORDER_TOTAL_AUD * 100) {
        await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
        throw new Error('Stripe returned an invalid checkout total');
      }
      const { error } = await svc.from('store_orders').update({
        stripe_session_id: session.id,
        checkout_expires_at: new Date(session.expires_at * 1000).toISOString(),
        total_aud: fromCents(authoritativeTotal),
        discount_amount_aud: fromCents(Number(session.total_details?.amount_discount ?? promotion.discount)),
        shipping_cost_aud: fromCents(Number(session.total_details?.amount_shipping ?? shippingCents)),
      }).eq('id', order.id).eq('status', 'pending');
      if (error) {
        await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
        throw error;
      }
      return responseJson(req, { url: session.url, sessionId: session.id, expiresAt: session.expires_at });
    } catch (error) {
      console.error('createCheckout Stripe session error:', error);
      await svc.from('store_orders').update({
        status: 'cancelled',
        customer_status_note: 'Checkout could not be started. No payment was taken.',
        timeline: [...(Array.isArray(order.timeline) ? order.timeline : []), {
          action: 'checkout_failed',
          timestamp: new Date().toISOString(),
          note: 'Stripe Checkout session could not be created',
          actor: 'system',
        }],
      }).eq('id', order.id).eq('status', 'pending');
      return responseJson(req, {
        error: 'Unable to start secure checkout. Please try again.',
        checkoutRequestInvalid: true,
      }, 503);
    }
  } catch (error) {
    console.error('createCheckout error:', error);
    return responseJson(req, { error: 'Checkout is temporarily unavailable. Please try again.' }, 500);
  }
});
