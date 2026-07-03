/**
 * IT Glue webhook processing.
 *
 * Two inbound formats are accepted:
 *
 * 1. JSON:API-style (HMAC-SHA256 hex signature in `x-itglue-webhook-signature`):
 *
 *      {
 *        "event": "document.updated",
 *        "data": { "id": "123", "type": "documents", "attributes": { … } }
 *      }
 *
 * 2. IT Glue **Workflows** webhook actions (Admin → Workflows → Webhook).
 *    Workflows send a user-defined JSON template and cannot set custom
 *    headers, so authentication uses a `?secret=` URL parameter instead of a
 *    signature. Recommended payload template:
 *
 *      event           [trigger_name]
 *      resource_url    [resource_url]
 *      resource_name   [resource_name]
 *      organization_name [organization_name]
 *
 *    The document id is extracted from the resource URL (…/docs/<id>), and
 *    the trigger name is mapped to created/updated/destroyed by keyword.
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

const DOC_URL_PATTERN = /\/docs\/(\d+)/;

/**
 * Accept either the JSON:API-style payload or an IT Glue Workflows webhook
 * template, normalizing both to WebhookPayload. Returns null when no document
 * reference can be found.
 */
export function normalizeWebhookBody(body: unknown): WebhookPayload | null {
  if (isWebhookPayload(body)) return body;
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  // Workflow templates are flat key/value objects; find the document URL in
  // any string field so the exact key name doesn't matter.
  let url: string | undefined;
  let documentId: string | undefined;
  for (const value of Object.values(record)) {
    if (typeof value !== "string") continue;
    const match = DOC_URL_PATTERN.exec(value);
    if (match?.[1]) {
      url = value;
      documentId = match[1];
      break;
    }
  }
  if (!documentId) return null;

  const rawEvent =
    typeof record.event === "string"
      ? record.event
      : typeof record.trigger_name === "string"
        ? record.trigger_name
        : "";
  const event = /delet|destroy/i.test(rawEvent)
    ? "document.destroyed"
    : /creat/i.test(rawEvent)
      ? "document.created"
      : "document.updated";

  return {
    event,
    data: {
      id: documentId,
      type: "documents",
      attributes: {
        name: typeof record.resource_name === "string" ? record.resource_name : undefined,
        "organization-name":
          typeof record.organization_name === "string" ? record.organization_name : undefined,
        "resource-url": url,
      },
    },
  };
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
