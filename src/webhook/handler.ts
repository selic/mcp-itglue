/**
 * IT Glue webhook processing.
 *
 * IT Glue signs webhook payloads with HMAC-SHA256 (hex) in the
 * `x-itglue-webhook-signature` header. Payload shape:
 *
 *   {
 *     "event": "document.updated",
 *     "data": {
 *       "id": "123",
 *       "type": "documents",
 *       "attributes": { "name": "...", "organization-id": 1, ... }
 *     }
 *   }
 *
 * document.created / document.updated → re-index that document.
 * document.destroyed                  → drop it from the index.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { dropDocument, refreshDocument, type IndexerDeps } from "../vector/indexer.js";
import type { VectorIndex } from "../vector/store.js";

export interface WebhookPayload {
  event: string;
  data: {
    id: string | number;
    type?: string;
    attributes?: {
      name?: string;
      "organization-id"?: number;
      "organization-name"?: string;
      "resource-url"?: string;
      [key: string]: unknown;
    };
  };
}

export interface WebhookOutcome {
  event: string;
  document_id: string;
  action: "indexed" | "removed" | "skipped" | "error";
  message: string;
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex");
  const provided = Buffer.from(signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  if (provided.length !== wanted.length) return false;
  try {
    return timingSafeEqual(provided, wanted);
  } catch {
    return false;
  }
}

export function isWebhookPayload(value: unknown): value is WebhookPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WebhookPayload>;
  return (
    typeof candidate.event === "string" &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    candidate.data.id !== undefined
  );
}

/** Process one webhook event. Never throws; the outcome describes what happened. */
export async function processWebhookEvent(
  payload: WebhookPayload,
  deps: IndexerDeps | null,
  index: VectorIndex
): Promise<WebhookOutcome> {
  const documentId = String(payload.data.id);
  const base = { event: payload.event, document_id: documentId };

  if (payload.event === "document.destroyed") {
    try {
      return { ...base, action: "removed", message: dropDocument(index, documentId) };
    } catch (err) {
      return { ...base, action: "error", message: String(err) };
    }
  }

  if (payload.event === "document.created" || payload.event === "document.updated") {
    if (!deps) {
      return {
        ...base,
        action: "skipped",
        message: "No embedding provider configured — vector index not updated.",
      };
    }
    try {
      const attrs = payload.data.attributes ?? {};
      const message = await refreshDocument(deps, documentId, {
        title: attrs.name,
        organization_id:
          attrs["organization-id"] !== undefined ? String(attrs["organization-id"]) : undefined,
        organization_name: attrs["organization-name"],
        url: attrs["resource-url"] ?? undefined,
      });
      return { ...base, action: "indexed", message };
    } catch (err) {
      return { ...base, action: "error", message: `Failed to index ${documentId}: ${String(err)}` };
    }
  }

  return { ...base, action: "skipped", message: `Event "${payload.event}" is not handled.` };
}
