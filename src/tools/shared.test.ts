import { describe, expect, it } from "vitest";
import { emptyPageData, nameMatches, pageData, paginate, pick, previewTraits } from "./shared.js";

describe("pick", () => {
  const fat = {
    id: "1673808",
    name: "SNC Squared",
    description: null,
    organization_type_name: "Owner",
    organization_status_name: "Active",
    short_name: "SNC",
    updated_at: "2022-07-01T18:14:18.000Z",
    psa_integration: "enabled",
    sync_active: true,
    quick_notes: null,
    logo: "logo.png",
    has_personal_passwords: false,
    ancestor_ids: [],
  };

  it("projects to exactly the requested present keys", () => {
    const summary = pick(fat, [
      "id",
      "name",
      "description",
      "organization_type_name",
      "organization_status_name",
      "short_name",
      "updated_at",
    ]);
    expect(Object.keys(summary).sort()).toEqual([
      "description",
      "id",
      "name",
      "organization_status_name",
      "organization_type_name",
      "short_name",
      "updated_at",
    ]);
  });

  it("keeps null and false values but drops missing keys", () => {
    const out = pick({ a: null, b: false, c: "", d: 0 }, ["a", "b", "c", "d", "missing"]);
    expect(out).toEqual({ a: null, b: false, c: "", d: 0 });
    expect("missing" in out).toBe(false);
  });

  it("shrinks a realistic organization to a fraction of its size", () => {
    const full = JSON.stringify(fat).length;
    const slim = JSON.stringify(
      pick(fat, ["id", "name", "organization_type_name", "organization_status_name", "updated_at"])
    ).length;
    expect(slim).toBeLessThan(full / 2);
  });
});

describe("nameMatches", () => {
  it("matches substrings case-insensitively", () => {
    expect(nameMatches({ name: "Jasper Products, LLC" }, "jasper")).toBe(true);
    expect(nameMatches({ name: "Jasper Products, LLC" }, "products, llc")).toBe(true);
    expect(nameMatches({ name: "Network Doctor" }, "doc")).toBe(true);
    expect(nameMatches({ name: "Network Doctor" }, "octopus")).toBe(false);
  });

  it("treats a missing name as no match", () => {
    expect(nameMatches({}, "x")).toBe(false);
    expect(nameMatches({ name: null }, "x")).toBe(false);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 7 }, (_, i) => i + 1);

  it("slices pages and reports hasMore correctly", () => {
    expect(paginate(items, 1, 3)).toEqual({ items: [1, 2, 3], totalCount: 7, pageNumber: 1, hasMore: true });
    expect(paginate(items, 3, 3)).toEqual({ items: [7], totalCount: 7, pageNumber: 3, hasMore: false });
    expect(paginate(items, 4, 3)).toEqual({ items: [], totalCount: 7, pageNumber: 4, hasMore: false });
  });
});

describe("previewTraits", () => {
  it("strips HTML and truncates long values with an ellipsis", () => {
    const html = `<h1>Backup report</h1><table>${"<tr><td>row</td></tr>".repeat(50)}</table>`;
    const out = previewTraits({ "backup-report": html })!;
    const preview = out["backup-report"] as string;
    expect(preview).not.toContain("<");
    expect(preview.length).toBeLessThanOrEqual(201);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.startsWith("# Backup report")).toBe(true);
  });

  it("leaves short plain values, numbers, booleans, and null untouched", () => {
    expect(previewTraits({ ssid: "Corp", vlan: 12, active: true, note: null })).toEqual({
      ssid: "Corp",
      vlan: 12,
      active: true,
      note: null,
    });
  });

  it("passes small objects through and truncates huge ones as JSON", () => {
    const small = { values: [1, 2] };
    const out = previewTraits({ small, big: { arr: Array(200).fill("xxxxxxxx") } })!;
    expect(out.small).toEqual(small);
    expect(typeof out.big).toBe("string");
    expect((out.big as string).endsWith("…")).toBe(true);
  });

  it("returns undefined for undefined traits", () => {
    expect(previewTraits(undefined)).toBeUndefined();
  });
});

describe("page data helpers", () => {
  it("pageData maps client page fields to snake_case", () => {
    expect(
      pageData({ items: [{ id: "1" }], totalCount: 9, pageNumber: 2, hasMore: true })
    ).toEqual({ items: [{ id: "1" }], total_count: 9, page_number: 2, has_more: true });
  });

  it("emptyPageData matches the page shape with no items", () => {
    expect(emptyPageData(3)).toEqual({
      items: [],
      total_count: 0,
      page_number: 3,
      has_more: false,
    });
  });
});
