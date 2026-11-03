create or replace function public.match_ready_document_chunks(
  p_query_embedding extensions.vector(768),
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
  cosine_distance double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    chunk.id,
    document.name,
    chunk.text,
    chunk.heading_path,
    chunk.start_line,
    chunk.end_line,
    chunk.embedding <=> p_query_embedding as cosine_distance
  from public.document_chunks as chunk
  inner join public.project_documents as document
    on document.id = chunk.project_document_id
  where document.status = 'ready'
    and chunk.embedding_model = p_embedding_model
    and chunk.embedding_dimension = p_embedding_dimension
  order by chunk.embedding <=> p_query_embedding, chunk.id
  limit least(greatest(p_match_count, 1), 5);
$$;

revoke all on function public.match_ready_document_chunks(extensions.vector, integer, text, integer) from public;
grant execute on function public.match_ready_document_chunks(extensions.vector, integer, text, integer) to service_role;
