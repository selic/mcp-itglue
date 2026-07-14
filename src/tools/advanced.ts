/**
 * Advanced (opt-in) toolset — an escape hatch for the long tail of the
 * IT Glue API that the curated tools don't wrap.
 *
 *  - itglue_find_endpoint: lexical search over a curated endpoint catalog.
 *  - itglue_get: read-only GET passthrough for any endpoint, except password
 *    resources, which are hard-blocked so credential values never enter the
 *    model context.
 *
 * Not registered by default — enable with ITGLUE_ADVANCED_TOOLSET=true or
 * --advanced. Read-only by construction (ITGlueClient.rawGet is verb-locked).
 */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import {
  ITGlueClient,
  buildQuery,
  fromResource,
} from "../itglue/client.js";
import { ITGLUE_ENDPOINTS, type EndpointDoc } from "../reference/itglue-endpoints.js";
import { clip } from "../format.js";
import {
  failure,
  json,
  pageNumberField,
  pageSizeField,
  responseFormatField,
  text,
} from "./shared.js";

/** Normalize a user/model-supplied path to a bare API path. */
export function normalizeApiPath(raw: string): string {
  let s = raw.trim().replace(/^https?:\/\/[^/]+/i, "");
  s = s.split("?")[0] ?? s; // drop any inline query — use the structured params
  if (!s.startsWith("/")) s = `/${s}`;
  return s;
}

/**
 * Password resources are intentionally unreachable: matches /passwords as a
 * path segment anywhere (index, /passwords/{id}, nested relationships), but
 * not /password_categories.
 */
export function isDeniedPath(path: string): boolean {
  return /(^|\/)passwords(\/|$)/i.test(path);
}

const PASSWORD_DENIED_MESSAGE =
  "password resources are intentionally not reachable via itglue_get — " +
  "credential values must never enter the model context. Use the IT Glue UI.";

// Lexical endpoint search — kept in sync with mcp-connectwise-psa src/tools/advanced.ts.

const STOP = new Set(["the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "by", "with", "how", "do", "i", "get", "list", "all", "itglue", "it", "glue"]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Lexical relevance score of an endpoint for a set of query tokens. */
function scoreEndpoint(doc: EndpointDoc, tokens: string[]): number {
  const strong = `${doc.path} ${doc.summary}`.toLowerCase();
  const medium = `${doc.module} ${doc.keyParams ?? ""} ${doc.commonFields ?? ""}`.toLowerCase();
  const weak = `${doc.notes ?? ""} ${doc.coveredBy ?? ""}`.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (strong.includes(t)) score += 3;
    else if (medium.includes(t)) score += 2;
    else if (weak.includes(t)) score += 1;
  }
  return score;
}

/** Rank the catalog for a query. Pure — exported for tests. */
export function findEndpoints(query: string, topK = 5): EndpointDoc[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  return ITGLUE_ENDPOINTS.map((doc) => ({ doc, score: scoreEndpoint(doc, tokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.doc);
}

function endpointBlock(d: EndpointDoc): string {
  const lines = [`### ${d.path}  \`${d.methods}\`  _(${d.module})_`, d.summary];
  if (d.keyParams) lines.push(`- **Filters**: ${d.keyParams}`);
  if (d.commonFields) lines.push(`- **Fields**: ${d.commonFields}`);
  if (d.coveredBy) lines.push(`- **Prefer the curated tool(s)**: ${d.coveredBy}`);
  if (d.notes) lines.push(`- _${d.notes}_`);
  return lines.join("\n");
}

export function registerAdvancedTools(reg: ToolRegistrar, client: ITGlueClient): void {
  reg.register(
    {
      name: "itglue_find_endpoint",
      title: "Find an IT Glue API Endpoint",
      description:
        "Discover which IT Glue REST endpoint (and its filter params) fits a task — search a curated " +
        "catalog by keywords. Use the result with itglue_get, or prefer the named curated tool when one exists.",
      inputSchema: {
        query: z.string().min(1).describe('What you want to do (e.g. "certificate expirations", "device interfaces")'),
        top_k: z.number().int().positive().max(20).default(5).describe("How many endpoints to return"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { query: string; top_k: number; response_format: "markdown" | "json" }) => {
      const hits = findEndpoints(args.query, args.top_k);
      if (hits.length === 0) return text(`No endpoint matched "${args.query}". Try broader keywords (module or resource name).`);
      if (args.response_format === "json") return text(clip(json(hits)));
      const lines = [`# Endpoints for "${args.query}"`, "", ...hits.map(endpointBlock), "", "Call one with **itglue_get** (read-only)."];
      return text(clip(lines.join("\n\n")));
    }
  );

  reg.register(
    {
      name: "itglue_get",
      title: "Call any IT Glue GET Endpoint",
      description:
        "Read-only GET for any IT Glue REST path (e.g. /configurations or /organizations/123/relationships/contacts). " +
        "Filters are EXACT match, snake_case keys (e.g. {\"organization_id\": 123}); operators go through raw_params " +
        '(e.g. {"filter[expiration-date][lt]": "2026-12-31"}). Password resources are blocked. ' +
        "Discover paths with itglue_find_endpoint.",
      inputSchema: {
        path: z.string().min(1).describe('API path, e.g. "/expirations" or "/organizations/123/relationships/domains"'),
        filters: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('filter[...] params, snake_case keys, EXACT match, e.g. {"organization_id": 123}'),
        sort: z.string().optional().describe('Sort field; prefix with "-" for descending, e.g. "-updated_at"'),
        include: z.string().optional().describe("Comma-separated related resources to sideload"),
        raw_params: z
          .record(z.string(), z.string())
          .optional()
          .describe('Verbatim query params for operators, e.g. {"filter[document-folder-id][ne]": "null"}'),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      path: string;
      filters?: Record<string, string | number>;
      sort?: string;
      include?: string;
      raw_params?: Record<string, string>;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const path = normalizeApiPath(args.path);
        if (isDeniedPath(path)) return failure(new Error(PASSWORD_DENIED_MESSAGE));
        const params = { ...(args.raw_params ?? {}), ...(args.include ? { include: args.include } : {}) };
        for (const [key, value] of Object.entries(params)) {
          if (/show[-_]password/i.test(`${key}=${value}`)) {
            return failure(new Error(PASSWORD_DENIED_MESSAGE));
          }
        }
        const doc = await client.rawGet(
          path,
          buildQuery({
            filters: args.filters,
            pageNumber: args.page_number,
            pageSize: args.page_size,
            sort: args.sort,
            raw: params,
          })
        );
        const data = doc?.data ?? [];
        const resources = Array.isArray(data) ? data : [data];
        const items = resources.map((r) => fromResource(r));
        const included = (doc?.included ?? []).map((r) => fromResource(r));
        const meta = doc?.meta ?? {};
        const body: Record<string, unknown> = Array.isArray(data) ? { items } : { item: items[0] ?? null };
        if (included.length > 0) body.included = included;
        const footer: string[] = [];
        if (meta["total-count"] !== undefined) {
          footer.push(`Page ${meta["current-page"] ?? args.page_number} | ${meta["total-count"]} total`);
          if ((meta["next-page"] ?? null) !== null) footer.push(`More available — request page_number: ${(meta["current-page"] ?? args.page_number) + 1}`);
        }
        const count = Array.isArray(data) ? `${items.length} record(s)` : "1 record";
        const rendered = `GET ${path} — ${count}\n\n${json(body)}${footer.length ? `\n\n---\n${footer.join("\n")}` : ""}`;
        return text(clip(rendered, "Narrow with filters, or page through with page_number."));
      } catch (error) {
        return failure(error);
      }
    }
  );
}
