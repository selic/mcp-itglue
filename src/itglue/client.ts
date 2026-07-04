/**
 * Minimal IT Glue REST client (JSON:API) built on the global fetch API.
 *
 * - Authentication: `x-api-key` header.
 * - Media type: `application/vnd.api+json`.
 * - Attribute keys are kebab-case on the wire; we expose snake_case (top
 *   level only, so user-defined keys like flexible-asset traits survive).
 * - Rate limit: IT Glue allows 3000 requests per 5 minutes per key.
 */

import type { JsonApiDocument, JsonApiResource, Page } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

// ── Key conversion ───────────────────────────────────────────────

const kebabToSnake = (key: string): string => key.replace(/-/g, "_");
const snakeToKebab = (key: string): string => key.replace(/_/g, "-");

export function fromResource<T extends Record<string, unknown>>(resource: JsonApiResource): T {
  const out: Record<string, unknown> = { id: resource.id, type: resource.type };
  for (const [key, value] of Object.entries(resource.attributes ?? {})) {
    out[kebabToSnake(key)] = value;
  }
  return out as T;
}

export function toResourcePayload(
  type: string,
  attributes: Record<string, unknown>,
  id?: string
): { data: { type: string; id?: string; attributes: Record<string, unknown> } } {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) wire[snakeToKebab(key)] = value;
  }
  return { data: { type, ...(id ? { id } : {}), attributes: wire } };
}

// ── Query helpers ────────────────────────────────────────────────

export interface QueryOptions {
  filters?: Record<string, string | number | undefined>;
  pageNumber?: number;
  pageSize?: number;
  sort?: string;
  /** Extra raw query params appended verbatim (e.g. "filter[document-folder-id][ne]"). */
  raw?: Record<string, string | number>;
}

export function buildQuery(options: QueryOptions = {}): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(options.filters ?? {})) {
    if (value !== undefined) params[`filter[${snakeToKebab(key)}]`] = value;
  }
  if (options.pageNumber !== undefined) params["page[number]"] = options.pageNumber;
  if (options.pageSize !== undefined) params["page[size]"] = options.pageSize;
  if (options.sort) params.sort = options.sort;
  Object.assign(params, options.raw ?? {});
  return params;
}

// ── Errors ───────────────────────────────────────────────────────

export class ITGlueApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "ITGlueApiError";
  }
}

/** Turn any error into a message suitable for returning to the model/user. */
export function describeError(error: unknown): string {
  if (error instanceof ITGlueApiError) {
    const detail = error.detail ? ` ${error.detail}` : "";
    switch (error.status) {
      case 400:
        return `Error: Bad request.${detail} Check the parameters.`;
      case 401:
        return "Error: IT Glue authentication failed — the API key is invalid or revoked.";
      case 403:
        return `Error: Permission denied.${detail} The API key may not have access to this resource.`;
      case 404:
        return "Error: Resource not found. Verify the ID is correct.";
      case 422:
        return `Error: Validation failed.${detail}`;
      case 429:
        return "Error: IT Glue rate limit exceeded (3000 requests / 5 minutes). Wait before retrying.";
      default:
        if (error.status && error.status >= 500) {
          return `Error: IT Glue server error (${error.status}). Try again later.`;
        }
        return `Error: IT Glue API request failed${error.status ? ` with status ${error.status}` : ""}.${detail}`;
    }
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Error: IT Glue API request timed out. Try again.";
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

// ── Client ───────────────────────────────────────────────────────

export interface ITGlueClientOptions {
  apiKey: string;
  baseUrl: string;
}

export class ITGlueClient {
  constructor(private readonly options: ITGlueClientOptions) {}

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    query?: Record<string, string | number>,
    body?: unknown
  ): Promise<JsonApiDocument | null> {
    const url = new URL(this.options.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.options.apiKey,
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw err;
      throw new ITGlueApiError(
        `Could not reach the IT Glue API at ${this.options.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.ok) {
      let detail: string | undefined;
      try {
        const errBody = (await response.json()) as {
          errors?: Array<{ title?: string; detail?: string }>;
        };
        detail = errBody.errors?.[0]?.detail ?? errBody.errors?.[0]?.title;
      } catch {
        // non-JSON error body — ignore
      }
      throw new ITGlueApiError(
        `IT Glue API responded with ${response.status}`,
        response.status,
        detail
      );
    }

    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as JsonApiDocument;
    } catch {
      return null;
    }
  }

  async getOne<T extends Record<string, unknown>>(
    path: string,
    query?: Record<string, string | number>
  ): Promise<T> {
    const doc = await this.request("GET", path, query);
    if (!doc || Array.isArray(doc.data)) {
      throw new ITGlueApiError("Expected a single resource in the API response");
    }
    return fromResource<T>(doc.data);
  }

  async getMany<T extends Record<string, unknown>>(
    path: string,
    query?: Record<string, string | number>
  ): Promise<Page<T>> {
    const doc = await this.request("GET", path, query);
    const data = doc?.data ?? [];
    const resources = Array.isArray(data) ? data : [data];
    const meta = doc?.meta ?? {};
    return {
      items: resources.map((r) => fromResource<T>(r)),
      totalCount: meta["total-count"] ?? resources.length,
      pageNumber: meta["current-page"] ?? 1,
      hasMore: (meta["next-page"] ?? null) !== null,
    };
  }

  /**
   * Crawl every page of a collection (page[size]=1000) up to maxItems.
   * Used for client-side name filtering: IT Glue's filter[name] is exact-match
   * on organizations/flexible-asset-types, treats commas as value separators,
   * and is ignored outright by the documents relationship endpoint — so
   * partial matching has to happen here.
   */
  async getAllPages<T extends Record<string, unknown>>(
    path: string,
    query?: Record<string, string | number>,
    maxItems = 5000
  ): Promise<{ items: T[]; scannedAll: boolean }> {
    const items: T[] = [];
    let pageNumber = 1;
    for (;;) {
      const page = await this.getMany<T>(path, {
        ...query,
        "page[number]": pageNumber,
        "page[size]": Math.min(1000, maxItems),
      });
      items.push(...page.items);
      if (!page.hasMore) return { items, scannedAll: true };
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), scannedAll: false };
      pageNumber += 1;
    }
  }

  async create<T extends Record<string, unknown>>(
    path: string,
    type: string,
    attributes: Record<string, unknown>
  ): Promise<T> {
    const doc = await this.request("POST", path, undefined, toResourcePayload(type, attributes));
    return this.single<T>(doc, "create");
  }

  async update<T extends Record<string, unknown>>(
    path: string,
    type: string,
    attributes: Record<string, unknown>,
    id?: string
  ): Promise<T> {
    const doc = await this.request("PATCH", path, undefined, toResourcePayload(type, attributes, id));
    return this.single<T>(doc, "update");
  }

  /** PATCH an action endpoint (e.g. /documents/:id/publish) — response body optional. */
  async patchAction(path: string): Promise<void> {
    await this.request("PATCH", path);
  }

  async destroy(path: string, body?: unknown): Promise<void> {
    await this.request("DELETE", path, undefined, body);
  }

  private single<T extends Record<string, unknown>>(
    doc: JsonApiDocument | null,
    operation: string
  ): T {
    if (!doc) throw new ITGlueApiError(`Empty API response for ${operation}`);
    const data = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!data) throw new ITGlueApiError(`Empty API response for ${operation}`);
    return fromResource<T>(data);
  }
}

/** Bulk-delete payload: DELETE /documents with a list of resource ids. */
export function bulkDeletePayload(
  type: string,
  ids: number[]
): { data: Array<{ type: string; attributes: { id: number } }> } {
  return { data: ids.map((id) => ({ type, attributes: { id } })) };
}
