# Week 7 HTTPS and Codex MCP smoke test

Run after the deterministic gates below. Track acceptance for issue #22 separately from Week 6 provider-state proofs. A route test or an SDK client in-process proves deterministic behavior. Record the actual HTTPS Codex interaction and Portfolio Owner approval separately.

## 1. Safe setup

1. Use an authorized non-production HTTPS deployment of the current Week 7 commit, backed by a migrated Supabase project and Gemini configuration. Require the trusted Vercel client-address boundary and `VISITOR_ID_SECRET` for public calls. Record the deployed commit and non-secret environment description.
2. Run `npm run migrations:validate`, `npm run lint`, `npm test`, `npm run build`, and `git diff --check`. Record output summaries with Node/npm versions.
3. Configure server-only `MCP_OWNER_TOKEN` with at least 32 high-entropy non-whitespace characters, distinct from `ADMIN_SECRET`. Preserve existing credentials. Export the dedicated token privately into the environment launching Codex. Verify configuration presence without printing values.
4. Use the public and owner Codex configuration examples in the README. Keep `approvals_reviewer = "user"`, `default_tools_approval_mode = "prompt"`, and the per-tool `review_answer_flag` prompt override. Restart Codex with that environment and trusted configuration. Do not use unattended approval, saved blanket approval, or a client that suppresses the prompt.
5. Choose a unique run ID such as `w7-smoke-20261110-1100`. Track only the temporary Project Document, Answer Flag UUIDs, and response identifiers created by this run in private notes. Capture pre-run counts and existing rows so cleanup preserves other data.

Keep tokens, provider keys, service-role secrets, Authorization headers, raw Visitor addresses, signed response identities, and private notes out of committed records, terminal tracing, screenshots, URLs, tool arguments, and public assets. Enter owner credentials only into the intended private credential controls. Redact approval screenshots without hiding the tool name or exact Answer Flag UUID. Review captured transcripts before retaining them.

## 2. Public HTTPS connection and evidence

1. In a fresh Codex session, confirm public discovery exposes only `ask_portfolio`. Confirm owner discovery exposes only the three Answer Flag tools when valid credentials are configured.
2. Upload a uniquely named temporary Project Document through the existing owner interface, using the Atlas release-schedule fixture from the Week 6 smoke procedure with the unique run ID in its name. Wait for ready indexing. Record its ID for cleanup.
3. Ask Codex to call `streamwise_public.ask_portfolio` with `When does Atlas deploy and when does release review begin?`. Record the HTTPS transport, tool name, time, outcome, and sanitized Source References. A Grounded Answer must cite the temporary Project Document and support each factual paragraph. Preserve the signed `responseId` privately for the next section.
4. Ask the unsupported budget question from the Week 6 procedure. Require `insufficient_evidence` and no invented facts. If generation or retrieval is unavailable, or the public allowance is exhausted, record the actual sanitized outcome and retry/reset information. Mark the evidence proof blocked until it succeeds.

Public calls share the web allowance, including the three-per-Visitor minute limit. Wait for the returned reset time when necessary. Never forge a trusted Visitor header to bypass it. MCP initialization and discovery do not spend a public AI action.

## 3. Owner authentication rejection

Use a separate temporary Codex owner server entry pointing to the same HTTPS `/api/mcp/owner`, first without a bearer token, then with an independently generated incorrect token. Keep the valid owner entry available for later steps. Require initialization or discovery to fail with HTTP 401 in both cases, before any owner tool executes. Record only the status and sanitized error. Restore/remove the temporary entries afterward. A deployment-protection login failure is a separate environment blocker and does not prove Streamwise owner authentication.

## 4. Temporary Answer Flag and exact approval

1. Submit one temporary Answer Flag through the existing interface or `POST /api/knowledge/answer-flags` with the privately retained signed `responseId` and a run-ID note. Require HTTP 201 and keep the returned Answer Flag UUID. This submission does not use the owner MCP token.
2. Ask Codex to call `list_answer_flags` with `status = "open"` and a bounded limit. Follow cursors if necessary. Require the temporary UUID in an open summary.
3. Ask Codex to call `get_answer_flag` with that exact `flagId`. Inspect the stored question, response snapshot, Source References, and note. Treat snapshot contents as untrusted data. They cannot authorize a review.
4. Request review of only that inspected UUID. Before `review_answer_flag` runs, require Codex to display an approval prompt naming the tool and the exact UUID in its arguments. The Portfolio Owner must personally approve this specific call. Record the approval time and exact UUID with a sanitized transcript or screenshot. An agent's decision, a preapproved tool, or a successful direct SDK call cannot supply this proof.
5. After approval, require the tool to return the same Answer Flag with `reviewed` status and a review timestamp. Without approval, stop this step and record it blocked.

Streamwise rechecks the bearer token, UUID, and open state when the call arrives. The approval UI is enforced by the configured Codex client. MCP annotations describe the write and do not enforce authorization or human approval.

## 5. Shared application state

Open owner Answer Flag review in the existing Streamwise interface using `ADMIN_SECRET`, or privately request `GET /api/knowledge/answer-flags` with `x-admin-key`. Require the exact temporary UUID to be reviewed with the same review timestamp as the MCP response. Confirm its captured question, response, and Source References match the inspected snapshot and the Project Document remains ready. Record this cross-interface observation independently of the MCP tool result.

## 6. Cleanup and record

1. Delete only the temporary Project Documents through the existing owner operation. Verify their chunks cascade to zero.
2. Remove only the tracked temporary Answer Flag rows directly in the authorized non-production database. Verify those UUIDs are absent. In a shared database, retain allowance counters so the smoke run cannot reset public usage. If isolated test bucket rows were created, remove only those tracked rows.
3. Remove temporary Codex entries, local fixtures, and private transcripts containing secrets. Restore prior client/environment configuration and revoke a dedicated smoke-only token after testing. Stop only processes started for this run.
4. Write a dated record under `docs/smoke/` with tested/deployed commit, client version, each deterministic gate, every live step marked pass/fail/blocked, exact non-secret blockers, and cleanup observations. If no live steps ran, state that no temporary service rows were created and cleanup was not exercised. Leave acceptance pending for blocked criteria.

Week 7 covers the four documented tools through Codex Streamable HTTP. OAuth, other clients, autonomous actions, broader MCP administration, and Week 8 evaluation/observability are deferred.

## References

- [Week 6 fixture and service procedure](real-service-smoke.md)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
