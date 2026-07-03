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
  isError?: boolean;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function failure(error: unknown): ToolResult {
  return { content: [{ type: "text", text: describeError(error) }], isError: true };
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
