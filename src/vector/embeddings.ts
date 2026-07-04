/**
 * Embedding provider — OpenAI or Azure OpenAI.
 *
 * Azure is used when both AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT are
 * set (EMBEDDING_MODEL is then the deployment name); otherwise OPENAI_API_KEY
 * selects the standard OpenAI API. If neither is configured, vector search is
 * disabled.
 */

import OpenAI, { AzureOpenAI } from "openai";
import { cleanEnv } from "../config.js";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;

export class Embedder {
  private constructor(
    private readonly client: OpenAI,
    public readonly model: string
  ) {}

  static openai(apiKey: string, model: string): Embedder {
    return new Embedder(new OpenAI({ apiKey }), model);
  }

  static azure(apiKey: string, endpoint: string, deployment: string, apiVersion: string): Embedder {
    return new Embedder(
      new AzureOpenAI({ apiKey, endpoint, deployment, apiVersion }),
      deployment
    );
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts.slice(i, i + BATCH_SIZE),
        encoding_format: "float",
      });
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((d) => d.embedding));
    }
    return vectors;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) throw new Error("Embeddings API returned no vector");
    return vector;
  }
}

export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | null {
  const model = cleanEnv(env, "EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL;
  const azureKey = cleanEnv(env, "AZURE_OPENAI_API_KEY");
  const azureEndpoint = cleanEnv(env, "AZURE_OPENAI_ENDPOINT");
  if (azureKey && azureEndpoint) {
    return Embedder.azure(
      azureKey,
      azureEndpoint,
      model,
      cleanEnv(env, "AZURE_OPENAI_API_VERSION") || "2024-02-01"
    );
  }
  const openaiKey = cleanEnv(env, "OPENAI_API_KEY");
  if (openaiKey) {
    return Embedder.openai(openaiKey, model);
  }
  return null;
}
