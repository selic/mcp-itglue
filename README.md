# mcp-itglue

An MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server for the [IT Glue](https://www.itglue.com/) API, built for MSPs that want AI assistants to read — and safely write — their documentation.

- **Documents & sections** — list, read, create, update, publish, delete
- **Flexible assets** — browse asset types and their fields, list/read/create/update/delete assets
- **Semantic vector search** — "how do I remove a backup agent" finds the Veeam decommissioning runbook, even when the words don't match (OpenAI or Azure OpenAI embeddings, local JSON index)
- **Role-based access control** — viewer / editor / admin bearer tokens decide which tools each session can even see
- **Bring your own key** — clients may supply their own IT Glue API key per session, so IT Glue's own permissions apply
- **Index freshness** — IT Glue webhook, post-write self-refresh, and a manual refresh endpoint
- **Transports** — stdio for local use, streamable HTTP for shared deployments; Docker image included

## Quick start (local, stdio)

```bash
npm install && npm run build
ITGLUE_API_KEY=ITG.xxxx node dist/index.js
```

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "itglue": {
      "command": "node",
      "args": ["/path/to/mcp-itglue/dist/index.js"],
      "env": { "ITGLUE_API_KEY": "ITG.xxxx" }
    }
  }
}
```

stdio always runs with the full tool surface — it is a local, single-user transport using your own key.

## HTTP deployment

```bash
ITGLUE_API_KEY=ITG.xxxx \
MCP_TOKENS_VIEWER="alice:$(openssl rand -hex 32)" \
MCP_TOKENS_EDITOR="automation:$(openssl rand -hex 32)" \
MCP_TOKENS_ADMIN="ops:$(openssl rand -hex 32)" \
node dist/index.js --transport http --port 3000
```

Or with Docker:

```bash
docker build -t mcp-itglue .
docker run --rm -p 3000:3000 \
  -e ITGLUE_API_KEY -e MCP_TOKENS_VIEWER -e MCP_TOKENS_EDITOR -e MCP_TOKENS_ADMIN \
  mcp-itglue
```

Endpoints:

| Route | Purpose |
|---|---|
| `POST/GET/DELETE /mcp` | MCP streamable-http endpoint |
| `GET /health` | Liveness probe |
| `POST /webhook/itglue` | IT Glue webhook → incremental index update |
| `POST /index/refresh` | Manual index refresh (shared secret or admin token) |

> Sessions are held in memory — run a single instance (or add sticky sessions) behind your load balancer.

## Access control

### Role tokens

Three env vars hold comma-separated `label:token` lists:

```bash
MCP_TOKENS_VIEWER="alice:tokA,bob:tokB"   # read-only tools
MCP_TOKENS_EDITOR="hatz:tokC"             # + create/update/publish, delete section
MCP_TOKENS_ADMIN="ops:tokD"               # + delete documents / flexible assets
```

Clients authenticate with `Authorization: Bearer <token>`. The label appears in the audit log (`[rbac] session … for alice (viewer)`) and lets you revoke one person's token without rotating everyone's.

Tools a role cannot use are **not registered** for that session — a viewer doesn't even see `itglue_create_document` in `tools/list` — and a runtime guard re-checks the role on every call as defense in depth. Session ids never carry privilege: every request re-authenticates, and presenting a different principal against an existing session returns 403.

If **no** tokens are configured, the server runs in dev mode: all requests get admin access and a loud startup warning. Don't do this in production.

### Bring your own IT Glue key (BYOK)

Clients may send their own IT Glue API key in the `x-itglue-api-key` header on the initialize request. The session then talks to IT Glue with **that** key and gets the full tool surface — IT Glue's own key permissions are the effective access control. `CLIENT_ITGLUE_KEYS` controls the policy:

| Value | Behavior |
|---|---|
| `with-token` (default) | BYOK allowed, but a valid bearer token is still required — protects your server from being an open proxy |
| `open` | An IT Glue key alone authenticates (trusted networks / local use) |
| `disabled` | The header is rejected; only the server-wide key is used |

With BYOK enabled the server-wide `ITGLUE_API_KEY` becomes optional: sessions without a client key are rejected with a clear error. Client keys are never logged; sessions are bound to a SHA-256 hash of the key and audit-labeled `byok:<hash-prefix>`.

## Tools

| Tool | Tier |
|---|---|
| `itglue_list_organizations`, `itglue_get_organization` | read |
| `itglue_list_documents`, `itglue_get_document` | read |
| `itglue_list_document_sections`, `itglue_get_document_section` | read |
| `itglue_list_flexible_asset_types`, `itglue_get_flexible_asset_type` | read |
| `itglue_list_flexible_assets`, `itglue_get_flexible_asset` | read |
| `itglue_vector_search`, `itglue_vector_index_status` | read |
| `itglue_create_document`, `itglue_update_document`, `itglue_publish_document` | write |
| `itglue_create_document_section`, `itglue_update_document_section` | write |
| `itglue_delete_document_section` † | write |
| `itglue_create_flexible_asset`, `itglue_update_flexible_asset` | write |
| `itglue_build_vector_index` | write |
| `itglue_delete_documents` | destructive |
| `itglue_delete_flexible_asset` | destructive |

Viewer = read. Editor = read + write. Admin = everything.
† Permanent, but editor-tier: editors need it to restructure documents and can already blank section content via update.

Vector tools appear only when an embedding provider is configured.

## Vector search

Set `OPENAI_API_KEY` (or `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`, where `EMBEDDING_MODEL` is your deployment name), then run `itglue_build_vector_index` per organization. The index is a JSON file at `VECTOR_INDEX_PATH` (default `./vector-index.json`) — on ephemeral hosts, point it at a persistent volume.

The index stays fresh three ways:

1. **IT Glue webhook** — in IT Glue, webhooks are sent by **Workflows** (Admin → Workflows): add a *Document* trigger (created/updated) with a *Webhook* action. Workflow actions cannot send custom headers, so put the shared secret in the URL:

   ```
   https://<host>/webhook/itglue?secret=<ITGLUE_WEBHOOK_SECRET>
   ```

   and use a JSON payload template like:

   | Key | Value |
   |---|---|
   | `event` | `[trigger_name]` |
   | `resource_url` | `[resource_url]` |
   | `resource_name` | `[resource_name]` |
   | `organization_name` | `[organization_name]` |

   The document id is parsed from `resource_url`; the trigger name maps to created/updated/deleted by keyword. Classic JSON:API-style payloads with an `x-itglue-webhook-signature` HMAC-SHA256 header are also accepted.
2. **Self-refresh** — documents created/updated/published/deleted through this server's tools are re-indexed automatically in the background.
3. **Manual refresh** — `POST /index/refresh` with `Authorization: Bearer <ITGLUE_WEBHOOK_SECRET>` (or an `x-refresh-secret` header, or an admin token). Body `{"document_id": "123"}` refreshes one document; an empty body re-crawls every indexed organization. Returns `202` and processes in the background.

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `ITGLUE_API_KEY` | — | Server-wide IT Glue API key |
| `ITGLUE_REGION` | `us` | `us`, `eu`, or `au` |
| `ITGLUE_BASE_URL` | per region | Override the API base URL |
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` | `3000` | HTTP port |
| `MCP_TOKENS_VIEWER/EDITOR/ADMIN` | — | `label:token,label:token` per role |
| `CLIENT_ITGLUE_KEYS` | `with-token` | BYOK policy: `disabled`, `with-token`, `open` |
| `ITGLUE_WEBHOOK_SECRET` | — | Webhook signature + `/index/refresh` secret |
| `VECTOR_INDEX_PATH` | `./vector-index.json` | Vector index file |
| `OPENAI_API_KEY` | — | Enables vector search (OpenAI) |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | — | Enables vector search (Azure OpenAI) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model / Azure deployment |

CLI flags `--transport`, `--port`, `--region`, `--base-url` override the environment. Run `mcp-itglue --help` for details.

## Notes & limits

- IT Glue rate limit: 3000 requests / 5 minutes per key.
- The IT Glue documents API is only partially documented; document/section endpoints follow observed API behavior.
- Flexible-asset trait updates replace the whole traits object — the update tool's description warns the model to send all traits back.
- IT Glue has no user impersonation: a given API key always acts as itself. RBAC here controls what *tool calls* a session may make; BYOK delegates to IT Glue's own key permissions.

## Development

```bash
npm install
npm run dev          # stdio via tsx
npm run dev:http     # http via tsx
npm test             # vitest
npm run build        # tsc → dist/
```

## License

[MIT](LICENSE)
