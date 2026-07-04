/**
 * Semantic search tools over the local vector index. Registered only when an
 * embedding provider is configured.
 */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { reindexOrganization, type IndexerDeps } from "../vector/indexer.js";
import { failure, structured, text } from "./shared.js";

export function registerVectorSearchTools(reg: ToolRegistrar, deps: IndexerDeps): void {
  reg.register(
    {
      name: "itglue_build_vector_index",
      title: "Build IT Glue Vector Index",
      description:
        "Crawl every document in an organization, embed the content, and persist it to the local vector index " +
        "used by itglue_vector_search. Re-running replaces the organization's existing index entries. " +
        "Can take a while for large organizations.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization to index"),
        page_size: z
          .number()
          .int()
          .positive()
          .max(1000)
          .default(100)
          .describe("Documents fetched per API page while crawling"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { organization_id: number; page_size: number }) => {
      try {
        const summary = await reindexOrganization(deps, args.organization_id, args.page_size);
        if (summary.total === 0) {
          return text("No documents found for this organization — nothing indexed.");
        }
        const lines = [
          "# Vector index built",
          "",
          `- **Organization**: ${args.organization_id}`,
          `- **Documents indexed**: ${summary.indexed} / ${summary.total}`,
          `- **Embedding model**: ${deps.embedder.model}`,
          `- **Index size**: ${deps.index.count()} documents`,
        ];
        if (summary.errors.length > 0) {
          lines.push("", `**Errors (${summary.errors.length}):**`);
          for (const err of summary.errors.slice(0, 5)) lines.push(`- ${err}`);
        }
        return text(lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_vector_search",
      title: "Semantic Search IT Glue Documents",
      description:
        "Search indexed IT Glue documents by MEANING, not exact words — 'remove backup agent' matches a Veeam " +
        "decommissioning runbook. Requires itglue_build_vector_index to have been run for the target " +
        "organization(s); check with itglue_vector_index_status.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language question or keywords"),
        organization_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Restrict results to one organization"),
        top_k: z.number().int().positive().max(20).default(5).describe("Number of results"),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe("Minimum similarity score (0-1)"),
      },
      outputSchema: {
        query: z.string(),
        results: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: { query: string; organization_id?: number; top_k: number; threshold: number }) => {
      try {
        if (deps.index.count() === 0) {
          return structured("The vector index is empty. Run itglue_build_vector_index first.", {
            query: args.query,
            results: [],
          });
        }
        const queryVector = await deps.embedder.embed(args.query);
        const hits = deps.index.search(queryVector, {
          topK: args.top_k,
          threshold: args.threshold,
          organizationId: args.organization_id ? String(args.organization_id) : undefined,
        });
        const data = { query: args.query, results: hits as unknown as Array<Record<string, unknown>> };

        if (hits.length === 0) {
          return structured(
            `No documents matched "${args.query}" above threshold ${args.threshold}.`,
            data
          );
        }

        const lines = [`# Search results for "${args.query}"`, ""];
        hits.forEach((hit, i) => {
          lines.push(`## ${i + 1}. ${hit.title} (ID: ${hit.document_id})`);
          lines.push(`- **Organization**: ${hit.organization_name}`);
          lines.push(`- **Score**: ${hit.score}`);
          if (hit.url) lines.push(`- **URL**: ${hit.url}`);
          lines.push("", `> ${hit.excerpt}`, "");
        });
        return structured(lines.join("\n"), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_vector_index_status",
      title: "IT Glue Vector Index Status",
      description:
        "Show what is in the local vector index: total documents and a per-organization breakdown. " +
        "Use this to decide whether itglue_build_vector_index needs to run.",
      inputSchema: {},
      outputSchema: {
        index_path: z.string(),
        total_documents: z.number(),
        embedding_model: z.string(),
        organizations: z.record(z.string(), z.number()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      deps.index.reload();
      const total = deps.index.count();
      const organizations = deps.index.countsByOrganization();
      const data = {
        index_path: deps.index.path,
        total_documents: total,
        embedding_model: deps.embedder.model,
        organizations,
      };
      if (total === 0) {
        return structured(
          `The vector index is empty (file: ${deps.index.path}). Run itglue_build_vector_index to populate it.`,
          data
        );
      }
      const lines = [
        "# Vector index status",
        "",
        `- **Index file**: ${deps.index.path}`,
        `- **Documents**: ${total}`,
        `- **Embedding model**: ${deps.embedder.model}`,
        "",
        "## Per organization",
        "",
      ];
      for (const [org, count] of Object.entries(organizations)) {
        lines.push(`- ${org}: ${count}`);
      }
      return structured(lines.join("\n"), data);
    }
  );
}
