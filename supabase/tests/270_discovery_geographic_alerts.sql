begin;
select plan(18);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
select ('c2700000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','alert-'||i||'@example.test','',now(),now(),now(),'{}','{}' from generate_series(1,2)i;
set local role authenticated;
set local "request.jwt.claim.sub" = 'c2700000-0000-4000-8000-000000000001';
set local "request.jwt.claim.role" = 'authenticated';
select lives_ok($$insert into public.user_watched_zones(id,user_id,name,zone_kind,center_lat,center_lng,radius_km) values ('c2700000-1000-4000-8000-000000000001','c2700000-0000-4000-8000-000000000001','Bordeaux','radius',44.84,-0.58,10)$$,'Free radius zone');
select throws_ok($$insert into public.user_watched_zones(user_id,name,zone_kind,department) values ('c2700000-0000-4000-8000-000000000001','Deuxième','department','33')$$,'P0001','Quota de 1 alerte(s) ou zone(s) active(s) atteint.','Zone quota');
select lives_ok($$insert into public.user_alerts(id,user_id,name,watched_zone_id,alert_frequency) values ('c2700000-2000-4000-8000-000000000001','c2700000-0000-4000-8000-000000000001','Bordeaux','c2700000-1000-4000-8000-000000000001','daily')$$,'Free daily alert');
select throws_ok($$insert into public.user_alerts(user_id,name,alert_frequency) values ('c2700000-0000-4000-8000-000000000001','Deuxième','daily')$$,'P0001','Quota de 1 alerte(s) ou zone(s) active(s) atteint.','Alert quota');
select throws_ok($$update public.user_alerts set min_investment_score=80 where id='c2700000-2000-4000-8000-000000000001'$$,'42501','Discovery alerts support public criteria and daily notifications only.','Premium score rejected');
select throws_ok($$update public.user_alerts set alert_frequency='instant' where id='c2700000-2000-4000-8000-000000000001'$$,'42501','Discovery alerts support public criteria and daily notifications only.','Instant rejected');
select is((select count(*) from public.auction_sales),0::bigint,'Premium catalogue stays locked');
select throws_ok($$update public.user_alerts set user_id='c2700000-0000-4000-8000-000000000002' where id='c2700000-2000-4000-8000-000000000001'$$,'42501','Alert owner mismatch.','Cannot transfer owner');
set local "request.jwt.claim.sub" = 'c2700000-0000-4000-8000-000000000002';
select is((select count(*) from public.user_alerts),0::bigint,'Other account cannot read alert');
select is((select count(*) from public.user_watched_zones),0::bigint,'Other account cannot read zone');
set local "request.jwt.claim.sub" = 'c2700000-0000-4000-8000-000000000001';
select lives_ok($$update public.user_alerts set is_active=false where id='c2700000-2000-4000-8000-000000000001'$$,'Can pause at quota');
select lives_ok($$insert into public.user_alerts(user_id,name,alert_frequency) values ('c2700000-0000-4000-8000-000000000001','Remplacement','daily')$$,'Pause frees quota');

reset role;
insert into public.auction_sales (id, source_name, source_url, title, status)
select ('c2700000-3000-4000-8000-'||lpad(i::text,12,'0'))::uuid, 'alert-test', 'https://example.test/alert/'||i, 'Private source title', 'upcoming' from generate_series(1,2)i;
insert into public.user_alert_matches(id,user_id,alert_id,sale_id,match_snapshot)
select ('c2700000-4000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'c2700000-0000-4000-8000-000000000001','c2700000-2000-4000-8000-000000000001',('c2700000-3000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
case when i=1 then '{"audience":"discovery"}'::jsonb else '{"sale":{"investmentScore":95}}'::jsonb end from generate_series(1,2)i;
insert into public.user_alert_notifications(id,user_id,alert_id,sale_id,match_id,notification_snapshot)
select ('c2700000-5000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'c2700000-0000-4000-8000-000000000001','c2700000-2000-4000-8000-000000000001',('c2700000-3000-4000-8000-'||lpad(i::text,12,'0'))::uuid,('c2700000-4000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
case when i=1 then '{"audience":"discovery"}'::jsonb else '{"sale":{"investmentScore":95}}'::jsonb end from generate_series(1,2)i;
set local role authenticated;
select is((select count(*) from public.user_alert_matches),1::bigint,'Only public snapshots visible after downgrade');
select is((select count(*) from public.user_alert_notifications),1::bigint,'Only public notifications visible after downgrade');
select throws_ok($$update public.user_alert_notifications set notification_snapshot='{"audience":"discovery"}'$$,'42501',null,'Cannot relabel premium snapshots');
select lives_ok($$update public.user_alert_notifications set read_at=now() where id='c2700000-5000-4000-8000-000000000001'$$,'Can mark own public notification read');
set local "request.jwt.claim.sub" = 'c2700000-0000-4000-8000-000000000002';
select is((select count(*) from public.user_alert_matches),0::bigint,'Other owner cannot read public snapshot');
select is((select count(*) from public.user_alert_notifications),0::bigint,'Other owner cannot read public notification');
select * from finish();
rollback;
