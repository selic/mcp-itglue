/** Organization tools (read-only). */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, type ITGlueClient } from "../itglue/client.js";
import type { Organization } from "../itglue/types.js";
import { clip, pageFooter } from "../format.js";
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
} from "./shared.js";

function organizationLines(org: Organization): string[] {
  const lines = [`## ${org.name} (ID: ${org.id})`];
  if (org.description) lines.push(String(org.description));
  if (org.organization_type_name) lines.push(`- **Type**: ${org.organization_type_name}`);
  if (org.organization_status_name) lines.push(`- **Status**: ${org.organization_status_name}`);
  if (org.short_name) lines.push(`- **Short name**: ${org.short_name}`);
  if (org.updated_at) lines.push(`- **Updated**: ${org.updated_at}`);
  lines.push("");
  return lines;
}

export function registerOrganizationTools(reg: ToolRegistrar, client: ITGlueClient): void {
  reg.register(
    {
      name: "itglue_list_organizations",
      title: "List IT Glue Organizations",
      description:
        "Search and list IT Glue organizations. Use this first to find the organization ID required by document and flexible-asset tools. " +
        "Filters use exact matching except filter_name, which matches partially. Results are paginated.",
      inputSchema: {
        filter_name: z.string().optional().describe("Filter by organization name (partial match)"),
        filter_id: z.number().int().positive().optional().describe("Filter by organization ID"),
        sort: z
          .string()
          .optional()
          .describe('Sort field, prefix with "-" for descending (e.g. "name", "-updated_at")'),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      outputSchema: pageOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      filter_name?: string;
      filter_id?: number;
      sort?: string;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<Organization>(
          "/organizations",
          buildQuery({
            filters: { name: args.filter_name, id: args.filter_id },
            pageNumber: args.page_number,
            pageSize: args.page_size,
            sort: args.sort,
          })
        );

        if (page.items.length === 0) {
          return structured("No organizations found.", emptyPageData(args.page_number));
        }
        const data = pageData(page);
        if (args.response_format === "json") return structured(clip(json(data)), data);

        const lines = [`# Organizations (${page.totalCount} total)`, ""];
        for (const org of page.items) lines.push(...organizationLines(org));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return structured(clip(lines.join("\n")), data);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_organization",
      title: "Get IT Glue Organization",
      description: "Get a single IT Glue organization by ID.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("The organization ID"),
        response_format: responseFormatField,
      },
      outputSchema: itemOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { organization_id: number; response_format: "markdown" | "json" }) => {
      try {
        const org = await client.getOne<Organization>(`/organizations/${args.organization_id}`);
        if (args.response_format === "json") return structured(json(org), { item: org });
        return structured(organizationLines(org).join("\n"), { item: org });
      } catch (error) {
        return failure(error);
      }
    }
  );
}
