-- Discovery comparison quota, sharing ownership and premium-data boundary.
begin;

select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    'c2600000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'favorite-free@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'c2600000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'favorite-other@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'c2600000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'favorite-analysis@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  );

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c2600000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c2600000-0000-4000-8000-000000000002', 'decouverte', 'active', null),
  (
    'c2600000-0000-4000-8000-000000000003',
    'analyse', 'active', now() + interval '30 days'
  );

insert into public.auction_sales (id, source_name, source_url, title, status)
select
  ('c2600000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'free-favorite-test',
  'https://example.test/free-comparison/' || i,
  'Protected title ' || i,
  'upcoming'
from generate_series(1, 11) i;


set local role authenticated;
set local "request.jwt.claim.sub" = 'c2600000-0000-4000-8000-000000000001';
set local "request.jwt.claim.role" = 'authenticated';
select lives_ok($$insert into public.user_favorites(user_id, sale_id)
select 'c2600000-0000-4000-8000-000000000001',
('c2600000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1,10) i$$, 'Discovery can save ten favorites');
select throws_ok($$insert into public.user_favorites(user_id, sale_id) values
('c2600000-0000-4000-8000-000000000001','c2600000-1000-4000-8000-000000000011')$$,
'P0001', 'Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.', 'Eleventh favorite rejected');
select is((select count(*) from public.auction_sales), 0::bigint, 'No premium data unlocked');
select lives_ok($$delete from public.user_favorites where sale_id = 'c2600000-1000-4000-8000-000000000001'$$, 'Removal allowed at quota');
select lives_ok($$insert into public.user_favorites(user_id, sale_id) values
('c2600000-0000-4000-8000-000000000001','c2600000-1000-4000-8000-000000000011')$$, 'Slot reusable');
set local "request.jwt.claim.sub" = 'c2600000-0000-4000-8000-000000000002';
select is((select count(*) from public.user_favorites), 0::bigint, 'Other account cannot read favorites');
select throws_ok($$insert into public.user_favorites(user_id, sale_id) values
('c2600000-0000-4000-8000-000000000001','c2600000-1000-4000-8000-000000000001')$$,
'42501', 'Favorite owner mismatch.', 'Cross-owner insert denied before checking quota');
set local "request.jwt.claim.sub" = 'c2600000-0000-4000-8000-000000000003';
select lives_ok($$insert into public.user_favorites(user_id, sale_id)
select 'c2600000-0000-4000-8000-000000000003',
('c2600000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1,11) i$$, 'Paid favorites remain unlimited');
reset role;
select * from finish();
rollback;
