// Resolving the local Ollama server's URLs from the environment. Shared by the
// agent runtime (which talks to Ollama's OpenAI-compatible `/v1` endpoint) and
// the local-model service (which talks to Ollama's native `/api/*` admin
// endpoints) — one home for the env convention so the two can't drift.

/** Where a local Ollama server exposes its OpenAI-compatible API by default. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'

/**
 * The root URL of the local Ollama server (no path).
 *
 * `OLLAMA_BASE_URL` wins when set — a full `…/v1` URL — with its `/v1` stripped.
 * Otherwise `OLLAMA_HOST` (Ollama's own env var, which hoist/setup sets) is read
 * as a host[:port] or bare URL. Falling back to loopback keeps a fresh clone
 * working with no config.
 */
export function ollamaApiRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OLLAMA_BASE_URL?.trim()
  if (explicit) return stripV1(explicit)

  const host = env.OLLAMA_HOST?.trim()
  if (host) {
    const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`
    return withScheme.replace(/\/+$/, '')
  }

  return stripV1(DEFAULT_OLLAMA_BASE_URL)
}

/**
 * The OpenAI-compatible `/v1` endpoint of the local Ollama server — what the pi
 * runtime points an `openai-completions` model at.
 */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OLLAMA_BASE_URL?.trim()
  if (explicit) return explicit
  return `${ollamaApiRoot(env)}/v1`
}

function stripV1(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}
