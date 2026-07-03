/**
 * Indexing pipeline shared by the build tool, the IT Glue webhook, the manual
 * /index/refresh endpoint, and the post-write self-refresh hook.
 */

import type { ITGlueClient } from "../itglue/client.js";
import type { Document, DocumentSection } from "../itglue/types.js";
import { htmlToText } from "../format.js";
import type { Embedder } from "./embeddings.js";
import type { IndexEntry, VectorIndex } from "./store.js";

/** Title + body passed to the embedding model is capped to stay in token limits. */
const EMBED_TEXT_LIMIT = 8_000;
/** Documents fetched per page while crawling an organization. */
const DEFAULT_CRAWL_PAGE_SIZE = 100;
/** Documents embedded per batch while crawling. */
const CRAWL_CHUNK = 20;

export interface IndexerDeps {
  client: ITGlueClient;
  embedder: Embedder;
  index: VectorIndex;
}

/** Fetch all sections of a document and return their combined plain text. */
export async function documentPlainText(
  client: ITGlueClient,
  documentId: string
): Promise<string> {
  try {
    const sections = await client.getMany<DocumentSection>(
      `/documents/${documentId}/relationships/sections`,
      { "page[size]": 1000 }
    );
    return sections.items
      .map((s) => (s.content ? htmlToText(s.content) : ""))
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return "";
  }
}

/**
 * List every document in an organization. The documents endpoint returns only
 * root-level documents by default, so a second query fetches folder-nested
 * ones; results are merged and de-duplicated.
 */
export async function collectOrganizationDocuments(
  client: ITGlueClient,
  organizationId: number,
  pageSize: number = DEFAULT_CRAWL_PAGE_SIZE
): Promise<Document[]> {
  const path = `/organizations/${organizationId}/relationships/documents`;
  const documents: Document[] = [];
  const seen = new Set<string>();
  let pageNumber = 1;
  let hasMore = true;

  while (hasMore) {
    const base = { "page[number]": pageNumber, "page[size]": pageSize };
    const rootPage = await client.getMany<Document>(path, base);
    const folderPage = await client.getMany<Document>(path, {
      ...base,
      "filter[document-folder-id][ne]": "null",
    });
    for (const doc of [...rootPage.items, ...folderPage.items]) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        documents.push(doc);
      }
    }
    hasMore = rootPage.hasMore || folderPage.hasMore;
    pageNumber += 1;
  }
  return documents;
}

async function buildEntry(
  deps: IndexerDeps,
  documentId: string,
  known?: Partial<Pick<IndexEntry, "title" | "organization_id" | "organization_name" | "url">>
): Promise<IndexEntry> {
  let { title, organization_id, organization_name, url } = known ?? {};
  if (!title || !organization_id) {
    const doc = await deps.client.getOne<Document>(`/documents/${documentId}`);
    title = title ?? doc.name;
    organization_id = organization_id ?? String(doc.organization_id ?? "");
    organization_name = organization_name ?? doc.organization_name ?? organization_id;
    url = url ?? doc.resource_url ?? null;
  }

  const text = await documentPlainText(deps.client, documentId);
  const embedding = await deps.embedder.embed(`${title}\n\n${text}`.slice(0, EMBED_TEXT_LIMIT));

  return {
    document_id: documentId,
    organization_id: organization_id ?? "",
    organization_name: organization_name ?? "unknown",
    title: title ?? documentId,
    text,
    url: url ?? null,
    embedding,
    indexed_at: new Date().toISOString(),
  };
}

/** Re-fetch, re-embed, and upsert a single document. */
export async function refreshDocument(
  deps: IndexerDeps,
  documentId: string,
  known?: Partial<Pick<IndexEntry, "title" | "organization_id" | "organization_name" | "url">>
): Promise<string> {
  const entry = await buildEntry(deps, documentId, known);
  deps.index.upsert(entry);
  deps.index.save();
  return `Document ${documentId} ("${entry.title}") indexed.`;
}

/** Drop a document from the index. */
export function dropDocument(index: VectorIndex, documentId: string): string {
  const removed = index.removeDocument(documentId);
  if (removed) index.save();
  return removed
    ? `Document ${documentId} removed from the index.`
    : `Document ${documentId} was not in the index.`;
}

export interface CrawlSummary {
  indexed: number;
  total: number;
  errors: string[];
}

/** Rebuild the index for one organization. */
export async function reindexOrganization(
  deps: IndexerDeps,
  organizationId: number,
  pageSize: number = DEFAULT_CRAWL_PAGE_SIZE
): Promise<CrawlSummary> {
  const documents = await collectOrganizationDocuments(deps.client, organizationId, pageSize);
  if (documents.length === 0) return { indexed: 0, total: 0, errors: [] };

  deps.index.removeOrganization(String(organizationId));

  const errors: string[] = [];
  let indexed = 0;

  for (let i = 0; i < documents.length; i += CRAWL_CHUNK) {
    const chunk = documents.slice(i, i + CRAWL_CHUNK);
    const texts = await Promise.all(chunk.map((doc) => documentPlainText(deps.client, doc.id)));
    const toEmbed = chunk.map((doc, j) =>
      `${doc.name}\n\n${texts[j] ?? ""}`.slice(0, EMBED_TEXT_LIMIT)
    );

    let embeddings: number[][];
    try {
      embeddings = await deps.embedder.embedBatch(toEmbed);
    } catch (err) {
      errors.push(`Embedding documents ${i}–${i + chunk.length - 1}: ${String(err)}`);
      continue;
    }

    chunk.forEach((doc, j) => {
      const embedding = embeddings[j];
      if (!embedding) {
        errors.push(`No embedding returned for document ${doc.id}`);
        return;
      }
      deps.index.upsert({
        document_id: doc.id,
        organization_id: String(organizationId),
        organization_name: doc.organization_name ?? String(organizationId),
        title: doc.name,
        text: texts[j] ?? "",
        url: doc.resource_url ?? null,
        embedding,
        indexed_at: new Date().toISOString(),
      });
      indexed += 1;
    });
  }

  deps.index.save();
  return { indexed, total: documents.length, errors };
}

/** Re-crawl every organization currently present in the index. */
export async function reindexAll(deps: IndexerDeps): Promise<CrawlSummary> {
  const totals: CrawlSummary = { indexed: 0, total: 0, errors: [] };
  for (const orgId of deps.index.organizationIds()) {
    const numeric = Number(orgId);
    if (!Number.isInteger(numeric)) continue;
    try {
      const summary = await reindexOrganization(deps, numeric);
      totals.indexed += summary.indexed;
      totals.total += summary.total;
      totals.errors.push(...summary.errors);
    } catch (err) {
      totals.errors.push(`Organization ${orgId}: ${String(err)}`);
    }
  }
  return totals;
}

/**
 * Fire-and-forget refresh used after successful MCP write operations, so
 * documents edited through this server become searchable immediately.
 */
export function queueDocumentRefresh(
  deps: IndexerDeps | null,
  documentId: string | number,
  action: "upsert" | "remove"
): void {
  if (!deps) return;
  const id = String(documentId);
  if (action === "remove") {
    try {
      console.error(`[index] ${dropDocument(deps.index, id)}`);
    } catch (err) {
      console.error(`[index] Failed to remove document ${id}: ${String(err)}`);
    }
    return;
  }
  refreshDocument(deps, id)
    .then((message) => console.error(`[index] ${message}`))
    .catch((err) => console.error(`[index] Failed to refresh document ${id}: ${String(err)}`));
}
