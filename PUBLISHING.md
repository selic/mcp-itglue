# Publishing

Release checklist for maintainers. Versions must match in three places: `package.json`, and both `version` fields in `server.json` (server + package entry).

## 1. npm

```bash
npm login                 # once per machine
npm publish               # prepublishOnly runs the build
```

Tagged releases are also published automatically by CI (`.github/workflows/release.yml`) when a `v*` tag is pushed — that path needs an `NPM_TOKEN` repository secret (npm automation token).

## 2. MCP registry (registry.modelcontextprotocol.io)

Publish **after** the npm package is live — the registry validates that the npm package exists and matches `server.json`.

Install the publisher CLI ([docs](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md)):

```bash
brew install mcp-publisher
# or: git clone https://github.com/modelcontextprotocol/registry && cd registry && make publisher
```

Then, from the repo root:

```bash
mcp-publisher login github     # opens a device-code flow; authorizes the io.github.selic/* namespace
mcp-publisher publish          # reads ./server.json
```

The npm package must prove namespace ownership: `package.json` contains the matching
`mcpName` field (`io.github.selic/mcp-itglue`) which the registry checks against the
published tarball.

## 3. Claude Desktop bundle (.mcpb)

```bash
npm run bundle                 # builds dist/ and packs mcp-itglue.mcpb
```

CI attaches the bundle to the GitHub release on tag push. To build locally for testing, open the `.mcpb` file with Claude Desktop.

## Release flow (all of the above)

```bash
npm version patch              # bumps package.json, creates the v* tag
# update both version fields in server.json to match, amend the version commit
git push origin main --follow-tags
# CI: builds, publishes to npm, creates the GitHub release with the .mcpb
mcp-publisher login github && mcp-publisher publish
```
