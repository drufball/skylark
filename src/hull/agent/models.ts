import { getModels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'

// Provider-aware model resolution. A stored model is a string the runtime hands
// to pi.dev; this module turns that string into a concrete pi `Model`, picking
// the provider from a `provider/modelId` prefix. Anthropic models come from
// pi-ai's built-in registry; Ollama models are local and built on the fly,
// since the locally-pulled set is whatever the machine has downloaded — there's
// no fixed catalog to enumerate.

/** Provider assumed when a model string carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = 'anthropic'

/** Where a local Ollama server exposes its OpenAI-compatible API by default. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1'

/** A model string split into its provider and the provider-local model id. */
export interface ModelRef {
  provider: string
  modelId: string
}

/**
 * Split a model string into `{ provider, modelId }`.
 *
 * - No slash → the whole string is an Anthropic model id (`claude-sonnet-4-5`),
 *   so sessions and profiles stored before provider prefixes existed still work.
 * - First slash splits provider from model. Only the *first* slash splits, so
 *   ids that themselves contain slashes (OpenRouter slugs like
 *   `qwen/qwen3-coder`) survive intact. Ollama tags use a colon, never a slash.
 */
export function parseModelRef(ref: string): ModelRef {
  const trimmed = ref.trim()
  const slash = trimmed.indexOf('/')
  if (slash === -1) {
    if (!trimmed) throw new Error('Empty model id')
    return { provider: DEFAULT_PROVIDER, modelId: trimmed }
  }
  const provider = trimmed.slice(0, slash)
  const modelId = trimmed.slice(slash + 1)
  if (!provider || !modelId) {
    throw new Error(`Malformed model ref: "${ref}"`)
  }
  return { provider, modelId }
}

/**
 * The base URL of the local Ollama OpenAI-compatible endpoint.
 *
 * `OLLAMA_BASE_URL` wins when set (a full `…/v1` URL). Otherwise we accept
 * `OLLAMA_HOST` — Ollama's own env var, which hoist/setup will set — as a
 * host[:port] or bare URL and normalize it to the `/v1` OpenAI path. Falling
 * back to the loopback default keeps a fresh clone working with no config.
 */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OLLAMA_BASE_URL?.trim()
  if (explicit) return explicit

  const host = env.OLLAMA_HOST?.trim()
  if (host) {
    const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`
    return `${withScheme.replace(/\/+$/, '')}/v1`
  }

  return DEFAULT_OLLAMA_BASE_URL
}

/** Resolve an Anthropic model id against pi-ai's built-in registry. */
function resolveAnthropic(modelId: string): Model<Api> {
  const model = getModels('anthropic').find((m) => m.id === modelId)
  if (!model) throw new Error(`Unknown Anthropic model: ${modelId}`)
  return model
}

/**
 * Build a pi `Model` for a locally-served Ollama model. Ollama speaks the
 * OpenAI completions API, so this is an `openai-completions` model pointed at
 * the local endpoint. Cost is zero (local inference is free, so usage
 * accounting never bills), and the compat flags disable OpenAI-platform-only
 * features Ollama doesn't implement — `store`, the `developer` role,
 * `reasoning_effort`, and `strict` tool schemas — which otherwise break
 * requests or tool calls against Ollama.
 */
function resolveOllama(
  modelId: string,
  env: NodeJS.ProcessEnv,
): Model<'openai-completions'> {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: ollamaBaseUrl(env),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    },
  }
}

/**
 * Resolve a stored model string to a concrete pi `Model`, or throw if the
 * provider is unknown or the model id doesn't exist for its provider. The env
 * is injectable so the Ollama endpoint is testable without touching the
 * process environment.
 */
export function resolveModel(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Model<Api> {
  const { provider, modelId } = parseModelRef(ref)
  switch (provider) {
    case 'anthropic':
      return resolveAnthropic(modelId)
    case 'ollama':
      return resolveOllama(modelId, env)
    default:
      throw new Error(`Unknown model provider "${provider}" in "${ref}"`)
  }
}
