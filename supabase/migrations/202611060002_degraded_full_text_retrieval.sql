create or replace function public.match_ready_document_chunks_full_text(
  p_query_text text,
  p_match_count integer
)
returns table (
  chunk_id uuid,
  document_name text,
  text text,
  heading_path text[],
  start_line integer,
  end_line integer,
  cosine_distance double precision,
  fts_rank double precision,
  rrf_score double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked_matches as (
    select
      chunk.id as chunk_id,
      document.name as document_name,
      chunk.text,
      chunk.heading_path,
      chunk.start_line,
      chunk.end_line,
      ts_rank_cd(
        chunk.fts,
        websearch_to_tsquery('english', coalesce(p_query_text, ''))
      )::double precision as fts_rank
    from public.document_chunks as chunk
    inner join public.project_documents as document
      on document.id = chunk.project_document_id
    where document.status = 'ready'
      and p_query_text is not null
      and trim(p_query_text) <> ''
      and chunk.fts @@ websearch_to_tsquery('english', p_query_text)
  )
  select
    ranked_matches.chunk_id,
    ranked_matches.document_name,
    ranked_matches.text,
    ranked_matches.heading_path,
    ranked_matches.start_line,
    ranked_matches.end_line,
    1.0::double precision as cosine_distance,
    ranked_matches.fts_rank,
    ranked_matches.fts_rank as rrf_score
  from ranked_matches
  order by ranked_matches.fts_rank desc, ranked_matches.chunk_id
  limit least(greatest(p_match_count, 1), 5);
$$;

revoke all on function public.match_ready_document_chunks_full_text(text, integer) from public;
grant execute on function public.match_ready_document_chunks_full_text(text, integer) to service_role;
