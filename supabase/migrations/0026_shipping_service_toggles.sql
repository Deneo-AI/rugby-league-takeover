alter table public.site_settings
  add column if not exists shipping_standard_enabled boolean not null default true,
  add column if not exists shipping_express_enabled boolean not null default true;

comment on column public.site_settings.shipping_standard_enabled is
  'Allows Australia Post Standard/Parcel Post quotes when shipping_mode is calculated.';

comment on column public.site_settings.shipping_express_enabled is
  'Allows Australia Post Express Post quotes when shipping_mode is calculated.';
