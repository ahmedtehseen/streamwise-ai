update public.knowledge_bases
set name = 'Portfolio Owner Knowledge Base',
    updated_at = now()
where id = '00000000-0000-0000-0000-000000000001'
  and name = 'Shared private Knowledge Base';
