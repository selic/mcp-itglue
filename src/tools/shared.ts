/** Shared zod fragments and result helpers for tool implementations. */

import { z } from "zod";
import { describeError } from "../itglue/client.js";

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
