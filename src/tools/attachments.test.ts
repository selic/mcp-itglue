import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ITGlueClient } from "../itglue/client.js";
import { toResourcePayload } from "../itglue/client.js";
import { ToolRegistrar } from "../auth/roles.js";
import type { Transport } from "../config.js";
import {
  attachmentAttributes,
  attachmentsPath,
  decodeBase64Input,
  MAX_ATTACHMENT_BYTES,
  registerAttachmentTools,
} from "./attachments.js";

describe("attachmentsPath", () => {
  it("builds the collection path", () => {
    expect(attachmentsPath("documents", 42)).toBe("/documents/42/relationships/attachments");
    expect(attachmentsPath("flexible_assets", 7)).toBe(
      "/flexible_assets/7/relationships/attachments"
    );
  });

  it("appends the attachment id when given", () => {
    expect(attachmentsPath("configurations", 3, 99)).toBe(
      "/configurations/3/relationships/attachments/99"
    );
  });
});

describe("decodeBase64Input", () => {
  it("decodes plain base64", () => {
    expect(decodeBase64Input("SGVsbG8=").toString("utf8")).toBe("Hello");
  });

  it("strips a data: URI prefix", () => {
    expect(decodeBase64Input("data:image/png;base64,SGVsbG8=").toString("utf8")).toBe("Hello");
  });

  it("ignores whitespace/newlines in the base64", () => {
    expect(decodeBase64Input("SGVs\nbG8=").toString("utf8")).toBe("Hello");
  });
});

describe("attachmentAttributes → toResourcePayload", () => {
  it("keeps the nested attachment object verbatim on the wire", () => {
    const payload = toResourcePayload("attachments", attachmentAttributes("QUJD", "diagram.png"));
    expect(payload).toEqual({
      data: {
        type: "attachments",
        attributes: { attachment: { content: "QUJD", file_name: "diagram.png" } },
      },
    });
  });
});

// ── Handler behaviour ────────────────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function setup(transport: Transport, create = vi.fn()) {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  const client = { create } as unknown as ITGlueClient;
  registerAttachmentTools(new ToolRegistrar(server, "admin"), client, transport);
  return { tools, create };
}

const base = {
  resource_type: "documents",
  resource_id: 10,
  response_format: "markdown" as const,
};

describe("itglue_create_attachment handler", () => {
  it("uploads base64 content and reports the new attachment", async () => {
    const create = vi.fn().mockResolvedValue({ id: "555", attachment_file_name: "x.png" });
    const { tools } = setup("stdio", create);

    const result = await tools.get("itglue_create_attachment")!({
      ...base,
      file_name: "x.png",
      content_base64: "SGVsbG8=",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("555");
    expect(result.content[0]?.text).toContain("x.png");
    expect(create).toHaveBeenCalledWith("/documents/10/relationships/attachments", "attachments", {
      attachment: { content: "SGVsbG8=", file_name: "x.png" },
    });
  });

  it("rejects when no image source is given", async () => {
    const { tools, create } = setup("stdio");
    const result = await tools.get("itglue_create_attachment")!({ ...base, file_name: "x.png" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/exactly one image source/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects when more than one source is given", async () => {
    const { tools } = setup("stdio");
    const result = await tools.get("itglue_create_attachment")!({
      ...base,
      file_name: "x.png",
      content_base64: "SGVsbG8=",
      url: "https://example.com/a.png",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/only one image source/i);
  });

  it("rejects file_path on the http transport", async () => {
    const { tools, create } = setup("http");
    const result = await tools.get("itglue_create_attachment")!({
      ...base,
      file_path: "/etc/hosts",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/stdio transport/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a file_name with an extension", async () => {
    const { tools } = setup("stdio");
    const result = await tools.get("itglue_create_attachment")!({
      ...base,
      content_base64: "SGVsbG8=",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/extension/i);
  });

  it("rejects files over the size cap", async () => {
    const { tools, create } = setup("stdio");
    // base64 of enough bytes to exceed the cap
    const big = "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) / 3) * 4);
    const result = await tools.get("itglue_create_attachment")!({
      ...base,
      file_name: "big.bin",
      content_base64: big,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/limit/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("registers list and delete tools for an admin", () => {
    const { tools } = setup("stdio");
    expect(tools.has("itglue_list_attachments")).toBe(true);
    expect(tools.has("itglue_delete_attachment")).toBe(true);
  });
});
