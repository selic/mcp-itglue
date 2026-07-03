/**
 * Bearer-token authentication with per-role token pools.
 *
 * Tokens are configured through three environment variables, one per role:
 *
 *   MCP_TOKENS_VIEWER="alice:tok1,bob:tok2"
 *   MCP_TOKENS_EDITOR="automation:tok3"
 *   MCP_TOKENS_ADMIN="ops:tok4"
 *
 * Each entry is `label:token`; the label identifies the holder in audit logs
 * and lets individual tokens be revoked. Entries without a label get an
 * auto-generated one (`viewer-1`, ...). Tokens must be unique across roles —
 * duplicates are dropped with a warning.
 */

import { timingSafeEqual } from "node:crypto";

export type Role = "viewer" | "editor" | "admin";

export interface TokenEntry {
  token: string;
  role: Role;
  label: string;
}

const ROLE_ENV_VARS: Array<[Role, string]> = [
  ["viewer", "MCP_TOKENS_VIEWER"],
  ["editor", "MCP_TOKENS_EDITOR"],
  ["admin", "MCP_TOKENS_ADMIN"],
];

export function parseTokenList(raw: string, role: Role): TokenEntry[] {
  const entries: TokenEntry[] = [];
  let unlabeled = 0;
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep > 0 && sep < trimmed.length - 1) {
      entries.push({
        role,
        label: trimmed.slice(0, sep).trim(),
        token: trimmed.slice(sep + 1).trim(),
      });
    } else {
      unlabeled += 1;
      entries.push({ role, label: `${role}-${unlabeled}`, token: trimmed.replace(/^:|:$/g, "") });
    }
  }
  return entries.filter((e) => e.token.length > 0);
}

/** Load all configured token entries; duplicate token values are dropped. */
export function loadTokenEntries(env: NodeJS.ProcessEnv = process.env): TokenEntry[] {
  const entries: TokenEntry[] = [];
  for (const [role, envVar] of ROLE_ENV_VARS) {
    const raw = env[envVar];
    if (raw) entries.push(...parseTokenList(raw, role));
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.token)) {
      console.error(
        `[auth] Warning: duplicate token for "${entry.label}" (${entry.role}) ignored — tokens must be unique across roles.`
      );
      return false;
    }
    seen.add(entry.token);
    return true;
  });
}

/** Timing-safe string comparison for secrets. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) return null;
  return parts[1];
}

/** Match an Authorization header against the configured tokens. */
export function authenticateToken(
  authorizationHeader: string | undefined,
  entries: TokenEntry[]
): TokenEntry | null {
  const presented = bearerToken(authorizationHeader);
  if (!presented) return null;
  for (const entry of entries) {
    if (safeEquals(presented, entry.token)) return entry;
  }
  return null;
}
