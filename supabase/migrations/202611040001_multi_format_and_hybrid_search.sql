-- Expand media_type constraint to allow PDF, HTML, JSON, and CSV Project Documents
alter table public.project_documents
  drop constraint if exists project_documents_media_type_check;

alter table public.project_documents
  add constraint project_documents_media_type_check
  check (media_type in (
    'text/markdown',
    'text/plain',
    'application/pdf',
    'text/html',
    'application/json',
    'text/csv'
  ));

-- Immutable helper function for full-text search indexing on chunk heading_path and text
create or replace function public.chunk_to_tsvector(p_heading_path text[], p_text text)
returns tsvector
language sql
immutable
parallel safe
as $$
  select to_tsvector('english', coalesce(array_to_string(p_heading_path, ' '), '') || ' ' || coalesce(p_text, ''));
$$;

-- Add full-text search column and GIN index on document_chunks
alter table public.document_chunks
  add column if not exists fts tsvector generated always as (
    public.chunk_to_tsvector(heading_path, text)
  ) stored;

create index if not exists document_chunks_fts_idx
  on public.document_chunks using gin (fts);

-- Function for hybrid search with Reciprocal Rank Fusion (RRF)
create or replace function public.match_ready_document_chunks_hybrid(
  p_query_embedding extensions.vector(768),
  p_query_text text,
  p_match_count integer,
  p_embedding_model text,
  p_embedding_dimension integer
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
set search_path = public, extensions
as $$
  with vector_matches as (
    select
      chunk.id as chunk_id,
      row_number() over (order by chunk.embedding <=> p_query_embedding, chunk.id) as rank_vector,
      chunk.embedding <=> p_query_embedding as cosine_distance
    from public.document_chunks as chunk
    inner join public.project_documents as document
      on document.id = chunk.project_document_id
    where document.status = 'ready'
      and chunk.embedding_model = p_embedding_model
      and chunk.embedding_dimension = p_embedding_dimension
    order by chunk.embedding <=> p_query_embedding, chunk.id
    limit 10
  ),
  fts_matches as (
    select
      chunk.id as chunk_id,
      row_number() over (order by ts_rank_cd(chunk.fts, websearch_to_tsquery('english', coalesce(p_query_text, ''))) desc, chunk.id) as rank_fts,
      ts_rank_cd(chunk.fts, websearch_to_tsquery('english', coalesce(p_query_text, ''))) as fts_rank
    from public.document_chunks as chunk
    inner join public.project_documents as document
      on document.id = chunk.project_document_id
    where document.status = 'ready'
      and p_query_text is not null
      and trim(p_query_text) <> ''
      and chunk.fts @@ websearch_to_tsquery('english', p_query_text)
    order by ts_rank_cd(chunk.fts, websearch_to_tsquery('english', coalesce(p_query_text, ''))) desc, chunk.id
    limit 10
  ),
  fused as (
    select
      coalesce(vm.chunk_id, fm.chunk_id) as chunk_id,
      coalesce(vm.cosine_distance, 1.0) as cosine_distance,
      coalesce(fm.fts_rank, 0.0) as fts_rank,
      coalesce(1.0 / (60 + vm.rank_vector), 0.0) + coalesce(1.0 / (60 + fm.rank_fts), 0.0) as rrf_score
    from vector_matches vm
    full outer join fts_matches fm
      on vm.chunk_id = fm.chunk_id
  )
  select
    chunk.id as chunk_id,
    document.name as document_name,
    chunk.text,
    chunk.heading_path,
    chunk.start_line,
    chunk.end_line,
    fused.cosine_distance,
    fused.fts_rank,
    fused.rrf_score
  from fused
  inner join public.document_chunks as chunk
    on chunk.id = fused.chunk_id
  inner join public.project_documents as document
    on document.id = chunk.project_document_id
  order by fused.rrf_score desc, chunk.id
  limit least(greatest(p_match_count, 1), 5);
$$;

revoke all on function public.match_ready_document_chunks_hybrid(extensions.vector, text, integer, text, integer) from public;
grant execute on function public.match_ready_document_chunks_hybrid(extensions.vector, text, integer, text, integer) to service_role;

