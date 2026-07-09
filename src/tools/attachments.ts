/** Attachment tools: attach an image/file to any supported record, list, delete. */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, type ITGlueClient } from "../itglue/client.js";
import type { Transport } from "../config.js";
import { clip, pageFooter } from "../format.js";
import {
  emptyPageData,
  failure,
  json,
  pageData,
  pageNumberField,
  pageOutputShape,
  pageSizeField,
  pick,
  responseFormatField,
  structured,
  text,
} from "./shared.js";

/**
 * IT Glue resource types that support attachments, keyed by the exact URL path
 * segment. The attachments endpoint is nested under the parent record:
 *   POST /:segment/:id/relationships/attachments
 * Files are sent base64-encoded inside ordinary application/vnd.api+json JSON —
 * no multipart — so this rides the existing JSON client.
 */
const RESOURCE_TYPES = [
  "documents",
  "flexible_assets",
  "configurations",
  "contacts",
  "passwords",
  "domains",
  "locations",
  "ssl_certificates",
  "tickets",
  "checklists",
] as const;

type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Reject files large enough to bloat the JSON payload / API limits. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ATTACHMENT_SUMMARY_KEYS = [
  "id",
  "name",
  "attachment_file_name",
  "attachment_content_type",
  "attachment_file_size",
  "download_url",
  "created_at",
] as const;

export function attachmentsPath(
  resourceType: ResourceType,
  resourceId: number,
  attachmentId?: number
): string {
  const base = `/${resourceType}/${resourceId}/relationships/attachments`;
  return attachmentId === undefined ? base : `${base}/${attachmentId}`;
}

/**
 * Decode a base64 input into bytes, tolerating a `data:<mime>;base64,` prefix
 * (which browsers and many tools prepend). Whitespace/newlines are ignored by
 * Buffer's base64 decoder, so the result is normalized on re-encode.
 */
export function decodeBase64Input(input: string): Buffer {
  const stripped = input.startsWith("data:")
    ? input.slice(input.indexOf(",") + 1)
    : input;
  return Buffer.from(stripped, "base64");
}

/** The JSON:API attributes IT Glue expects for an attachment upload. */
export function attachmentAttributes(content: string, fileName: string): Record<string, unknown> {
  // `attachment` is a single top-level attribute holding a nested object; the
  // client kebab-cases only top-level keys, so `content`/`file_name` survive.
  return { attachment: { content, file_name: fileName } };
}

class AttachmentInputError extends Error {}

/**
 * Resolve the caller's chosen image source to raw bytes plus an inferred file
 * name. Exactly one of content_base64 / url / file_path must be provided;
 * file_path is only honoured on the local stdio transport.
 */
async function resolveBytes(
  args: { content_base64?: string; url?: string; file_path?: string },
  transport: Transport
): Promise<{ buffer: Buffer; inferredName?: string }> {
  const sources = [args.content_base64, args.url, args.file_path].filter(
    (v) => v !== undefined
  );
  if (sources.length === 0) {
    throw new AttachmentInputError(
      "Provide exactly one image source: content_base64, url, or file_path."
    );
  }
  if (sources.length > 1) {
    throw new AttachmentInputError(
      "Provide only one image source (content_base64, url, or file_path), not several."
    );
  }

  if (args.content_base64 !== undefined) {
    return { buffer: decodeBase64Input(args.content_base64) };
  }

  if (args.url !== undefined) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new AttachmentInputError(`Invalid url "${args.url}".`);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new AttachmentInputError(`Failed to fetch url (HTTP ${res.status}).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, inferredName: basename(url.pathname) || undefined };
  }

  // file_path
  if (transport !== "stdio") {
    throw new AttachmentInputError(
      "file_path is only available on the local stdio transport; use content_base64 or url instead."
    );
  }
  const buffer = await readFile(args.file_path!);
  return { buffer, inferredName: basename(args.file_path!) };
}

function attachmentSummary(a: Record<string, unknown>): string {
  const name = a.attachment_file_name ?? a.name ?? "(unnamed)";
  const lines = [`## ${name} (ID: ${a.id})`];
  if (a.attachment_content_type) lines.push(`- **Type**: ${a.attachment_content_type}`);
  if (a.attachment_file_size) lines.push(`- **Size**: ${a.attachment_file_size} bytes`);
  if (a.download_url) lines.push(`- **Download**: ${a.download_url}`);
  if (a.created_at) lines.push(`- **Created**: ${a.created_at}`);
  lines.push("");
  return lines.join("\n");
}

export function registerAttachmentTools(
  reg: ToolRegistrar,
  client: ITGlueClient,
  transport: Transport
): void {
  reg.register(
    {
      name: "itglue_create_attachment",
      title: "Create IT Glue Attachment",
      description:
        "Attach an image or file to a record (document, flexible asset, configuration, etc.). " +
        "The file appears under the record's Attachments in IT Glue. Provide exactly one image " +
        "source: content_base64 (a base64 string, optionally a data: URI), url (the server fetches " +
        "and encodes it), or file_path (local stdio runs only). Give file_name with an extension " +
        "(e.g. network-diagram.png) so IT Glue detects the type; it is inferred from url/file_path " +
        `when omitted. Max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type to attach to"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        file_name: z
          .string()
          .optional()
          .describe("Display file name with extension; inferred from url/file_path if omitted"),
        content_base64: z
          .string()
          .optional()
          .describe("Base64-encoded file bytes (a leading data: URI prefix is stripped)"),
        url: z.string().optional().describe("URL the server fetches and base64-encodes"),
        file_path: z
          .string()
          .optional()
          .describe("Local filesystem path to read (stdio transport only)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: {
      resource_type: ResourceType;
      resource_id: number;
      file_name?: string;
      content_base64?: string;
      url?: string;
      file_path?: string;
      response_format: "markdown" | "json";
    }) => {
      try {
        const { buffer, inferredName } = await resolveBytes(args, transport);

        if (buffer.length === 0) {
          return failure(new AttachmentInputError("The image source produced no data."));
        }
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          return failure(
            new AttachmentInputError(
              `File is ${buffer.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes.`
            )
          );
        }

        const fileName = args.file_name ?? inferredName;
        if (!fileName || !/\.[^.\s]+$/.test(fileName)) {
          return failure(
            new AttachmentInputError(
              "file_name is required and must include an extension (e.g. diagram.png)."
            )
          );
        }

        const attachment = await client.create<Record<string, unknown>>(
          attachmentsPath(args.resource_type, args.resource_id),
          "attachments",
          attachmentAttributes(buffer.toString("base64"), fileName)
        );

        if (args.response_format === "json") return text(json(attachment));
        return text(
          `Attachment created (ID: ${attachment.id}, file: ${fileName}) on ${args.resource_type} ${args.resource_id}.`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_list_attachments",
      title: "List IT Glue Attachments",
      description:
        "List the attachments on a record (document, flexible asset, configuration, etc.), with " +
        "attachment IDs (needed for delete), file names, content types, and download URLs.",
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      resource_type: ResourceType;
      resource_id: number;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<Record<string, unknown>>(
          attachmentsPath(args.resource_type, args.resource_id),
          buildQuery({ pageNumber: args.page_number, pageSize: args.page_size })
        );

        if (page.items.length === 0) {
          return structured("This record has no attachments.", emptyPageData(args.page_number));
        }
        const data = pageData({
          ...page,
          items: page.items.map((a) => pick(a, ATTACHMENT_SUMMARY_KEYS)),
        });
        if (args.response_format === "json") return structured(clip(json(data)), data);

        const lines = [`# Attachments (${page.totalCount} total)`, ""];
        for (const a of page.items) lines.push(attachmentSummary(a));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return structured(clip(lines.join("\n")), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_attachment",
      title: "Delete IT Glue Attachment",
      description:
        "PERMANENTLY delete an attachment from a record. This cannot be undone. Find the attachment " +
        "ID with itglue_list_attachments.",
      inputSchema: {
        resource_type: z.enum(RESOURCE_TYPES).describe("The record type"),
        resource_id: z.number().int().positive().describe("The parent record ID"),
        attachment_id: z.number().int().positive().describe("The attachment ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args: { resource_type: ResourceType; resource_id: number; attachment_id: number }) => {
      try {
        // IT Glue deletes related attachments via a bulk body on the collection
        // endpoint (there is no single id-in-path DELETE for attachments).
        await client.destroy(attachmentsPath(args.resource_type, args.resource_id), {
          data: [{ type: "attachments", attributes: { id: args.attachment_id } }],
        });
        return text(
          `Attachment ${args.attachment_id} deleted from ${args.resource_type} ${args.resource_id}.`
        );
      } catch (error) {
        return failure(error);
      }
    }
  );
}
