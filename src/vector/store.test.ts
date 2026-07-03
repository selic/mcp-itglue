import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cosineSimilarity, VectorIndex, type IndexEntry } from "./store.js";

const entry = (id: string, org: string, embedding: number[]): IndexEntry => ({
  document_id: id,
  organization_id: org,
  organization_name: `Org ${org}`,
  title: `Doc ${id}`,
  text: `text of ${id}`,
  url: null,
  embedding,
  indexed_at: "2026-01-01T00:00:00Z",
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("handles zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("VectorIndex", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vecidx-"));
    path = join(dir, "index.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upserts, persists, and reloads", () => {
    const index = new VectorIndex(path);
    index.upsert(entry("1", "10", [1, 0]));
    index.upsert(entry("1", "10", [0.9, 0.1])); // replaces
    index.upsert(entry("2", "20", [0, 1]));
    index.save();

    const reloaded = new VectorIndex(path);
    expect(reloaded.count()).toBe(2);
    expect(reloaded.organizationIds().sort()).toEqual(["10", "20"]);
  });

  it("removes by document and by organization", () => {
    const index = new VectorIndex(path);
    index.upsert(entry("1", "10", [1, 0]));
    index.upsert(entry("2", "10", [1, 0]));
    index.upsert(entry("3", "20", [1, 0]));

    expect(index.removeDocument("2")).toBe(true);
    expect(index.removeDocument("2")).toBe(false);
    index.removeOrganization("10");
    expect(index.count()).toBe(1);
  });

  it("searches by similarity with threshold, topK, and org filter", () => {
    const index = new VectorIndex(path);
    index.upsert(entry("close", "10", [1, 0.05]));
    index.upsert(entry("far", "10", [0, 1]));
    index.upsert(entry("other-org", "20", [1, 0]));

    const all = index.search([1, 0], { threshold: 0.5 });
    expect(all.map((h) => h.document_id)).toEqual(["other-org", "close"]);

    const scoped = index.search([1, 0], { threshold: 0.5, organizationId: "10" });
    expect(scoped.map((h) => h.document_id)).toEqual(["close"]);

    const limited = index.search([1, 0], { threshold: 0, topK: 1 });
    expect(limited).toHaveLength(1);
  });

  it("starts empty when the file is corrupt", () => {
    const index = new VectorIndex(path);
    index.upsert(entry("1", "10", [1]));
    index.save();
    writeFileSync(path, "{not json", "utf-8");
    const reloaded = new VectorIndex(path);
    expect(reloaded.count()).toBe(0);
  });
});
