import { describe, expect, it } from "vitest";
import { authenticateToken, loadTokenEntries, parseTokenList } from "./tokens.js";

describe("parseTokenList", () => {
  it("parses label:token entries", () => {
    expect(parseTokenList("alice:tok1,bob:tok2", "viewer")).toEqual([
      { role: "viewer", label: "alice", token: "tok1" },
      { role: "viewer", label: "bob", token: "tok2" },
    ]);
  });

  it("tolerates whitespace", () => {
    expect(parseTokenList("  alice : tok1 ,  bob:tok2 ", "editor")).toEqual([
      { role: "editor", label: "alice", token: "tok1" },
      { role: "editor", label: "bob", token: "tok2" },
    ]);
  });

  it("auto-labels entries without a label", () => {
    expect(parseTokenList("tok1,tok2", "admin")).toEqual([
      { role: "admin", label: "admin-1", token: "tok1" },
      { role: "admin", label: "admin-2", token: "tok2" },
    ]);
  });

  it("skips empty entries", () => {
    expect(parseTokenList(",,alice:tok1,,", "viewer")).toHaveLength(1);
  });
});

describe("loadTokenEntries", () => {
  it("loads all three roles", () => {
    const entries = loadTokenEntries({
      MCP_TOKENS_VIEWER: "v:tv",
      MCP_TOKENS_EDITOR: "e:te",
      MCP_TOKENS_ADMIN: "a:ta",
    } as NodeJS.ProcessEnv);
    expect(entries.map((e) => e.role)).toEqual(["viewer", "editor", "admin"]);
  });

  it("returns empty when nothing is configured", () => {
    expect(loadTokenEntries({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("drops duplicate tokens across roles, keeping the first", () => {
    const entries = loadTokenEntries({
      MCP_TOKENS_VIEWER: "v:same",
      MCP_TOKENS_ADMIN: "a:same",
    } as NodeJS.ProcessEnv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.role).toBe("viewer");
  });
});

describe("authenticateToken", () => {
  const entries = [
    { token: "tok-viewer", role: "viewer" as const, label: "v" },
    { token: "tok-admin", role: "admin" as const, label: "a" },
  ];

  it("matches the right entry", () => {
    expect(authenticateToken("Bearer tok-admin", entries)?.role).toBe("admin");
    expect(authenticateToken("Bearer tok-viewer", entries)?.label).toBe("v");
  });

  it("rejects wrong or malformed credentials", () => {
    expect(authenticateToken("Bearer nope", entries)).toBeNull();
    expect(authenticateToken("Basic tok-admin", entries)).toBeNull();
    expect(authenticateToken("tok-admin", entries)).toBeNull();
    expect(authenticateToken(undefined, entries)).toBeNull();
    expect(authenticateToken("Bearer", entries)).toBeNull();
  });

  it("rejects everything when no tokens are configured", () => {
    expect(authenticateToken("Bearer tok-admin", [])).toBeNull();
  });
});
