import { ollamaApiRoot } from '@hull/lib/ollama'

// A thin client for Ollama's native `/api/*` admin endpoints — listing and
// pulling models, which the OpenAI-compatible `/v1` surface doesn't cover. The
// fetch impl and env are injected so the logic is unit-tested without a daemon.

/** An Ollama model already pulled onto this machine. */
export interface InstalledModel {
  /** The model tag, e.g. "qwen3-coder:30b". */
  name: string
  /** On-disk size in bytes. */
  sizeBytes: number
}

/** The provider-prefixed runtime ref for an installed Ollama model. */
export function localModelRef(model: InstalledModel): string {
  return `ollama/${model.name}`
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>

/** List the models Ollama has pulled locally (GET /api/tags). */
export async function listInstalledModels(
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstalledModel[]> {
  const res = await fetchImpl(`${ollamaApiRoot(env)}/api/tags`)
  if (!res.ok) {
    throw new Error(`Ollama /api/tags failed: ${String(res.status)}`)
  }
  const body = (await res.json()) as {
    models?: { name: string; size?: number }[]
  }
  return (body.models ?? []).map((m) => ({
    name: m.name,
    sizeBytes: m.size ?? 0,
  }))
}

/**
 * Pull a model (POST /api/pull). Resolves when the pull completes; rejects if
 * the daemon errors. Uses `stream: false` so the call is a single request —
 * callers that don't want to block fire this and poll `listInstalledModels`.
 */
export async function pullModel(
  model: string,
  fetchImpl: FetchLike = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const res = await fetchImpl(`${ollamaApiRoot(env)}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false }),
  })
  if (!res.ok) {
    throw new Error(`Ollama pull failed: ${String(res.status)}`)
  }
}
