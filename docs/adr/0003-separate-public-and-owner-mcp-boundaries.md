# Separate public and owner MCP boundaries

Streamwise AI will expose bounded public read-only MCP tools separately from owner-only Answer Flag Review tools. The owner endpoint will use a dedicated bearer token with narrower authority than the existing Portfolio Owner administration secret; Week 7 will prove this boundary through one Codex Streamable HTTP client and defer OAuth, additional clients, and broader tools.
