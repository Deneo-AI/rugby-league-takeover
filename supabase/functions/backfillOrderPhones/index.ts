// One-off (re-runnable) backfill: copy the customer's phone number from the
// Stripe Checkout Session onto orders that predate the customer_phone column.
//
// Stripe has been collecting the number since checkout was built
// (createCheckout sets phone_number_collection), but stripeWebhook only copied
// the email and name, so every order paid before migration 0037 has an address
// and no contact number — exactly what a postage run needs.
//
// Admin-only. Read-only against Stripe, and only ever fills a BLANK phone, so
// running it twice is harmless.
import Stripe from 'npm:stripe@22.2.0';
import { json, preflight, serviceClient, getCaller, getStripeSecretKey } from './shared.ts';

const MAX_ORDERS = 200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    const svc = serviceClient();
    const me = await getCaller(req, svc);
    if (!me || me.role !== 'admin') {
      return json({ error: 'Administrator access required.' }, 403);
    }

    const { data: orders, error } = await svc
      .from('store_orders')
      .select('id, stripe_session_id, customer_phone')
      .not('stripe_session_id', 'is', null)
      .neq('stripe_session_id', '')
      .or('customer_phone.is.null,customer_phone.eq.')
      .limit(MAX_ORDERS);
    if (error) throw error;

    const stripe = new Stripe(getStripeSecretKey(), { apiVersion: '2024-06-20' });
    let updated = 0;
    let noPhone = 0;
    const failures: string[] = [];

    for (const order of orders || []) {
      try {
        const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        const phone = String(
          session?.customer_details?.phone || session?.shipping_details?.phone || ''
        ).trim().slice(0, 40);
        if (!phone) { noPhone += 1; continue; }
        const { error: updateError } = await svc
          .from('store_orders')
          .update({ customer_phone: phone })
          .eq('id', order.id);
        if (updateError) throw updateError;
        updated += 1;
      } catch (err) {
        // One bad session must not abort the run — report it and continue.
        failures.push(`${order.id}: ${(err as Error).message}`);
      }
    }

    return json({
      ok: true,
      examined: (orders || []).length,
      updated,
      no_phone_on_session: noPhone,
      failures,
    });
  } catch (error) {
    console.error('backfillOrderPhones error:', error);
    return json({ error: (error as Error).message }, 500);
  }
});
