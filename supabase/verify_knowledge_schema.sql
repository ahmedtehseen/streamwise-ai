-- Read-only post-migration verification. Every boolean in the single result row must be true.
select
  exists (
    select 1 from pg_extension where extname = 'vector'
  ) as vector_extension_ready,
  (
    select format_type(attribute.atttypid, attribute.atttypmod)
      in ('vector(768)', 'extensions.vector(768)')
    from pg_attribute as attribute
    where attribute.attrelid = 'public.document_chunks'::regclass
      and attribute.attname = 'embedding'
      and not attribute.attisdropped
  ) as embedding_is_768_dimensions,
  (
    select count(*) = 3 and bool_and(class.relrowsecurity)
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname in ('knowledge_bases', 'project_documents', 'document_chunks')
  ) as knowledge_tables_have_rls,
  (
    select count(*) = 8
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'begin_project_document_indexing',
        'complete_project_document_indexing',
        'fail_project_document_indexing',
        'retry_project_document_indexing',
        'begin_project_document_replacement',
        'retry_project_document_replacement',
        'discard_project_document_replacement',
        'match_ready_document_chunks'
      )
  ) as knowledge_functions_ready,
  exists (
    select 1 from pg_attribute
    where attrelid = 'public.project_documents'::regclass
      and attname = 'replaces_document_id'
      and not attisdropped
  ) as document_replacement_link_ready,
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'project_documents_one_pending_replacement'
      and indexdef ilike '%where (replaces_document_id is not null)%'
  ) as one_pending_replacement_enforced,
  exists (
    select 1
    from public.knowledge_bases
    where id = '00000000-0000-0000-0000-000000000001'
      and name = 'Shared private Knowledge Base'
  ) as shared_private_knowledge_base_ready,
  exists (
    select 1
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname = 'public_allowance_buckets'
      and class.relrowsecurity
  ) as public_allowance_buckets_have_rls,
  exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = 'admit_public_action'
  ) as public_allowance_admission_ready,
  exists (
    select 1
    from pg_class as class
    join pg_namespace as namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname = 'answer_flags'
      and class.relrowsecurity
  ) as answer_flags_have_rls,
  (
    select count(*) = 2
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in ('submit_answer_flag', 'review_answer_flag')
  ) as answer_flag_functions_ready;
