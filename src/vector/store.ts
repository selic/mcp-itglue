/**
 * Persistent vector index: one embedding per IT Glue document, stored as a
 * JSON file, searched in memory with cosine similarity.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface IndexEntry {
  document_id: string;
  organization_id: string;
  organization_name: string;
  title: string;
  /** Plain-text body used for excerpts. */
  text: string;
  url: string | null;
  embedding: number[];
  indexed_at: string;
}

export interface SearchHit {
  document_id: string;
  organization_id: string;
  organization_name: string;
  title: string;
  url: string | null;
  score: number;
  excerpt: string;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export class VectorIndex {
  private entries: IndexEntry[] = [];
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.path)) {
      this.entries = [];
      return;
    }
    try {
      this.entries = JSON.parse(readFileSync(this.path, "utf-8")) as IndexEntry[];
    } catch {
      console.error(`[vector] Could not parse index file at ${this.path}; starting empty.`);
      this.entries = [];
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries), "utf-8");
  }

  upsert(entry: IndexEntry): void {
    const i = this.entries.findIndex((e) => e.document_id === entry.document_id);
    if (i >= 0) this.entries[i] = entry;
    else this.entries.push(entry);
  }

  removeDocument(documentId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.document_id !== documentId);
    return this.entries.length < before;
  }

  removeOrganization(organizationId: string): void {
    this.entries = this.entries.filter((e) => e.organization_id !== organizationId);
  }

  count(): number {
    return this.entries.length;
  }

  organizationIds(): string[] {
    return [...new Set(this.entries.map((e) => e.organization_id))];
  }

  countsByOrganization(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.entries) {
      const key = `${e.organization_name} (${e.organization_id})`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  search(
    queryEmbedding: number[],
    options: { topK?: number; threshold?: number; organizationId?: string } = {}
  ): SearchHit[] {
    const { topK = 5, threshold = 0.3, organizationId } = options;
    const pool = organizationId
      ? this.entries.filter((e) => e.organization_id === organizationId)
      : this.entries;

    return pool
      .map((entry) => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding) }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ entry, score }) => ({
        document_id: entry.document_id,
        organization_id: entry.organization_id,
        organization_name: entry.organization_name,
        title: entry.title,
        url: entry.url,
        score: Math.round(score * 1000) / 1000,
        excerpt:
          entry.text.slice(0, 300).replace(/\s+/g, " ").trim() +
          (entry.text.length > 300 ? "…" : ""),
      }));
  }
}

// One index instance per file path, shared across sessions in this process.
const instances = new Map<string, VectorIndex>();

export function openIndex(path: string): VectorIndex {
  const key = resolve(path);
  let index = instances.get(key);
  if (!index) {
    index = new VectorIndex(key);
    instances.set(key, index);
  }
  return index;
}
