-- Local e2e data only: two READY nodes with REALITY transport, two fast routes.
insert into public.nodes
  (node_id, api_key_hash, location_id, lifecycle_state, provider, hostname, ip_address,
   transport_port, tls_server_name, reality_public_key, reality_short_id, reality_fingerprint, vless_flow)
values
  ('e2e-de-1', repeat('a', 64), '00000000-0000-4000-8000-000000000000', 'READY', 'mock', 'de1.e2e.example.test', '203.0.113.10',
   443, 'www.example.com', repeat('A', 43), 'abcdef0123456789', 'chrome', 'xtls-rprx-vision'),
  ('e2e-nl-1', repeat('b', 64), '10000000-0000-4000-8000-000000000001', 'READY', 'mock', 'nl1.e2e.example.test', '203.0.113.20',
   443, 'www.example.com', repeat('B', 43), '0123456789abcdef', 'chrome', 'xtls-rprx-vision')
on conflict (node_id) do nothing;

insert into public.logical_routes (id, region, privacy_class, display_name)
values
  ('route_e2e_de_fast', 'de', 'fast', 'Germany · Frankfurt'),
  ('route_e2e_nl_fast', 'nl', 'fast', 'Netherlands · Amsterdam')
on conflict (id) do nothing;

insert into public.logical_route_targets (route_id, hop, node_id)
values ('route_e2e_de_fast', 1, 'e2e-de-1'), ('route_e2e_nl_fast', 1, 'e2e-nl-1')
on conflict do nothing;

select 'seeded nodes=' || (select count(*) from public.nodes) || ' routes=' || (select count(*) from public.logical_routes) as result;
