/**
 * Server configuration, resolved from CLI flags and environment variables.
 *
 * Environment variables:
 *   ITGLUE_API_KEY        Server-wide IT Glue API key (optional when client keys are enabled)
 *   ITGLUE_REGION         us | eu | au (default: us)
 *   ITGLUE_BASE_URL       Full API base URL (overrides ITGLUE_REGION)
 *   TRANSPORT             stdio | http (default: stdio)
 *   PORT                  HTTP port (default: 3000)
 *   CLIENT_ITGLUE_KEYS    disabled | with-token | open (default: with-token)
 *                         Controls whether HTTP clients may supply their own
 *                         IT Glue API key via the x-itglue-api-key header.
 *   MCP_TOKENS_VIEWER     Comma-separated label:token list for the viewer role
 *   MCP_TOKENS_EDITOR     Comma-separated label:token list for the editor role
 *   MCP_TOKENS_ADMIN      Comma-separated label:token list for the admin role
 *   ALLOWED_ORIGINS       Comma-separated browser origins additionally allowed on
 *                         /mcp (e.g. https://app.example.com). Localhost origins
 *                         and requests without an Origin header always pass.
 *   ITGLUE_WEBHOOK_SECRET Shared secret for /webhook/itglue (HMAC) and /index/refresh
 *   VECTOR_INDEX_PATH     Path of the persisted vector index (default: ./vector-index.json)
 *   OPENAI_API_KEY        Enables vector search (OpenAI embeddings)
 *   AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT
 *                         Enables vector search via Azure OpenAI (takes priority)
 *   EMBEDDING_MODEL       Embedding model or Azure deployment name
 *                         (default: text-embedding-3-small)
 */

export const REGION_BASE_URLS: Record<string, string> = {
  us: "https://api.itglue.com",
  eu: "https://api.eu.itglue.com",
  au: "https://api.au.itglue.com",
};

export type Transport = "stdio" | "http";
export type ClientKeyMode = "disabled" | "with-token" | "open";

const CLIENT_KEY_MODES: ClientKeyMode[] = ["disabled", "with-token", "open"];

export interface ServerConfig {
  transport: Transport;
  port: number;
  baseUrl: string;
  /** Server-wide IT Glue API key. May be absent when client-supplied keys are enabled. */
  apiKey: string | undefined;
  clientKeyMode: ClientKeyMode;
  /** Browser origins additionally allowed on /mcp (localhost always passes). */
  allowedOrigins: string[];
  webhookSecret: string | undefined;
  vectorIndexPath: string;
}

export class ConfigError extends Error {}

/**
 * Read an env var defensively: desktop/MCPB hosts pass unfilled optional
 * user_config fields as empty strings or leave the "${user_config.…}"
 * template unsubstituted — both must fall through to the default.
 */
export function cleanEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (!value || value.includes("${")) return undefined;
  return value;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigError(`Missing value for ${name}`);
  }
  return value;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ServerConfig {
  const transport = (flagValue(argv, "--transport") || cleanEnv(env, "TRANSPORT") || "stdio") as Transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(`Invalid transport "${transport}" — expected "stdio" or "http"`);
  }

  const portRaw = flagValue(argv, "--port") || cleanEnv(env, "PORT") || "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid port "${portRaw}"`);
  }

  const region = (flagValue(argv, "--region") || cleanEnv(env, "ITGLUE_REGION") || "us").toLowerCase();
  const regionUrl = REGION_BASE_URLS[region];
  if (!regionUrl) {
    throw new ConfigError(
      `Unknown IT Glue region "${region}" — expected one of: ${Object.keys(REGION_BASE_URLS).join(", ")}`
    );
  }
  const baseUrl = flagValue(argv, "--base-url") || cleanEnv(env, "ITGLUE_BASE_URL") || regionUrl;
  let baseUrlProtocol: string;
  try {
    baseUrlProtocol = new URL(baseUrl).protocol;
  } catch {
    throw new ConfigError(`Invalid IT Glue base URL "${baseUrl}" — expected e.g. https://api.itglue.com`);
  }
  if (baseUrlProtocol !== "https:" && baseUrlProtocol !== "http:") {
    throw new ConfigError(`Invalid IT Glue base URL "${baseUrl}" — must be http(s)`);
  }

  const clientKeyMode = (cleanEnv(env, "CLIENT_ITGLUE_KEYS") || "with-token") as ClientKeyMode;
  if (!CLIENT_KEY_MODES.includes(clientKeyMode)) {
    throw new ConfigError(
      `Invalid CLIENT_ITGLUE_KEYS "${clientKeyMode}" — expected one of: ${CLIENT_KEY_MODES.join(", ")}`
    );
  }

  const apiKey = cleanEnv(env, "ITGLUE_API_KEY");

  if (transport === "stdio" && !apiKey) {
    throw new ConfigError("ITGLUE_API_KEY is required for stdio transport");
  }
  if (transport === "http" && !apiKey && clientKeyMode === "disabled") {
    throw new ConfigError(
      "ITGLUE_API_KEY is required when CLIENT_ITGLUE_KEYS=disabled — there is no key the server could use"
    );
  }

  const allowedOrigins = (cleanEnv(env, "ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);

  return {
    transport,
    port,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    clientKeyMode,
    allowedOrigins,
    webhookSecret: cleanEnv(env, "ITGLUE_WEBHOOK_SECRET"),
    vectorIndexPath: cleanEnv(env, "VECTOR_INDEX_PATH") || "./vector-index.json",
  };
}
