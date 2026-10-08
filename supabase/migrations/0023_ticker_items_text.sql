-- Correct out-of-band drift on site_settings.ticker_items.
--
-- The app has always stored the scrolling banner as newline-separated TEXT
-- (one marquee item per line — see 0011_site_ticker.sql and Home.jsx's
-- parseTickerItems). At some point the production column was converted
-- out-of-band to jsonb with a "must be a jsonb array of <= 12 items" check
-- (site_settings_ticker_items_valid). That never matched the code: the admin
-- writes a plain string, which lands as a jsonb 'string', not an 'array', so
-- every save failed with
--   new row for relation "site_settings" violates check constraint
--   "site_settings_ticker_items_valid"
-- and the "Scrolling Banner" editor showed "Action failed" (emojis included).
--
-- This restores the column to text, preserving any existing jsonb-array value
-- by joining its elements with newlines so nothing is lost. site_settings_view
-- selects ticker_items, so it is dropped and recreated around the type change.

alter table public.site_settings
  drop constraint if exists site_settings_ticker_items_valid;

drop view if exists public.site_settings_view;

-- Postgres forbids a subquery directly in an ALTER ... USING transform, so the
-- array→text conversion is wrapped in temporary overloads. Production may have
-- jsonb because of historical drift, while clean preview databases already have
-- text; supporting both makes the migration replay-safe without losing content.
create or replace function public._ticker_jsonb_to_text(v jsonb)
  returns text language sql immutable as $$
  select case
    when v is null then null
    when jsonb_typeof(v) = 'array'
      then (select string_agg(elem, E'\n') from jsonb_array_elements_text(v) as elem)
    when jsonb_typeof(v) = 'string' then v #>> '{}'
    else v::text
  end
$$;

create or replace function public._ticker_jsonb_to_text(v text)
  returns text language sql immutable as $$
  select v
$$;

alter table public.site_settings
  alter column ticker_items type text
  using public._ticker_jsonb_to_text(ticker_items);

drop function public._ticker_jsonb_to_text(jsonb);
drop function public._ticker_jsonb_to_text(text);

-- Recreate the sanitising public read view exactly as before (masks the
-- shipping sender address / creator columns for non-admins).
create view public.site_settings_view as
 SELECT id,
    site_logo_url,
    hero_eyebrow,
    hero_eyebrow_visible,
    hero_title,
    hero_description,
    hero_button_label,
    ticker_items,
    background_video_urls,
    contact_email,
    social_facebook_url,
    social_instagram_url,
    social_tiktok_url,
    facebook_fans,
    legal_terms,
    legal_privacy,
    news_eyebrow,
    news_title,
    news_description,
    about_eyebrow,
    about_title,
    about_description,
    about_body,
    about_highlight,
    about_image_url,
    about_image_caption,
    travel_eyebrow,
    travel_title,
    travel_description,
    registration_eyebrow,
    registration_title,
    registration_description,
    merch_eyebrow,
    merch_title,
    merch_description,
    footer_text,
    footer_powered_by,
    countdown_enabled,
    countdown_title,
    countdown_subtitle,
    countdown_date,
    countdown_cta_label,
    countdown_cta_url,
    ads_enabled,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_name ELSE NULL::text END AS shipping_sender_name,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_business_name ELSE NULL::text END AS shipping_sender_business_name,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_address_line1 ELSE NULL::text END AS shipping_sender_address_line1,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_address_line2 ELSE NULL::text END AS shipping_sender_address_line2,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_suburb ELSE NULL::text END AS shipping_sender_suburb,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_state ELSE NULL::text END AS shipping_sender_state,
    CASE WHEN (SELECT is_admin()) THEN shipping_sender_postcode ELSE NULL::text END AS shipping_sender_postcode,
    created_date,
    updated_date,
    CASE WHEN (SELECT is_admin()) THEN created_by ELSE NULL::text END AS created_by,
    CASE WHEN (SELECT is_admin()) THEN created_by_id ELSE NULL::text END AS created_by_id,
    gst_enabled,
    gst_rate_percent,
    gst_mode,
    gst_label,
    card_fee_enabled,
    card_fee_percent,
    card_fee_fixed_aud,
    card_fee_mode,
    card_fee_label,
    free_shipping_threshold_aud,
    pickup_enabled,
    pickup_audience,
    pickup_label,
    pickup_instructions
   FROM public.site_settings;

grant select on public.site_settings_view to anon, authenticated, service_role;
