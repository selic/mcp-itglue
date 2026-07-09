# mcp-itglue

MCP server for the IT Glue API. TypeScript, ESM, Node ≥20. Transports: stdio (local) and streamable HTTP (shared deployments).

## Commands

- `npm run build` — tsc → `dist/` (tests are excluded from the build)
- `npm test` — vitest, test files live beside sources (`src/**/*.test.ts`)
- `npm run dev` / `npm run dev:http` — run from source via tsx

## Architecture

- `src/index.ts` — CLI entry; `src/config.ts` — env/flag parsing (`ConfigError` on bad input)
- `src/itglue/client.ts` — fetch-based JSON:API client. Wire format is kebab-case; deserialization converts **top-level attribute keys only** to snake_case so user-defined keys (flexible-asset traits) survive untouched
- `src/auth/tokens.ts` — role tokens (`MCP_TOKENS_VIEWER/EDITOR/ADMIN`, `label:token,…` lists, timing-safe compare)
- `src/auth/roles.ts` — `ToolRegistrar`: tools are tiered read/write/destructive (derived from MCP annotations, with an explicit `tier` override where RBAC intent differs — e.g. `itglue_delete_document_section` is annotated destructive but tiered write). Disallowed tools are never registered (invisible in tools/list) AND handlers re-check the role at call time
- `src/server.ts` — `createServer(config, {role, label, apiKey})`, one McpServer per session
- `src/http/app.ts` — Express app: `/mcp` (sessions bound to principal = role + label + SHA-256 of any client key; mismatch → 403), `/health`, `/webhook/itglue` (HMAC), `/index/refresh` (shared secret or admin token). BYOK policy via `CLIENT_ITGLUE_KEYS` (disabled | with-token | open)
- `src/vector/` — embeddings (OpenAI/AzureOpenAI), JSON-file index with cosine search, `indexer.ts` shared by the build tool, webhook, manual refresh, and post-write self-refresh (`queueDocumentRefresh`)

## Conventions

- Tool responses go through `src/tools/shared.ts` helpers (`text`/`failure`/`json`); errors are returned as `isError` text via `describeError`, never thrown to the SDK
- All log output uses `console.error` (stdout is reserved for the stdio transport)
- Never log token values or API keys — labels and key-hash prefixes only
- IT Glue documents API is partially undocumented: list-documents needs the second folder query (`filter[document-folder-id][ne]=null`); flexible-asset trait updates replace the whole traits object
- Attachments (images/files) upload as **base64 inside ordinary `application/vnd.api+json` JSON** — no multipart — via `POST /:resource/:id/relationships/attachments` with a nested `attachment: { content, file_name }` attribute; delete is a bulk body on the collection endpoint, not id-in-path (`src/tools/attachments.ts`)
