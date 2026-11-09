create table public.answer_flags (
  id uuid primary key default gen_random_uuid(),
  response_fingerprint text not null,
  question text not null check (trim(question) <> ''),
  outcome text not null check (outcome in ('answered', 'insufficient_evidence')),
  response_content jsonb not null check (jsonb_typeof(response_content) = 'object'),
  source_references jsonb not null check (jsonb_typeof(source_references) = 'array'),
  responded_at timestamptz not null,
  visitor_note text check (visitor_note is null or char_length(visitor_note) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (response_fingerprint),
  check (
    (status = 'open' and reviewed_at is null)
    or (status = 'reviewed' and reviewed_at is not null)
  )
);

alter table public.answer_flags enable row level security;

create or replace function public.submit_answer_flag(p_flag jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_flag public.answer_flags;
begin
  insert into public.answer_flags (
    response_fingerprint,
    question,
    outcome,
    response_content,
    source_references,
    responded_at,
    visitor_note
  ) values (
    p_flag->>'response_fingerprint',
    p_flag->>'question',
    p_flag->>'outcome',
    p_flag->'response_content',
    p_flag->'source_references',
    (p_flag->>'responded_at')::timestamptz,
    nullif(p_flag->>'visitor_note', '')
  )
  returning * into created_flag;

  return to_jsonb(created_flag);
end;
$$;

create or replace function public.review_answer_flag(p_flag_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reviewed_flag public.answer_flags;
begin
  update public.answer_flags
  set status = 'reviewed', reviewed_at = now()
  where id = p_flag_id and status = 'open'
  returning * into reviewed_flag;

  if reviewed_flag.id is null then
    raise exception 'ANSWER_FLAG_NOT_OPEN';
  end if;

  return to_jsonb(reviewed_flag);
end;
$$;

revoke all on function public.submit_answer_flag(jsonb) from public;
grant execute on function public.submit_answer_flag(jsonb) to service_role;
revoke all on function public.review_answer_flag(uuid) from public;
grant execute on function public.review_answer_flag(uuid) to service_role;
