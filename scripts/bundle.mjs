#!/usr/bin/env node
/**
 * Build the Claude Desktop bundle (mcp-itglue.mcpb).
 *
 * Stages manifest + dist + production-only node_modules in .mcpb-build/ so
 * the bundle doesn't drag in devDependencies, then packs it with mcpb.
 * Run via `npm run bundle` (which builds dist/ first).
 */

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const stage = ".mcpb-build";

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const file of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "README.md"]) {
  cpSync(file, `${stage}/${file}`);
}
cpSync("dist", `${stage}/dist`, { recursive: true });

execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: stage, stdio: "inherit" });
execSync(`npx -y @anthropic-ai/mcpb pack ${stage} mcp-itglue.mcpb`, { stdio: "inherit" });
