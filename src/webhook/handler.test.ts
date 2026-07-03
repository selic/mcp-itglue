import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorIndex } from "../vector/store.js";
import {
  isWebhookPayload,
  normalizeWebhookBody,
  processWebhookEvent,
  verifyWebhookSignature,
} from "./handler.js";

const SECRET = "shh";
const sign = (body: string): string => createHmac("sha256", SECRET).update(body, "utf-8").digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ event: "document.updated" });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a wrong, malformed, or missing signature", () => {
    const body = "{}";
    expect(verifyWebhookSignature(body, sign(body + "x"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "zz-not-hex", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });
});

describe("isWebhookPayload", () => {
  it("validates the required fields", () => {
    expect(isWebhookPayload({ event: "document.updated", data: { id: "1" } })).toBe(true);
    expect(isWebhookPayload({ event: "document.updated" })).toBe(false);
    expect(isWebhookPayload({ data: { id: "1" } })).toBe(false);
    expect(isWebhookPayload(null)).toBe(false);
  });
});

describe("normalizeWebhookBody", () => {
  it("passes through JSON:API-style payloads unchanged", () => {
    const payload = { event: "document.updated", data: { id: "1" } };
    expect(normalizeWebhookBody(payload)).toBe(payload);
  });

  it("normalizes an IT Glue workflow template using the document URL", () => {
    const result = normalizeWebhookBody({
      event: "Document Updated",
      resource_url: "https://example.itglue.com/6255696/docs/13017464",
      resource_name: "Veeam runbook",
      organization_name: "Example Org",
    });
    expect(result).toEqual({
      event: "document.updated",
      data: {
        id: "13017464",
        type: "documents",
        attributes: {
          name: "Veeam runbook",
          "organization-name": "Example Org",
          "resource-url": "https://example.itglue.com/6255696/docs/13017464",
        },
      },
    });
  });

  it("finds the document URL under any key and maps trigger keywords", () => {
    expect(
      normalizeWebhookBody({ text: "Doc Created: https://x.itglue.com/1/docs/42", event: "Document Created" })?.event
    ).toBe("document.created");
    expect(
      normalizeWebhookBody({ trigger_name: "Document Deleted", url: "https://x.itglue.com/1/docs/42" })?.event
    ).toBe("document.destroyed");
    expect(normalizeWebhookBody({ u: "https://x.itglue.com/1/docs/42" })?.event).toBe("document.updated");
  });

  it("returns null when no document reference exists", () => {
    expect(normalizeWebhookBody({ event: "Document Updated", name: "no url here" })).toBeNull();
    expect(normalizeWebhookBody("not an object")).toBeNull();
    expect(normalizeWebhookBody(null)).toBeNull();
  });
});

describe("processWebhookEvent", () => {
  let dir: string;
  let index: VectorIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wh-"));
    index = new VectorIndex(join(dir, "index.json"));
    index.upsert({
      document_id: "42",
      organization_id: "1",
      organization_name: "Org",
      title: "Doc",
      text: "",
      url: null,
      embedding: [1],
      indexed_at: "2026-01-01T00:00:00Z",
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes the document on document.destroyed", async () => {
    const outcome = await processWebhookEvent(
      { event: "document.destroyed", data: { id: "42" } },
      null,
      index
    );
    expect(outcome.action).toBe("removed");
    expect(index.count()).toBe(0);
  });

  it("skips created/updated when no embedder is configured", async () => {
    const outcome = await processWebhookEvent(
      { event: "document.updated", data: { id: "42" } },
      null,
      index
    );
    expect(outcome.action).toBe("skipped");
  });

  it("skips unknown events", async () => {
    const outcome = await processWebhookEvent(
      { event: "password.updated", data: { id: "42" } },
      null,
      index
    );
    expect(outcome.action).toBe("skipped");
    expect(index.count()).toBe(1);
  });
});
