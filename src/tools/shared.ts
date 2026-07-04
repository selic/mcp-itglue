/** Shared zod fragments and result helpers for tool implementations. */

import { z } from "zod";
import { describeError } from "../itglue/client.js";
import { htmlToText } from "../format.js";

export const responseFormatField = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Output format: human-readable markdown (default) or structured JSON");

export const pageNumberField = z
  .number()
  .int()
  .positive()
  .default(1)
  .describe("Page number (default 1)");

export const pageSizeField = z
  .number()
  .int()
  .positive()
  .max(1000)
  .default(50)
  .describe("Results per page (default 50, max 1000)");

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Text plus structuredContent — required for every non-error result of a tool that declares outputSchema. */
export function structured(value: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: value }], structuredContent: data };
}

export function failure(error: unknown): ToolResult {
  return { content: [{ type: "text", text: describeError(error) }], isError: true };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ── Output schemas ─────────────────────────────────────────────
// Deliberately loose (records, not per-field shapes): IT Glue attribute sets
// vary by account and flexible-asset traits are user-defined, so a strict
// schema would make the server reject its own valid responses.

/** Output shape shared by all list tools. */
export const pageOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  page_number: z.number(),
  has_more: z.boolean(),
};

/** Output shape shared by all single-resource get tools. */
export const itemOutputShape = {
  item: z.record(z.string(), z.unknown()),
};

/** structuredContent for a page of results (matches pageOutputShape). */
export function pageData(page: {
  items: Array<Record<string, unknown>>;
  totalCount: number;
  pageNumber: number;
  hasMore: boolean;
}): Record<string, unknown> {
  return {
    items: page.items,
    total_count: page.totalCount,
    page_number: page.pageNumber,
    has_more: page.hasMore,
  };
}

/** structuredContent for an empty page (matches pageOutputShape). */
export function emptyPageData(pageNumber: number): Record<string, unknown> {
  return { items: [], total_count: 0, page_number: pageNumber, has_more: false };
}

/** Case-insensitive substring match on an item's name. */
export function nameMatches(item: Record<string, unknown>, term: string): boolean {
  return String(item.name ?? "")
    .toLowerCase()
    .includes(term.toLowerCase());
}

/** Slice a locally-filtered result set into the requested page. */
export function paginate<T>(
  items: T[],
  pageNumber: number,
  pageSize: number
): { items: T[]; totalCount: number; pageNumber: number; hasMore: boolean } {
  const start = (pageNumber - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    totalCount: items.length,
    pageNumber,
    hasMore: start + pageSize < items.length,
  };
}

const TRAIT_PREVIEW_CHARS = 200;

/**
 * Bound trait values for list output: HTML (e.g. report blobs written by
 * backup integrations) becomes plain text, and long values are truncated.
 * Full raw traits stay available via itglue_get_flexible_asset.
 */
export function previewTraits(
  traits: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!traits) return traits;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(traits)) {
    if (typeof value === "string") {
      const plain = /<[a-zA-Z!/][^>]*>/.test(value) ? htmlToText(value) : value;
      out[key] =
        plain.length > TRAIT_PREVIEW_CHARS ? `${plain.slice(0, TRAIT_PREVIEW_CHARS)}…` : plain;
    } else if (value !== null && typeof value === "object") {
      const json = JSON.stringify(value);
      out[key] = json.length > TRAIT_PREVIEW_CHARS ? `${json.slice(0, TRAIT_PREVIEW_CHARS)}…` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Appended to text output when a name scan hit the crawl cap. */
export function scanCapNote(scannedAll: boolean): string {
  return scannedAll
    ? ""
    : "\n\nNote: the name search scanned only the first 5000 records — narrow other filters if the target is missing.";
}

/**
 * Project an object to the named keys, dropping absent ones. List tools use
 * this to keep structuredContent items at summary size — full attribute sets
 * blow past client token caps at default page sizes (a 50-organization page
 * was 65k chars); the complete record stays available via the get tools.
 * `undefined` is skipped; `null` is kept (it is a real API value).
 */
export function pick(
  obj: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}
