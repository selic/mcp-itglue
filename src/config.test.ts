import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { embedderFromEnv } from "./vector/embeddings.js";

const KEY = { ITGLUE_API_KEY: "ITG.test" };

describe("loadConfig — desktop host env quirks", () => {
  it("falls back to the region URL when ITGLUE_BASE_URL is an empty string", () => {
    const config = loadConfig([], { ...KEY, ITGLUE_BASE_URL: "" });
    expect(config.baseUrl).toBe("https://api.itglue.com");
  });

  it("ignores an unsubstituted ${user_config.…} template in ITGLUE_BASE_URL", () => {
    const config = loadConfig([], {
      ...KEY,
      ITGLUE_BASE_URL: "${user_config.itglue_base_url}",
      ITGLUE_REGION: "eu",
    });
    expect(config.baseUrl).toBe("https://api.eu.itglue.com");
  });

  it("ignores unsubstituted templates in region and index path", () => {
    const config = loadConfig([], {
      ...KEY,
      ITGLUE_REGION: "${user_config.itglue_region}",
      VECTOR_INDEX_PATH: "${user_config.index_path}",
    });
    expect(config.baseUrl).toBe("https://api.itglue.com");
    expect(config.vectorIndexPath).toBe("./vector-index.json");
  });

  it("treats a template-valued ITGLUE_API_KEY as missing", () => {
    expect(() => loadConfig([], { ITGLUE_API_KEY: "${user_config.itglue_api_key}" })).toThrow(
      ConfigError
    );
  });

  it("rejects a base URL that is not a valid http(s) URL", () => {
    expect(() => loadConfig([], { ...KEY, ITGLUE_BASE_URL: "api.itglue.com" })).toThrow(
      /Invalid IT Glue base URL/
    );
    expect(() => loadConfig(["--base-url", "ftp://example.com"], { ...KEY })).toThrow(
      /must be http\(s\)/
    );
  });

  it("still honors a real ITGLUE_BASE_URL and strips trailing slashes", () => {
    const config = loadConfig([], { ...KEY, ITGLUE_BASE_URL: "https://proxy.example.com/itglue/" });
    expect(config.baseUrl).toBe("https://proxy.example.com/itglue");
  });
});

describe("embedderFromEnv — desktop host env quirks", () => {
  it("stays disabled when OPENAI_API_KEY is an unsubstituted template or empty", () => {
    expect(embedderFromEnv({ OPENAI_API_KEY: "${user_config.openai_api_key}" })).toBeNull();
    expect(embedderFromEnv({ OPENAI_API_KEY: "" })).toBeNull();
  });

  it("is enabled for a real key", () => {
    expect(embedderFromEnv({ OPENAI_API_KEY: "sk-test" })).not.toBeNull();
  });
});
