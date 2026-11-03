# Use Supabase pgvector and Gemini embeddings

Streamwise AI will store Project Document chunks and embeddings in hosted Supabase Postgres with pgvector, and generate normalized 768-dimensional vectors through the raw Gemini `gemini-embedding-2` REST API. This introduces the product's first durable backend, preserves compatibility with a later pgvector index, reuses the existing Gemini integration, and gives Week 6 a path to Supabase Auth and row-level security; changing the embedding model or dimensionality requires re-indexing every Project Document.
