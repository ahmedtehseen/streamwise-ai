create table public.public_allowance_buckets (
  bucket_type text not null check (bucket_type in ('visitor_minute', 'global_minute', 'visitor_day', 'global_day')),
  bucket_key text not null,
  window_start timestamptz not null,
  action_count integer not null check (action_count > 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (bucket_type, bucket_key, window_start)
);

alter table public.public_allowance_buckets enable row level security;

create index public_allowance_buckets_expiry_idx
  on public.public_allowance_buckets (expires_at);

create or replace function public.admit_public_action(p_visitor_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz;
  v_minute_start timestamptz;
  v_minute_reset timestamptz;
  v_day_start timestamptz;
  v_day_reset timestamptz;
  v_visitor_minute integer;
  v_global_minute integer;
  v_visitor_day integer;
  v_global_day integer;
begin
  if p_visitor_id is null or p_visitor_id !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_VISITOR_ID';
  end if;

  -- Serialize admission itself so all four counters are checked and incremented
  -- as one durable decision. The deliberately strict global limits keep this
  -- lock short and bounded while preventing concurrent oversubscription.
  perform pg_advisory_xact_lock(hashtextextended('streamwise-public-allowance', 0));

  v_now := clock_timestamp();
  v_minute_start := date_trunc('minute', v_now);
  v_minute_reset := v_minute_start + interval '1 minute';
  v_day_start := date_trunc('day', v_now at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  v_day_reset := (date_trunc('day', v_now at time zone 'America/Los_Angeles') + interval '1 day') at time zone 'America/Los_Angeles';

  delete from public.public_allowance_buckets
  where expires_at < v_now - interval '1 day';

  select
    coalesce(max(action_count) filter (where bucket_type = 'visitor_minute'), 0),
    coalesce(max(action_count) filter (where bucket_type = 'global_minute'), 0),
    coalesce(max(action_count) filter (where bucket_type = 'visitor_day'), 0),
    coalesce(max(action_count) filter (where bucket_type = 'global_day'), 0)
  into v_visitor_minute, v_global_minute, v_visitor_day, v_global_day
  from public.public_allowance_buckets
  where (bucket_type = 'visitor_minute' and bucket_key = p_visitor_id and window_start = v_minute_start)
     or (bucket_type = 'global_minute' and bucket_key = 'global' and window_start = v_minute_start)
     or (bucket_type = 'visitor_day' and bucket_key = p_visitor_id and window_start = v_day_start)
     or (bucket_type = 'global_day' and bucket_key = 'global' and window_start = v_day_start);

  if v_visitor_day >= 10 then
    return jsonb_build_object('admitted', false, 'limited_by', 'visitor_day', 'reset_at', v_day_reset);
  end if;
  if v_global_day >= 50 then
    return jsonb_build_object('admitted', false, 'limited_by', 'global_day', 'reset_at', v_day_reset);
  end if;
  if v_visitor_minute >= 3 then
    return jsonb_build_object('admitted', false, 'limited_by', 'visitor_minute', 'reset_at', v_minute_reset);
  end if;
  if v_global_minute >= 15 then
    return jsonb_build_object('admitted', false, 'limited_by', 'global_minute', 'reset_at', v_minute_reset);
  end if;

  insert into public.public_allowance_buckets (bucket_type, bucket_key, window_start, action_count, expires_at)
  values
    ('visitor_minute', p_visitor_id, v_minute_start, 1, v_minute_reset),
    ('global_minute', 'global', v_minute_start, 1, v_minute_reset),
    ('visitor_day', p_visitor_id, v_day_start, 1, v_day_reset),
    ('global_day', 'global', v_day_start, 1, v_day_reset)
  on conflict (bucket_type, bucket_key, window_start)
  do update set
    action_count = public.public_allowance_buckets.action_count + 1,
    expires_at = excluded.expires_at,
    updated_at = v_now;

  return jsonb_build_object('admitted', true, 'limited_by', null, 'reset_at', null);
end;
$$;

revoke all on table public.public_allowance_buckets from public;
revoke all on function public.admit_public_action(text) from public;
grant execute on function public.admit_public_action(text) to service_role;
