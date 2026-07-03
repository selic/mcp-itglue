/** Document tools: list, get, create, update, publish, delete. */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, bulkDeletePayload, type ITGlueClient } from "../itglue/client.js";
import type { Document, DocumentSection } from "../itglue/types.js";
import { clip, htmlToText, pageFooter, sectionKind } from "../format.js";
import { queueDocumentRefresh, type IndexerDeps } from "../vector/indexer.js";
import {
  failure,
  json,
  pageNumberField,
  pageSizeField,
  responseFormatField,
  text,
} from "./shared.js";

function documentSummary(doc: Document): string {
  const lines = [`## ${doc.name} (ID: ${doc.id})`];
  if (doc.organization_name) lines.push(`- **Organization**: ${doc.organization_name}`);
  lines.push(`- **Published**: ${doc.published ? "Yes" : "No"}`);
  if (doc.updated_at) lines.push(`- **Updated**: ${doc.updated_at}`);
  if (doc.resource_url) lines.push(`- **URL**: ${doc.resource_url}`);
  lines.push("");
  return lines.join("\n");
}

export function registerDocumentTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  refreshDeps: IndexerDeps | null
): void {
  reg.register(
    {
      name: "itglue_list_documents",
      title: "List IT Glue Documents",
      description:
        "List documents in an organization, including documents nested in folders. Returns metadata only — " +
        "use itglue_get_document for content. The endpoint returns root-level documents by default, so this tool " +
        "issues a second query for folder-nested documents and merges the results (up to 2x page_size items).",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization ID to list documents for"),
        filter_name: z.string().optional().describe("Filter by document name (partial match)"),
        filter_id: z.number().int().positive().optional().describe("Filter by document ID"),
        sort: z.string().optional().describe('Sort field (e.g. "name", "-updated_at")'),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      organization_id: number;
      filter_name?: string;
      filter_id?: number;
      sort?: string;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const path = `/organizations/${args.organization_id}/relationships/documents`;
        const query = buildQuery({
          filters: { name: args.filter_name, id: args.filter_id },
          pageNumber: args.page_number,
          pageSize: args.page_size,
          sort: args.sort,
        });

        const rootPage = await client.getMany<Document>(path, query);
        const folderPage = await client.getMany<Document>(path, {
          ...query,
          "filter[document-folder-id][ne]": "null",
        });

        const seen = new Set<string>();
        const documents: Document[] = [];
        for (const doc of [...rootPage.items, ...folderPage.items]) {
          if (!seen.has(doc.id)) {
            seen.add(doc.id);
            documents.push(doc);
          }
        }
        const totalCount = rootPage.totalCount + folderPage.totalCount;
        const hasMore = rootPage.hasMore || folderPage.hasMore;

        if (documents.length === 0) return text("No documents found.");
        if (args.response_format === "json") {
          return text(clip(json({ items: documents, totalCount, pageNumber: args.page_number, hasMore })));
        }

        const lines = [`# Documents (${totalCount} total)`, ""];
        for (const doc of documents) lines.push(documentSummary(doc));
        lines.push(pageFooter(totalCount, args.page_number, hasMore));
        return text(clip(lines.join("\n")));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_document",
      title: "Get IT Glue Document",
      description:
        "Get a document by ID with all of its sections and their content. Section content is stored as HTML; " +
        "markdown output converts it to plain text. If the response is truncated, fetch individual sections " +
        "with itglue_get_document_section.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; response_format: "markdown" | "json" }) => {
      try {
        const doc = await client.getOne<Document>(`/documents/${args.document_id}`);
        const sections = await client.getMany<DocumentSection>(
          `/documents/${args.document_id}/relationships/sections`,
          { "page[size]": 1000 }
        );

        if (args.response_format === "json") {
          return text(clip(json({ ...doc, sections: sections.items })));
        }

        const lines = [`# ${doc.name}`, "", `**ID**: ${doc.id}`];
        if (doc.organization_name) lines.push(`**Organization**: ${doc.organization_name}`);
        lines.push(`**Published**: ${doc.published ? "Yes" : "No"}`);
        if (doc.updated_at) lines.push(`**Updated**: ${doc.updated_at}`);
        if (doc.resource_url) lines.push(`**URL**: ${doc.resource_url}`);
        lines.push("");

        if (sections.items.length === 0) {
          lines.push("*No sections.*");
        } else {
          lines.push(`## Sections (${sections.items.length})`, "");
          for (const section of sections.items) {
            lines.push(`### ${sectionKind(section.resource_type)} (ID: ${section.id}, position: ${section.sort ?? "—"})`);
            if (section.level != null) lines.push(`**Level**: ${section.level}`);
            lines.push(section.content ? htmlToText(section.content) : "*No content*");
            lines.push("");
          }
        }

        return text(
          clip(lines.join("\n"), "Fetch individual sections with itglue_get_document_section.")
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_create_document",
      title: "Create IT Glue Document",
      description:
        "Create a new document as a DRAFT in an organization. Add content with itglue_create_document_section, " +
        "then make it visible with itglue_publish_document.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization to create the document in"),
        name: z.string().min(1).describe("Document name/title"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: { organization_id: number; name: string; response_format: "markdown" | "json" }) => {
      try {
        const doc = await client.create<Document>("/documents", "documents", {
          organization_id: args.organization_id,
          name: args.name,
        });
        queueDocumentRefresh(refreshDeps, doc.id, "upsert");

        if (args.response_format === "json") return text(json(doc));
        return text(
          [
            "# Document created (draft)",
            "",
            `**ID**: ${doc.id}`,
            `**Name**: ${doc.name}`,
            "",
            "Next: add content with itglue_create_document_section, then itglue_publish_document.",
          ].join("\n")
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_update_document",
      title: "Update IT Glue Document",
      description:
        "Rename a document (metadata only). To change content, use itglue_update_document_section.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID to update"),
        name: z.string().min(1).describe("New document name"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; name: string; response_format: "markdown" | "json" }) => {
      try {
        const doc = await client.update<Document>(
          `/documents/${args.document_id}`,
          "documents",
          { name: args.name },
          String(args.document_id)
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(doc));
        return text(`Document updated.\n\n${documentSummary(doc)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_publish_document",
      title: "Publish IT Glue Document",
      description: "Publish a draft document, making it visible to users with access.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The document ID to publish"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number }) => {
      try {
        await client.patchAction(`/documents/${args.document_id}/publish`);
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        return text(`Document ${args.document_id} published.`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_documents",
      title: "Delete IT Glue Documents",
      description:
        "PERMANENTLY delete one or more documents, including all their sections. This cannot be undone.",
      inputSchema: {
        document_ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe("IDs of the documents to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_ids: number[] }) => {
      try {
        await client.destroy("/documents", bulkDeletePayload("documents", args.document_ids));
        for (const id of args.document_ids) queueDocumentRefresh(refreshDeps, id, "remove");
        return text(`Deleted ${args.document_ids.length} document(s): ${args.document_ids.join(", ")}`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
