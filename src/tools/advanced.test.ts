import { describe, expect, it } from "vitest";
import { findEndpoints, isDeniedPath, normalizeApiPath, registerAdvancedTools } from "./advanced.js";
import type { ToolRegistrar, ToolSpec } from "../auth/roles.js";
import type { ITGlueClient } from "../itglue/client.js";
import { loadConfig } from "../config.js";

describe("normalizeApiPath", () => {
  it("strips a full regional URL down to the path", () => {
    expect(normalizeApiPath("https://api.itglue.com/expirations")).toBe("/expirations");
    expect(normalizeApiPath("https://api.eu.itglue.com/organizations/1")).toBe("/organizations/1");
  });
  it("keeps a bare path and adds a leading slash", () => {
    expect(normalizeApiPath("configurations")).toBe("/configurations");
    expect(normalizeApiPath("/configurations")).toBe("/configurations");
  });
  it("drops an inline query string", () => {
    expect(normalizeApiPath("/expirations?filter[organization-id]=1")).toBe("/expirations");
  });
});

describe("isDeniedPath", () => {
  it("denies password resources everywhere in the path", () => {
    expect(isDeniedPath("/passwords")).toBe(true);
    expect(isDeniedPath("/passwords/42")).toBe(true);
    expect(isDeniedPath("/organizations/1/relationships/passwords")).toBe(true);
  });
  it("allows password_categories (metadata only)", () => {
    expect(isDeniedPath("/password_categories")).toBe(false);
  });
});

describe("findEndpoints", () => {
  it("ranks the right endpoint for a keyword query", () => {
    expect(findEndpoints("expirations certificates", 3)[0]?.path).toBe("/expirations");
    expect(findEndpoints("configurations devices", 3)[0]?.path).toBe("/configurations");
  });
  it("matches on summary text, not just the path", () => {
    const paths = findEndpoints("registrar domain expiry", 5).map((e) => e.path);
    expect(paths).toContain("/domains");
  });
  it("surfaces the query grammar doc for syntax questions", () => {
    const paths = findEndpoints("filter syntax exact match", 5).map((e) => e.path);
    expect(paths).toContain("(query grammar)");
  });
  it("returns nothing for an empty/stopword-only query", () => {
    expect(findEndpoints("", 5)).toEqual([]);
    expect(findEndpoints("how do i get the", 5)).toEqual([]);
  });
  it("respects top_k", () => {
    expect(findEndpoints("organization", 2).length).toBeLessThanOrEqual(2);
  });
});

describe("itglue_get handler", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;

  function capture(client: Partial<ITGlueClient>): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const reg = {
      register(spec: ToolSpec, handler: Handler) {
        handlers.set(spec.name, handler);
      },
    } as unknown as ToolRegistrar;
    registerAdvancedTools(reg, client as ITGlueClient);
    return handlers;
  }

  const defaults = { page_number: 1, page_size: 50, response_format: "markdown" };

  it("rejects password paths without calling the client", async () => {
    let called = false;
    const handlers = capture({
      rawGet: async () => {
        called = true;
        return null;
      },
    });
    const result = await handlers.get("itglue_get")!({ ...defaults, path: "/passwords" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/password resources/);
    expect(called).toBe(false);
  });

  it("rejects show_password in raw_params", async () => {
    const handlers = capture({ rawGet: async () => null });
    const result = await handlers.get("itglue_get")!({
      ...defaults,
      path: "/organizations",
      raw_params: { show_password: "true" },
    });
    expect(result.isError).toBe(true);
  });

  it("converts snake_case filters to kebab-case filter params", async () => {
    let seenQuery: Record<string, string | number> | undefined;
    const handlers = capture({
      rawGet: async (_path: string, query?: Record<string, string | number>) => {
        seenQuery = query;
        return { data: [] };
      },
    });
    const result = await handlers.get("itglue_get")!({
      ...defaults,
      path: "/configurations",
      filters: { organization_id: 123 },
      include: "configuration_interfaces",
    });
    expect(result.isError).toBeUndefined();
    expect(seenQuery).toMatchObject({
      "filter[organization-id]": 123,
      include: "configuration_interfaces",
      "page[number]": 1,
      "page[size]": 50,
    });
  });

  it("converts response attribute keys to snake_case and reports the count", async () => {
    const handlers = capture({
      rawGet: async () => ({
        data: [
          { id: "1", type: "expirations", attributes: { "expiration-date": "2026-08-01" } },
        ],
        meta: { "current-page": 1, "next-page": 2, "total-count": 51 },
      }),
    });
    const result = await handlers.get("itglue_get")!({ ...defaults, path: "/expirations" });
    expect(result.content[0]!.text).toContain("1 record(s)");
    expect(result.content[0]!.text).toContain("expiration_date");
    expect(result.content[0]!.text).toContain("51 total");
    expect(result.content[0]!.text).toContain("page_number: 2");
  });
});

describe("advanced toolset config flag", () => {
  const KEY = { ITGLUE_API_KEY: "ITG.test" };
  it("is off by default", () => {
    expect(loadConfig([], { ...KEY }).advancedToolset).toBe(false);
  });
  it("enables via env or flag", () => {
    expect(loadConfig([], { ...KEY, ITGLUE_ADVANCED_TOOLSET: "true" }).advancedToolset).toBe(true);
    expect(loadConfig([], { ...KEY, ITGLUE_ADVANCED_TOOLSET: "1" }).advancedToolset).toBe(true);
    expect(loadConfig(["--advanced"], { ...KEY }).advancedToolset).toBe(true);
  });
  it("treats an unsubstituted template as off", () => {
    expect(
      loadConfig([], { ...KEY, ITGLUE_ADVANCED_TOOLSET: "${user_config.advanced}" }).advancedToolset
    ).toBe(false);
  });
});
