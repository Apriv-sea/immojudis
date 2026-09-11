-- Preserve an explicit source postponement even when legacy normalization sets status=past.
-- One deadline for collection and scheduled retention. No guessing on postponed sales.
create or replace function app_private.sale_retention_deadline(
  p_sale_date timestamptz, p_status text, p_procedure jsonb, p_raw jsonb
) returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare
  schedule jsonb;
  start_at timestamptz;
  end_at timestamptz;
  raw_date text := coalesce(p_raw->>'sale_date', '');
begin
  if (coalesce(p_status,'') || ' ' || coalesce(p_raw->>'status','')) ~* '\m(postponed|reported|report[eé]e?)\M' then return null; end if;
  foreach schedule in array array[p_procedure->'sale_window', p_procedure->'sale_session', p_raw->'source_sale_schedule'] loop
    if schedule is not null and schedule <> 'null'::jsonb then
      begin
        if (schedule->>'opens_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or (schedule->>'closes_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or schedule->>'opens_at' is null or schedule->>'closes_at' is null then return null; end if;
        start_at := (schedule->>'opens_at')::timestamptz;
        end_at := (schedule->>'closes_at')::timestamptz;
        if not isfinite(start_at) or not isfinite(end_at) or end_at <= start_at then return null; end if;
        return end_at + interval '24 hours';
      exception when invalid_datetime_format or datetime_field_overflow then return null;
      end;
    end if;
  end loop;
  if p_sale_date is null or not isfinite(p_sale_date) then return null; end if;
  -- Date-only source values are normalized to midnight UTC by old collectors.
  -- Recover the Paris civil date before adding exactly 24 elapsed hours.
  if raw_date <> '' and raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})' then
    return (((p_sale_date at time zone 'UTC')::date)::timestamp at time zone 'Europe/Paris') + interval '24 hours';
  end if;
  return p_sale_date + interval '24 hours';
end;
$$;
revoke all on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) to service_role;

