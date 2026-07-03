/**
 * Role-based tool gating.
 *
 * Every tool belongs to a tier. The tier is derived from the tool's MCP
 * annotations (readOnlyHint / destructiveHint) unless the tool declares an
 * explicit `tier` override — used when the RBAC intent differs from the
 * annotation (e.g. deleting a document section is destructive for clients,
 * but editors need it to restructure documents).
 *
 * Enforcement is two-layered:
 *  1. Tools outside the session's role are never registered, so they don't
 *     even appear in tools/list.
 *  2. Registered handlers are wrapped with a runtime re-check, so a
 *     registration bug can never reach the IT Glue client.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Role } from "./tokens.js";

export type ToolTier = "read" | "write" | "destructive";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  /** Explicit tier override; defaults to a tier derived from annotations. */
  tier?: ToolTier;
}

const TIER_ROLES: Record<ToolTier, Role[]> = {
  read: ["viewer", "editor", "admin"],
  write: ["editor", "admin"],
  destructive: ["admin"],
};

export function tierOf(spec: Pick<ToolSpec, "annotations" | "tier">): ToolTier {
  if (spec.tier) return spec.tier;
  if (spec.annotations.readOnlyHint === true) return "read";
  if (spec.annotations.destructiveHint === true) return "destructive";
  return "write";
}

export function roleAllows(role: Role, tier: ToolTier): boolean {
  return TIER_ROLES[tier].includes(role);
}

/** Minimum role that can use a tier — for error messages. */
function tierRequires(tier: ToolTier): Role {
  return TIER_ROLES[tier][0] === "viewer" ? "viewer" : tier === "write" ? "editor" : "admin";
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Registers tools on an McpServer, filtered and guarded by the session role.
 */
export class ToolRegistrar {
  constructor(
    private readonly server: McpServer,
    private readonly role: Role
  ) {}

  register<Args extends Record<string, unknown>>(
    spec: ToolSpec,
    handler: (args: Args) => Promise<ToolResult>
  ): void {
    const tier = tierOf(spec);
    if (!roleAllows(this.role, tier)) {
      return; // tool is invisible to this session
    }

    const role = this.role;
    const guarded = async (args: Args): Promise<ToolResult> => {
      if (!roleAllows(role, tier)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${spec.name} requires the ${tierRequires(tier)} role; this session is authenticated as ${role}.`,
            },
          ],
          isError: true,
        };
      }
      return handler(args);
    };

    this.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
      },
      guarded as never
    );
  }
}
