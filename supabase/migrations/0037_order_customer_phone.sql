-- 0037: store the customer's phone number on the order.
--
-- Stripe Checkout has been collecting it all along — createCheckout sets
-- `phone_number_collection: { enabled: true }` — but the webhook only ever
-- copied the email and name off customer_details, so the number was thrown
-- away. The admin orders export therefore had the full delivery address and no
-- way to phone the customer about it, which is exactly what a courier or a
-- failed delivery needs.
--
-- Additive and nullable: existing rows stay valid, and nothing reads this
-- column until it is populated.
alter table public.store_orders
  add column if not exists customer_phone text;

comment on column public.store_orders.customer_phone is
  'Contact phone captured from Stripe Checkout (customer_details.phone, falling back to the shipping phone). Populated by stripeWebhook on payment; backfilled for older orders from the Stripe session.';

-- Backfill what we already hold. Stripe has the number for every paid order,
-- but that needs an API call (see the backfillOrderPhones function); these are
-- the ones recoverable from our own data right now, so the postage run has a
-- contact number where the customer ever gave us one.
--
-- Travel enquiries first (a phone is a required field on that form), then the
-- account profile. Matched on email, case-insensitively. Only fills a blank —
-- never overwrites a number Stripe supplied.
update public.store_orders o
   set customer_phone = r.phone
  from (
    select distinct on (lower(email)) lower(email) as email, phone
      from public.interest_registrations
     where coalesce(phone, '') <> ''
     order by lower(email), created_date desc
  ) r
 where coalesce(o.customer_phone, '') = ''
   and lower(o.customer_email) = r.email;

update public.store_orders o
   set customer_phone = p.phone
  from public.profiles p
 where coalesce(o.customer_phone, '') = ''
   and coalesce(p.phone, '') <> ''
   and lower(o.customer_email) = lower(p.email);
