/** Flexible asset tools: asset types (read) and assets (CRUD). */

import { z } from "zod";
import type { ToolRegistrar } from "../auth/roles.js";
import { buildQuery, type ITGlueClient } from "../itglue/client.js";
import type { FlexibleAsset, FlexibleAssetField, FlexibleAssetType } from "../itglue/types.js";
import { clip, pageFooter } from "../format.js";
import {
  failure,
  json,
  pageNumberField,
  pageSizeField,
  responseFormatField,
  text,
} from "./shared.js";

function traitsBlock(traits: Record<string, unknown> | undefined): string[] {
  const entries = Object.entries(traits ?? {});
  if (entries.length === 0) return ["*No traits*"];
  return entries.map(([key, value]) => {
    const rendered =
      value === null || value === undefined
        ? "—"
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return `- **${key}**: ${rendered}`;
  });
}

function assetSummary(asset: FlexibleAsset): string {
  const lines = [`## ${asset.name ?? "(unnamed)"} (ID: ${asset.id})`];
  if (asset.organization_name) lines.push(`- **Organization**: ${asset.organization_name}`);
  if (asset.flexible_asset_type_name) lines.push(`- **Type**: ${asset.flexible_asset_type_name}`);
  if (asset.updated_at) lines.push(`- **Updated**: ${asset.updated_at}`);
  if (asset.resource_url) lines.push(`- **URL**: ${asset.resource_url}`);
  lines.push(...traitsBlock(asset.traits), "");
  return lines.join("\n");
}

export function registerFlexibleAssetTools(reg: ToolRegistrar, client: ITGlueClient): void {
  reg.register(
    {
      name: "itglue_list_flexible_asset_types",
      title: "List IT Glue Flexible Asset Types",
      description:
        "List flexible asset types (the schemas MSPs define in IT Glue, e.g. 'Wireless', 'Applications'). " +
        "Use this to find the type ID required by itglue_list_flexible_assets.",
      inputSchema: {
        filter_name: z.string().optional().describe("Filter by type name"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      filter_name?: string;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<FlexibleAssetType>(
          "/flexible_asset_types",
          buildQuery({
            filters: { name: args.filter_name },
            pageNumber: args.page_number,
            pageSize: args.page_size,
          })
        );

        if (page.items.length === 0) return text("No flexible asset types found.");
        if (args.response_format === "json") return text(clip(json(page)));

        const lines = [`# Flexible Asset Types (${page.totalCount} total)`, ""];
        for (const t of page.items) {
          lines.push(`## ${t.name} (ID: ${t.id})`);
          if (t.description) lines.push(String(t.description));
          lines.push(`- **Enabled**: ${t.enabled ? "Yes" : "No"}`, "");
        }
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return text(clip(lines.join("\n")));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_flexible_asset_type",
      title: "Get IT Glue Flexible Asset Type",
      description:
        "Get a flexible asset type by ID, including its field definitions (name, kind, required) — " +
        "the trait keys needed to create or update assets of this type.",
      inputSchema: {
        flexible_asset_type_id: z.number().int().positive().describe("The flexible asset type ID"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { flexible_asset_type_id: number; response_format: "markdown" | "json" }) => {
      try {
        const assetType = await client.getOne<FlexibleAssetType>(
          `/flexible_asset_types/${args.flexible_asset_type_id}`
        );
        const fields = await client.getMany<FlexibleAssetField>(
          `/flexible_asset_types/${args.flexible_asset_type_id}/relationships/flexible_asset_fields`,
          { "page[size]": 1000 }
        );

        if (args.response_format === "json") {
          return text(clip(json({ ...assetType, fields: fields.items })));
        }

        const lines = [`# ${assetType.name} (ID: ${assetType.id})`];
        if (assetType.description) lines.push("", String(assetType.description));
        lines.push("", `## Fields (${fields.items.length})`, "");
        for (const field of fields.items) {
          lines.push(
            `- **${field.name}** — kind: ${field.kind ?? "?"}${field.required ? ", required" : ""}` +
              (field.hint ? ` — ${field.hint}` : "")
          );
        }
        lines.push(
          "",
          "Trait keys for create/update are the lowercased, hyphenated field names (e.g. \"SSID Name\" → \"ssid-name\")."
        );
        return text(clip(lines.join("\n")));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_list_flexible_assets",
      title: "List IT Glue Flexible Assets",
      description:
        "List flexible assets of a given type, optionally restricted to one organization. " +
        "The type ID is required by the IT Glue API — find it with itglue_list_flexible_asset_types.",
      inputSchema: {
        flexible_asset_type_id: z.number().int().positive().describe("Flexible asset type ID (required)"),
        organization_id: z.number().int().positive().optional().describe("Restrict to one organization"),
        page_number: pageNumberField,
        page_size: pageSizeField,
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      flexible_asset_type_id: number;
      organization_id?: number;
      page_number: number;
      page_size: number;
      response_format: "markdown" | "json";
    }) => {
      try {
        const page = await client.getMany<FlexibleAsset>(
          "/flexible_assets",
          buildQuery({
            filters: {
              flexible_asset_type_id: args.flexible_asset_type_id,
              organization_id: args.organization_id,
            },
            pageNumber: args.page_number,
            pageSize: args.page_size,
          })
        );

        if (page.items.length === 0) return text("No flexible assets found.");
        if (args.response_format === "json") return text(clip(json(page)));

        const lines = [`# Flexible Assets (${page.totalCount} total)`, ""];
        for (const asset of page.items) lines.push(assetSummary(asset));
        lines.push(pageFooter(page.totalCount, page.pageNumber, page.hasMore));
        return text(clip(lines.join("\n")));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_get_flexible_asset",
      title: "Get IT Glue Flexible Asset",
      description: "Get one flexible asset by ID, including all of its traits.",
      inputSchema: {
        flexible_asset_id: z.number().int().positive().describe("The flexible asset ID"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: { flexible_asset_id: number; response_format: "markdown" | "json" }) => {
      try {
        const asset = await client.getOne<FlexibleAsset>(
          `/flexible_assets/${args.flexible_asset_id}`
        );
        if (args.response_format === "json") return text(clip(json(asset)));
        return text(clip(assetSummary(asset)));
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_create_flexible_asset",
      title: "Create IT Glue Flexible Asset",
      description:
        "Create a flexible asset. Traits are the type's fields keyed by their lowercased, hyphenated names " +
        "(inspect them with itglue_get_flexible_asset_type). All required traits must be provided.",
      inputSchema: {
        organization_id: z.number().int().positive().describe("Organization to create the asset in"),
        flexible_asset_type_id: z.number().int().positive().describe("Flexible asset type ID"),
        traits: z
          .record(z.string(), z.unknown())
          .describe('Field values keyed by trait name, e.g. {"ssid-name": "Corp", "vlan": 12}'),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: {
      organization_id: number;
      flexible_asset_type_id: number;
      traits: Record<string, unknown>;
      response_format: "markdown" | "json";
    }) => {
      try {
        const asset = await client.create<FlexibleAsset>("/flexible_assets", "flexible-assets", {
          organization_id: args.organization_id,
          flexible_asset_type_id: args.flexible_asset_type_id,
          traits: args.traits,
        });
        if (args.response_format === "json") return text(json(asset));
        return text(`Flexible asset created.\n\n${assetSummary(asset)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_update_flexible_asset",
      title: "Update IT Glue Flexible Asset",
      description:
        "Update a flexible asset's traits. IMPORTANT: IT Glue replaces the traits object wholesale — " +
        "fetch the asset first and send back ALL traits, not just the changed ones, or omitted traits are cleared.",
      inputSchema: {
        flexible_asset_id: z.number().int().positive().describe("The flexible asset ID to update"),
        traits: z
          .record(z.string(), z.unknown())
          .describe("The COMPLETE set of trait values (omitted traits are cleared)"),
        response_format: responseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: {
      flexible_asset_id: number;
      traits: Record<string, unknown>;
      response_format: "markdown" | "json";
    }) => {
      try {
        const asset = await client.update<FlexibleAsset>(
          `/flexible_assets/${args.flexible_asset_id}`,
          "flexible-assets",
          { traits: args.traits },
          String(args.flexible_asset_id)
        );
        if (args.response_format === "json") return text(json(asset));
        return text(`Flexible asset updated.\n\n${assetSummary(asset)}`);
      } catch (error) {
        return failure(error);
      }
    }
  );

  reg.register(
    {
      name: "itglue_delete_flexible_asset",
      title: "Delete IT Glue Flexible Asset",
      description: "PERMANENTLY delete a flexible asset. This cannot be undone.",
      inputSchema: {
        flexible_asset_id: z.number().int().positive().describe("The flexible asset ID to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args: { flexible_asset_id: number }) => {
      try {
        await client.destroy(`/flexible_assets/${args.flexible_asset_id}`);
        return text(`Flexible asset ${args.flexible_asset_id} deleted.`);
      } catch (error) {
        return failure(error);
      }
    }
  );
}
