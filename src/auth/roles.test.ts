import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { roleAllows, tierOf, ToolRegistrar, type ToolSpec } from "./roles.js";
import type { Role } from "./tokens.js";

const readSpec = (name: string): ToolSpec => ({
  name,
  title: name,
  description: "",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
});
const writeSpec = (name: string): ToolSpec => ({
  name,
  title: name,
  description: "",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false },
});
const destructiveSpec = (name: string): ToolSpec => ({
  name,
  title: name,
  description: "",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: true },
});

describe("tierOf", () => {
  it("derives the tier from annotations", () => {
    expect(tierOf(readSpec("r"))).toBe("read");
    expect(tierOf(writeSpec("w"))).toBe("write");
    expect(tierOf(destructiveSpec("d"))).toBe("destructive");
  });

  it("honors an explicit override", () => {
    expect(tierOf({ ...destructiveSpec("d"), tier: "write" })).toBe("write");
  });
});

describe("roleAllows", () => {
  const matrix: Array<[Role, string, boolean]> = [
    ["viewer", "read", true],
    ["viewer", "write", false],
    ["viewer", "destructive", false],
    ["editor", "read", true],
    ["editor", "write", true],
    ["editor", "destructive", false],
    ["admin", "read", true],
    ["admin", "write", true],
    ["admin", "destructive", true],
  ];
  for (const [role, tier, expected] of matrix) {
    it(`${role} × ${tier} → ${expected}`, () => {
      expect(roleAllows(role, tier as never)).toBe(expected);
    });
  }
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function stubServer(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

describe("ToolRegistrar", () => {
  const specs: ToolSpec[] = [
    readSpec("t_read"),
    writeSpec("t_write"),
    destructiveSpec("t_destroy"),
    { ...destructiveSpec("t_destroy_override"), tier: "write" },
  ];

  function registerAll(role: Role) {
    const { server, tools } = stubServer();
    const reg = new ToolRegistrar(server, role);
    for (const spec of specs) {
      reg.register(spec, async () => ({ content: [{ type: "text", text: "ok" }] }));
    }
    return tools;
  }

  it("viewer sees only read tools", () => {
    expect([...registerAll("viewer").keys()]).toEqual(["t_read"]);
  });

  it("editor sees read + write, including the destructive-annotated override", () => {
    expect([...registerAll("editor").keys()]).toEqual(["t_read", "t_write", "t_destroy_override"]);
  });

  it("admin sees everything", () => {
    expect([...registerAll("admin").keys()]).toEqual([
      "t_read",
      "t_write",
      "t_destroy",
      "t_destroy_override",
    ]);
  });

  it("registered handlers pass through", async () => {
    const tools = registerAll("admin");
    const result = await tools.get("t_destroy")!({});
    expect(result.content[0]?.text).toBe("ok");
    expect(result.isError).toBeUndefined();
  });
});
