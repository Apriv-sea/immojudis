-- Discovery comparison quota, sharing ownership and premium-data boundary.
begin;

select plan(17);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    'c2500000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'comparison-free@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'c2500000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'comparison-other@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'c2500000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'comparison-analysis@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  );

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c2500000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c2500000-0000-4000-8000-000000000002', 'decouverte', 'active', null),
  (
    'c2500000-0000-4000-8000-000000000003',
    'analyse', 'active', now() + interval '30 days'
  );

insert into public.auction_sales (id, source_name, source_url, title, status)
select
  ('c2500000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'free-comparison-test',
  'https://example.test/free-comparison/' || i,
  'Protected title ' || i,
  'upcoming'
from generate_series(1, 6) i;

insert into public.user_sale_analysis_sets (id, user_id, name, analysis_kind)
values (
  'c2500000-2000-4000-8000-000000000002',
  'c2500000-0000-4000-8000-000000000002',
  'Other owner comparison',
  'comparison'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'c2500000-0000-4000-8000-000000000001';
set local "request.jwt.claim.role" = 'authenticated';

select lives_ok(
  $$insert into public.user_sale_analysis_sets (id, user_id, name, analysis_kind)
    values (
      'c2500000-2000-4000-8000-000000000001',
      'c2500000-0000-4000-8000-000000000001',
      'My free comparison',
      'comparison'
    )$$,
  'Discovery may create its one active comparison'
);

select lives_ok(
  $$insert into public.user_sale_analysis_items (
      analysis_set_id, user_id, sale_id, item_order
    )
    select
      'c2500000-2000-4000-8000-000000000001',
      'c2500000-0000-4000-8000-000000000001',
      ('c2500000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      i - 1
    from generate_series(1, 3) i$$,
  'Discovery may save three distinct sales'
);

select throws_ok(
  $$insert into public.user_sale_analysis_items (
      analysis_set_id, user_id, sale_id, item_order
    ) values (
      'c2500000-2000-4000-8000-000000000001',
      'c2500000-0000-4000-8000-000000000001',
      'c2500000-1000-4000-8000-000000000004',
      3
    )$$,
  'P0001',
  'Quota de 3 biens par comparaison atteint.',
  'Discovery cannot add a fourth sale'
);

select throws_ok(
  $$insert into public.user_sale_analysis_sets (user_id, name, analysis_kind)
    values (
      'c2500000-0000-4000-8000-000000000001',
      'Second free comparison',
      'comparison'
    )$$,
  'P0001',
  'Quota de 1 comparaison(s) active(s) atteint.',
  'Discovery cannot create a second active comparison'
);

select throws_ok(
  $$update public.user_sale_analysis_sets
    set analysis_kind = 'watchlist'
    where id = 'c2500000-2000-4000-8000-000000000001'$$,
  '42501',
  'Only saved comparisons are available on Discovery.',
  'Discovery cannot turn the free resource into a watchlist'
);

select throws_ok(
  $$insert into public.user_api_keys (user_id, name, key_prefix, key_hash)
    values (
      'c2500000-0000-4000-8000-000000000001',
      'Forbidden key', 'ij_forbidden', repeat('a', 64)
    )$$,
  '42501',
  'permission denied for table user_api_keys',
  'the free comparison exception does not unlock API keys'
);

select throws_ok(
  $$update public.user_sale_analysis_sets
    set share_token_hash = repeat('a', 64),
        shared_at = now(),
        share_expires_at = now() + interval '1 day'
    where id = 'c2500000-2000-4000-8000-000000000001'$$,
  '42501',
  'permission denied for table user_sale_analysis_sets',
  'sharing columns remain server-owned'
);

select is(
  (
    select count(*)
    from public.user_sale_analysis_sets
    where id = 'c2500000-2000-4000-8000-000000000002'
  ),
  0::bigint,
  'RLS hides another account comparison'
);

select throws_ok(
  $$insert into public.user_sale_analysis_items (
      analysis_set_id, user_id, sale_id, item_order
    ) values (
      'c2500000-2000-4000-8000-000000000002',
      'c2500000-0000-4000-8000-000000000001',
      'c2500000-1000-4000-8000-000000000005',
      0
    )$$,
  '23503',
  null,
  'the composite owner foreign key rejects cross-account items'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where source_name = 'free-comparison-test'
  ),
  0::bigint,
  'Discovery still cannot read the protected auction_sales table'
);

select lives_ok(
  $$select public.save_sale_analysis_set(
    '{"name":"Atomic replacement","analysis_kind":"comparison","assumptions":{},"summary_snapshot":{},"is_archived":false}',
    '[{"saleId":"c2500000-1000-4000-8000-000000000004"}]',
    'c2500000-2000-4000-8000-000000000001')$$,
  'the RPC replaces metadata and items together under Discovery RLS'
);
select throws_ok(
  $$select public.save_sale_analysis_set(
    '{"name":"Must roll back","analysis_kind":"comparison","assumptions":{},"summary_snapshot":{},"is_archived":false}',
    '[{"saleId":"c2500000-1000-4000-8000-000000000099"}]',
    'c2500000-2000-4000-8000-000000000001')$$,
  '23503', null, 'an invalid replacement fails atomically'
);
select results_eq(
  $$select s.name, i.sale_id from public.user_sale_analysis_sets s
    join public.user_sale_analysis_items i on i.analysis_set_id = s.id
    where s.id = 'c2500000-2000-4000-8000-000000000001'$$,
  $$select 'Atomic replacement'::text, 'c2500000-1000-4000-8000-000000000004'::uuid$$,
  'failed replacement preserves the previous name and selection'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = 'c2500000-0000-4000-8000-000000000003';
set local "request.jwt.claim.role" = 'authenticated';

select lives_ok(
  $$insert into public.user_sale_analysis_sets (id, user_id, name, analysis_kind)
    values
      (
        'c2500000-2000-4000-8000-000000000003',
        'c2500000-0000-4000-8000-000000000003',
        'Analysis comparison one', 'comparison'
      ),
      (
        'c2500000-2000-4000-8000-000000000004',
        'c2500000-0000-4000-8000-000000000003',
        'Analysis comparison two', 'comparison'
      )$$,
  'Analyse keeps its multi-set allowance'
);

select lives_ok(
  $$insert into public.user_sale_analysis_items (
      analysis_set_id, user_id, sale_id, item_order
    )
    select
      'c2500000-2000-4000-8000-000000000003',
      'c2500000-0000-4000-8000-000000000003',
      ('c2500000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      i - 1
    from generate_series(1, 4) i$$,
  'Analyse keeps its allowance above the Discovery item limit'
);

reset role;

select ok(
  not has_table_privilege('anon', 'public.user_sale_analysis_sets', 'select'),
  'anonymous callers cannot enumerate saved comparisons'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'user_sale_analysis_sets_share_token_hash_idx'
      and indexdef ilike '%unique%'
  ),
  'share token hashes have a unique lookup index'
);

select * from finish();

rollback;
