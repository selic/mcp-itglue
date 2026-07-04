/** Document section tools: list, get, create, update, delete. */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import type { ITGlueClient } from "../itglue/client.js";
import { buildQuery } from "../itglue/client.js";
import type { DocumentSection } from "../itglue/types.js";
import { clip, htmlToText, pageFooter, sectionKind } from "../format.js";
import { queueDocumentRefresh, type IndexerDeps } from "../vector/indexer.js";
import {
  emptyPageData,
  failure,
  itemOutputShape,
  json,
  pageData,
  pageNumberField,
  pageOutputShape,
  pageSizeField,
  responseFormatField,
  structured,
  text,
} from "./shared.js";

const SECTION_TYPES = ["Text", "Heading", "Gallery", "Step"] as const;

function sectionsPath(documentId: number, sectionId?: number): string {
  const base = `/documents/${documentId}/relationships/sections`;
  return sectionId === undefined ? base : `${base}/${sectionId}`;
}

function sectionSummary(section: DocumentSection): string {
  const lines = [
    `### ${sectionKind(section.resource_type)} (ID: ${section.id}, position: ${section.sort ?? "—"})`,
  ];
  if (section.level != null) lines.push(`**Level**: ${section.level}`);
  lines.push(section.content ? htmlToText(section.content) : "*No content*");
  if (section.duration != null) lines.push(`- **Duration**: ${section.duration} min`);
  if (section.updated_at) lines.push(`- **Updated**: ${section.updated_at}`);
  lines.push("");
  return lines.join("\n");
}

export function registerDocumentSectionTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  refreshDeps: IndexerDeps | null
): void {
  reg.register(
    {
      name: "itglue_list_document_sections",
      title: "List IT Glue Document Sections",
      description:
        "List the sections of a document in position order, with content previews and section IDs " +
        "(needed for update/delete operations).",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<DocumentSection>(
          sectionsPath(args.document_id),
          buildQuery({ pageNumber: args.page_number, pageSize: args.page_size })
        );

        if (page.items.length === 0) {
          return structured("This document has no sections.", emptyPageData(args.page_number));
        }
        const data = pageData(page);
        if (args.response_format === "json") return structured(clip(json(data)), data);

        const lines = [`# Sections (${page.totalCount} total)`, ""];
        for (const section of page.items) lines.push(sectionSummary(section));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return structured(
          clip(lines.join("\n"), "Fetch single sections with itglue_get_document_section."),
          data
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_document_section",
      title: "Get IT Glue Document Section",
      description:
        "Get one document section with its full content (HTML on the wire; markdown output converts to plain text).",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID"),
        response_format: responseFormatField,
      },
      outputSchema: itemOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { document_id: number; section_id: number; response_format: "markdown" | "json" }) => {
      try {
        const section = await client.getOne<DocumentSection>(
          sectionsPath(args.document_id, args.section_id)
        );
        if (args.response_format === "json") return structured(clip(json(section)), { item: section });

        const lines = [
          `# ${sectionKind(section.resource_type)} section (ID: ${section.id})`,
          "",
          `**Document**: ${args.document_id}`,
          `**Position**: ${section.sort ?? "—"}`,
        ];
        if (section.level != null) lines.push(`**Level**: ${section.level}`);
        if (section.duration != null) lines.push(`**Duration**: ${section.duration} min`);
        lines.push("", section.content ? htmlToText(section.content) : "*No content*");
        return structured(clip(lines.join("\n")), { item: section });
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_create_document_section",
      title: "Create IT Glue Document Section",
      description:
        "Add a section to a document. Types: Text (HTML content), Heading (content = heading text, level 1-6 required), " +
        "Gallery (no content), Step (HTML content, optional duration in minutes).",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_type: z.enum(SECTION_TYPES).describe("Section type"),
        content: z
          .string()
          .optional()
          .describe("HTML content (Text/Step) or heading text (Heading)"),
        level: z.number().int().min(1).max(6).optional().describe("Heading level 1-6 (required for Heading)"),
        duration: z.number().int().positive().optional().describe("Duration in minutes (Step only)"),
        sort: z.number().int().min(0).optional().describe("Position within the document (0-based)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      section_type: (typeof SECTION_TYPES)[number];
      content?: string;
      level?: number;
      duration?: number;
      sort?: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const section = await client.create<DocumentSection>(
          sectionsPath(args.document_id),
          "document-sections",
          {
            resource_type: `Document::${args.section_type}`,
            content: args.content,
            level: args.level,
            duration: args.duration,
            sort: args.sort,
          }
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(section));
        return text(
          `Section created (ID: ${section.id}, type: ${sectionKind(section.resource_type)}, position: ${section.sort ?? "—"}).`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_update_document_section",
      title: "Update IT Glue Document Section",
      description:
        "Update a section's content, heading level, duration, or position. Only provided fields change; " +
        "the section type cannot be changed.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID to update"),
        content: z.string().optional().describe("New HTML content (or heading text)"),
        level: z.number().int().min(1).max(6).optional().describe("New heading level (Heading only)"),
        duration: z.number().int().positive().optional().describe("New duration in minutes (Step only)"),
        sort: z.number().int().min(0).optional().describe("New position within the document"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      document_id: number;
      section_id: number;
      content?: string;
      level?: number;
      duration?: number;
      sort?: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const section = await client.update<DocumentSection>(
          sectionsPath(args.document_id, args.section_id),
          "document-sections",
          { content: args.content, level: args.level, duration: args.duration, sort: args.sort },
          String(args.section_id)
        );
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");

        if (args.response_format === "json") return text(json(section));
        return text(`Section updated.\n\n${sectionSummary(section)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_document_section",
      title: "Delete IT Glue Document Section",
      description:
        "PERMANENTLY delete one section from a document. This cannot be undone. Useful for restructuring a " +
        "document's layout.",
      inputSchema: {
        document_id: z.number().int().positive().describe("The parent document ID"),
        section_id: z.number().int().positive().describe("The section ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      // Editors restructure documents by removing sections; they can already
      // blank section content via update, so this is not gated to admin.
      tier: "write",
    },
    async (args: { document_id: number; section_id: number }) => {
      try {
        await client.destroy(sectionsPath(args.document_id, args.section_id));
        queueDocumentRefresh(refreshDeps, args.document_id, "upsert");
        return text(`Section ${args.section_id} deleted from document ${args.document_id}.`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
