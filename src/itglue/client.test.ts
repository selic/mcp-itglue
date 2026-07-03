import { describe, expect, it } from "vitest";
import {
  buildQuery,
  bulkDeletePayload,
  describeError,
  fromResource,
  ITGlueApiError,
  toResourcePayload,
} from "./client.js";

describe("fromResource", () => {
  it("converts top-level attribute keys to snake_case but leaves nested objects alone", () => {
    const resource = {
      id: "1",
      type: "flexible-assets",
      attributes: {
        "organization-id": 5,
        traits: { "ssid-name": "Corp" },
      },
    };
    const result = fromResource(resource);
    expect(result).toEqual({
      id: "1",
      type: "flexible-assets",
      organization_id: 5,
      traits: { "ssid-name": "Corp" },
    });
  });
});

describe("toResourcePayload", () => {
  it("kebab-cases keys and drops undefined values", () => {
    expect(toResourcePayload("documents", { organization_id: 1, name: "X", nope: undefined })).toEqual({
      data: { type: "documents", attributes: { "organization-id": 1, name: "X" } },
    });
  });

  it("includes the id when provided", () => {
    expect(toResourcePayload("documents", { name: "X" }, "9").data.id).toBe("9");
  });
});

describe("buildQuery", () => {
  it("builds filter, pagination, sort, and raw params", () => {
    expect(
      buildQuery({
        filters: { name: "abc", organization_id: 7, skipped: undefined },
        pageNumber: 2,
        pageSize: 50,
        sort: "-updated_at",
        raw: { "filter[document-folder-id][ne]": "null" },
      })
    ).toEqual({
      "filter[name]": "abc",
      "filter[organization-id]": 7,
      "page[number]": 2,
      "page[size]": 50,
      sort: "-updated_at",
      "filter[document-folder-id][ne]": "null",
    });
  });
});

describe("bulkDeletePayload", () => {
  it("wraps each id as a resource", () => {
    expect(bulkDeletePayload("documents", [1, 2])).toEqual({
      data: [
        { type: "documents", attributes: { id: 1 } },
        { type: "documents", attributes: { id: 2 } },
      ],
    });
  });
});

describe("describeError", () => {
  it("maps common statuses to actionable messages", () => {
    expect(describeError(new ITGlueApiError("x", 401))).toContain("authentication failed");
    expect(describeError(new ITGlueApiError("x", 404))).toContain("not found");
    expect(describeError(new ITGlueApiError("x", 429))).toContain("rate limit");
    expect(describeError(new ITGlueApiError("x", 422, "name is required"))).toContain("name is required");
    expect(describeError(new ITGlueApiError("x", 503))).toContain("server error");
    expect(describeError(new Error("boom"))).toContain("boom");
  });
});
