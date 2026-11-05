alter table public.answer_flags
add column response_id text;

create or replace function public.submit_answer_flag(p_flag jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_flag public.answer_flags;
begin
  if nullif(p_flag->>'response_id', '') is null then
    raise exception 'ANSWER_RESPONSE_ID_REQUIRED';
  end if;

  insert into public.answer_flags (
    response_id,
    response_fingerprint,
    question,
    outcome,
    response_content,
    source_references,
    responded_at,
    visitor_note
  ) values (
    p_flag->>'response_id',
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

revoke all on function public.submit_answer_flag(jsonb) from public;
grant execute on function public.submit_answer_flag(jsonb) to service_role;
