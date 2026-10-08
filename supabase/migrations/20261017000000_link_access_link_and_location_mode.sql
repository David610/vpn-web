-- Links: let the owner copy an access link again, and remember whether a
-- Link's location was chosen automatically.
--
-- 1. external_vpn_devices keeps only HMAC(subscription token) for lookup. To
--    re-show the access URL later (product decision 2026-10-08), the token is
--    also stored AES-GCM encrypted with VPN_SECRETS_ENCRYPTION_KEY, in the same
--    "\x"-hex text format as compatibility_credentials.credential_ciphertext.
--    Rows created before this migration have NULLs and must be replaced once to
--    become copyable; they keep working exactly as before.
-- 2. vpn_links.location_mode records how the route was picked. 'auto' means
--    Arcana picked an available route when the Link was created; existing
--    Links stay 'manual'.
--
-- Additive and nullable/defaulted: safe to apply before the code that reads
-- it. Apply this migration BEFORE deploying the Pages build that selects
-- location_mode, because PostgREST rejects selects of unknown columns.

alter table public.external_vpn_devices
  add column subscription_token_ciphertext text,
  add column subscription_token_nonce text;

alter table public.external_vpn_devices
  add constraint external_vpn_devices_token_cipher_pair
  check ((subscription_token_ciphertext is null) = (subscription_token_nonce is null));

alter table public.vpn_links
  add column location_mode text not null default 'manual';

alter table public.vpn_links
  add constraint vpn_links_location_mode_check
  check (location_mode in ('auto', 'manual'));

comment on column public.external_vpn_devices.subscription_token_ciphertext is
  'AES-GCM ciphertext of {v,d,t} (device id + subscription token) so the owner can copy the access link again. Never selected by list/detail endpoints; read only by the access-link endpoint.';
