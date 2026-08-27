// Verifies Stripe signatures and atomically records a paid order + inventory
// change through process_store_order_payment. Duplicate events are harmless.
import Stripe from 'npm:stripe@22.2.0';
import {
  escapeHtml,
  getStripeSecretKey,
  getStripeWebhookSecret,
  sendBrandedEmail,
  serviceClient,
  siteUrl,
  stripeMode,
} from './shared.ts';

const CHECKOUT_CURRENCY = 'aud';
const MAX_WEBHOOK_BYTES = 1_048_576;
const webhookJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const paymentIntentId = (session: Stripe.Checkout.Session) =>
  typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || '';
// deno-lint-ignore no-explicit-any
const shippingDetails = (session: any) =>
  session?.collected_information?.shipping_details || session?.shipping_details || null;

// deno-lint-ignore no-explicit-any
function verifyPaidSession(session: any, order: any) {
  const expectedAppId = Deno.env.get('RLT_APP_ID') || 'rugby-league-takeover';
  if (!session || !order) return 'Missing session or order';
  if (session.mode !== 'payment') return 'Unexpected Checkout mode';
  if (session.payment_status !== 'paid') return 'Checkout session is not paid';
  if (session.id !== order.stripe_session_id) return 'Checkout session does not match order';
  if (session.client_reference_id !== order.id) return 'Checkout client reference does not match order';
  if (session.metadata?.order_id !== order.id) return 'Session order metadata does not match order';
  if (session.metadata?.rlt_app_id !== expectedAppId) return 'Session app metadata does not match this app';
  if (Boolean(session.livemode) !== (stripeMode() === 'live')) return 'Stripe mode does not match server mode';
  if (String(session.currency || '').toLowerCase() !== CHECKOUT_CURRENCY) return 'Checkout currency does not match';
  const expectedCents = Math.round(Number(order.total_aud || 0) * 100);
  if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0 || Number(session.amount_total) !== expectedCents) {
    return 'Checkout amount does not match order total';
  }
  if (order.fulfilment_method === 'shipping') {
    const shipping = shippingDetails(session);
    if (!shipping?.address?.line1 || String(shipping.address.country || '').toUpperCase() !== 'AU') {
      return 'A valid Australian shipping address is required';
    }
  }
  return '';
}

// deno-lint-ignore no-explicit-any
async function sendOrderConfirmation(order: any) {
  if (!order.customer_email) return;
  const orderNumber = String(order.id).slice(-6).toUpperCase();
  const money = (value: unknown) => `$${Number(value || 0).toFixed(2)}`;
  // deno-lint-ignore no-explicit-any
  const itemRows = (order.line_items || []).map((item: any) => {
    const label = item.size ? `${item.name} — Size ${item.size}` : item.name;
    return `<tr>
      <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;">${escapeHtml(label)} <span style="color:#94a3b8;">× ${Number(item.quantity || 1)}</span></td>
      <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;text-align:right;white-space:nowrap;">${money(Number(item.price_aud || 0) * Number(item.quantity || 1))}</td>
    </tr>`;
  }).join('');
  const discountRow = Number(order.discount_amount_aud) > 0
    ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#15803d;">Promo — ${escapeHtml(order.promo_code || 'discount')}</td>
         <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#15803d;text-align:right;">−${money(order.discount_amount_aud)}</td></tr>`
    : '';
  const shippingRow = order.fulfilment_method === 'shipping'
    ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;">Shipping — ${escapeHtml(order.shipping_service_name || 'Standard delivery')}</td>
         <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;text-align:right;">${Number(order.shipping_cost_aud) > 0 ? money(order.shipping_cost_aud) : 'FREE'}</td></tr>`
    : order.fulfilment_method === 'pickup'
      ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;">Collection — ${escapeHtml(order.shipping_service_name || 'Las Vegas')}</td>
           <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#334155;text-align:right;">FREE</td></tr>`
      : '';
  const gstRow = Number(order.gst_amount_aud) > 0
    ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">GST (${Number(order.gst_rate_percent || 0)}%)${order.gst_included ? ' included' : ''}</td>
         <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;text-align:right;">${money(order.gst_amount_aud)}</td></tr>`
    : '';
  const cardRow = Number(order.card_fee_aud) > 0 && !order.card_fee_included
    ? `<tr><td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;">Card processing fee</td>
         <td style="padding:9px 0;border-bottom:1px solid #e2e8f0;color:#64748b;text-align:right;">${money(order.card_fee_aud)}</td></tr>`
    : '';
  // deno-lint-ignore no-explicit-any
  const itemsText = (order.line_items || []).map((item: any) =>
    `${item.quantity}x ${item.size ? `${item.name} (Size ${item.size})` : item.name} — ${money(Number(item.price_aud || 0) * Number(item.quantity || 1))}`
  ).join('\n');

  await sendBrandedEmail(order.customer_email, `Order confirmed — #${orderNumber}`, {
    text: `Thanks for your order!\n\nOrder #${orderNumber}\n\n${itemsText}\n${Number(order.discount_amount_aud) > 0 ? `Promo (${order.promo_code || 'discount'}): -${money(order.discount_amount_aud)}\n` : ''}${order.fulfilment_method === 'shipping' ? `Shipping: ${Number(order.shipping_cost_aud) > 0 ? money(order.shipping_cost_aud) : 'FREE'}\n` : ''}Total: ${money(order.total_aud)} AUD\n\nFollow fulfilment and tracking: ${siteUrl()}/account\n\nRugby League Takeover`,
    preheader: `Order #${orderNumber} confirmed — ${money(order.total_aud)} AUD`,
    heading: 'Order confirmed',
    bodyHtml: `<p style="margin:0 0 14px;">Thanks${order.customer_name ? ` ${escapeHtml(String(order.customer_name).split(/\s+/)[0])}` : ''} — your payment is confirmed.</p>
      <p style="margin:0 0 18px;color:#64748b;">Order <strong style="color:#ea580c;">#${orderNumber}</strong></p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">
        ${itemRows}${discountRow}${shippingRow}${gstRow}${cardRow}
        <tr><td style="padding:12px 0 0;color:#0b1220;font-weight:bold;text-transform:uppercase;letter-spacing:1px;">Total</td>
        <td style="padding:12px 0 0;color:#ea580c;font-weight:bold;text-align:right;font-size:16px;">${money(order.total_aud)} AUD</td></tr>
      </table>
      <p style="margin:20px 0 0;color:#64748b;">Follow fulfilment and tracking from Account → Orders.</p>`,
    ctaLabel: 'Track my order',
    ctaUrl: `${siteUrl()}/account`,
    footerNote: `Sent to ${order.customer_email} because an order was placed in the Vegas Takeover Store.`,
  });
}

// deno-lint-ignore no-explicit-any
async function processPaidCheckout(svc: any, event: Stripe.Event, session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.order_id;
  if (!orderId) throw new Error('Checkout session is missing order metadata');
  const { data: order, error } = await svc.from('store_orders').select('*').eq('id', orderId).maybeSingle();
  if (error || !order) throw new Error('Order not found');
  const invalid = verifyPaidSession(session, order);
  if (invalid) throw new Error(invalid);

  const shipping = shippingDetails(session);
  const address = [
    shipping?.name,
    shipping?.address?.line1,
    shipping?.address?.line2,
    shipping?.address?.city,
    shipping?.address?.state,
    shipping?.address?.postal_code,
    shipping?.address?.country,
  ].filter(Boolean).join(', ');
  const { data: result, error: processError } = await svc.rpc('process_store_order_payment', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_order_id: order.id,
    p_session_id: session.id,
    p_payment_intent_id: paymentIntentId(session),
    p_customer_email: session.customer_details?.email || session.customer_email || order.customer_email || '',
    p_customer_name: session.customer_details?.name || shipping?.name || order.customer_name || '',
    p_shipping_address: address,
    p_shipping: {
      name: shipping?.name || '',
      line1: shipping?.address?.line1 || '',
      line2: shipping?.address?.line2 || '',
      city: shipping?.address?.city || '',
      state: shipping?.address?.state || '',
      postal_code: shipping?.address?.postal_code || '',
      country: shipping?.address?.country || '',
    },
    p_paid_at: new Date(event.created * 1000).toISOString(),
  });
  if (processError) throw processError;

  // Stripe collects a phone at checkout (createCheckout sets
  // phone_number_collection), but only the email and name were ever copied off
  // customer_details — so the orders export had a delivery address and no way
  // to ring the customer about it. Written separately from the payment RPC on
  // purpose: a contact detail must never be able to fail a payment.
  const customerPhone = String(
    session.customer_details?.phone || shipping?.phone || ''
  ).trim().slice(0, 40);
  if (customerPhone) {
    const { error: phoneError } = await svc
      .from('store_orders')
      .update({ customer_phone: customerPhone })
      .eq('id', order.id);
    if (phoneError) console.error('customer_phone update failed:', phoneError);
  }

  if (result?.result === 'processed') {
    const { data: paidOrder } = await svc.from('store_orders').select('*').eq('id', order.id).single();
    if (paidOrder) await sendOrderConfirmation(paidOrder);
  }
  return result;
}

// deno-lint-ignore no-explicit-any
async function closePendingCheckout(svc: any, session: Stripe.Checkout.Session, reason: string, action: string) {
  const orderId = session.metadata?.order_id;
  if (!orderId) return;
  const { data: order } = await svc.from('store_orders').select('id,status,timeline,stripe_session_id').eq('id', orderId).maybeSingle();
  if (!order || order.status !== 'pending' || order.stripe_session_id !== session.id) return;
  await svc.from('store_orders').update({
    status: 'cancelled',
    stripe_payment_status: session.payment_status || 'unpaid',
    customer_status_note: reason,
    timeline: [...(Array.isArray(order.timeline) ? order.timeline : []), {
      action,
      timestamp: new Date().toISOString(),
      note: reason,
      actor: 'stripe',
    }],
  }).eq('id', order.id).eq('status', 'pending');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return webhookJson({ error: 'Method not allowed.' }, 405);
  try {
    const signature = req.headers.get('stripe-signature');
    if (!signature) return webhookJson({ error: 'Invalid webhook signature.' }, 400);
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_WEBHOOK_BYTES) return webhookJson({ error: 'Webhook payload is too large.' }, 413);
    const body = await req.text();
    if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BYTES) return webhookJson({ error: 'Webhook payload is too large.' }, 413);

    const stripe = new Stripe(getStripeSecretKey());
    const event = await stripe.webhooks.constructEventAsync(body, signature, getStripeWebhookSecret());
    const svc = serviceClient();
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === 'paid') {
        const result = await processPaidCheckout(svc, event, session);
        return webhookJson({ received: true, result: result?.result || 'processed' });
      }
      const orderId = session.metadata?.order_id;
      if (orderId) {
        await svc.from('store_orders').update({
          stripe_payment_status: session.payment_status || 'unpaid',
          customer_status_note: 'Payment is processing. We will prepare the order after Stripe confirms the funds.',
        }).eq('id', orderId).eq('status', 'pending');
      }
      return webhookJson({ received: true, result: 'payment_processing' });
    }
    if (event.type === 'checkout.session.async_payment_failed') {
      await closePendingCheckout(svc, event.data.object as Stripe.Checkout.Session, 'Payment did not complete. No order will be fulfilled.', 'payment_failed');
      return webhookJson({ received: true, result: 'payment_failed' });
    }
    if (event.type === 'checkout.session.expired') {
      await closePendingCheckout(svc, event.data.object as Stripe.Checkout.Session, 'Checkout expired before payment. No payment was taken.', 'checkout_expired');
      return webhookJson({ received: true, result: 'checkout_expired' });
    }
    return webhookJson({ received: true, result: 'ignored' });
  } catch (error) {
    console.error('stripeWebhook rejected event:', error);
    return webhookJson({ error: 'Webhook could not be processed.' }, 400);
  }
});
