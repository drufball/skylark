import { getModels, getProviders } from '@earendil-works/pi-ai'
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai'

import { ollamaBaseUrl } from '@hull/lib/ollama'

// Provider-aware model resolution. A stored model is a string the runtime hands
// to pi.dev; this module turns that string into a concrete pi `Model`, picking
// the provider from a `provider/modelId` prefix. Hosted-provider models come
// from pi-ai's built-in registry; Ollama models are local and built on the fly,
// since the locally-pulled set is whatever the machine has downloaded — there's
// no fixed catalog to enumerate.

/** Provider assumed when a model string carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = 'anthropic'

/**
 * The default when nothing is configured: a small, broadly-runnable local model
 * (fits ~16GB). Skylark is local-first — a fresh clone runs on Ollama with no
 * API key. The hoist bring-up replaces this with the model it auto-selects for
 * the actual machine (writing `SKYLARK_DEFAULT_MODEL`); a crew member can also
 * point that env at a hosted model (e.g. `anthropic/claude-sonnet-4-5`).
 */
export const FALLBACK_DEFAULT_MODEL = 'ollama/qwen3:8b'

/**
 * The model a session boots with when it doesn't pin one. Reads
 * `SKYLARK_DEFAULT_MODEL` (set by hoist after hardware-aware selection, or by a
 * crew member to choose a hosted default), falling back to a local model so the
 * ship works with no configuration and no key.
 */
export function defaultModelRef(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SKYLARK_DEFAULT_MODEL?.trim()
  if (configured) return configured
  return FALLBACK_DEFAULT_MODEL
}

/**
 * The strong hosted model chat runs on when a key makes it reachable. Chat is
 * the ship's planning surface — it reviews, decides, and orchestrates builds —
 * so it wants the strongest model available, while builders stay on the cheap
 * local default.
 */
export const PREFERRED_CHAT_MODEL = 'anthropic/claude-fable-5'

/**
 * The model a chat agent's backing session boots with. `SKYLARK_CHAT_MODEL`
 * wins when set (the crew's explicit choice, key or not); otherwise the strong
 * hosted model when its provider has a key configured; otherwise the ship
 * default — so a fresh keyless clone still chats, on the local model.
 * `isProviderConfigured` is injected (the live wiring passes pi's AuthStorage
 * check) so the preference order is pure and testable.
 */
/** The conventional env var carrying a provider's API key (ANTHROPIC_API_KEY, …). */
export function providerEnvKey(provider: string): string {
  return `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`
}

/**
 * Is a provider usable? True when the credential store says so, OR when the
 * conventional env key is present — pi's `getAuthStatus` reports only its own
 * store, but its `getApiKey` (and the session run) falls back to the process
 * env, so the "add a provider key to .env" path must count here too or chat
 * silently books the local fallback while the key sits unused. A throwing
 * store degrades to the env check.
 */
export function providerConfigured(
  storeConfigured: (provider: string) => boolean,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    if (storeConfigured(provider)) return true
  } catch {
    // broken credential store — fall through to the env check
  }
  return Boolean(env[providerEnvKey(provider)]?.trim())
}

export function chatModelRef(
  isProviderConfigured: (providerId: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.SKYLARK_CHAT_MODEL?.trim()
  if (configured) return configured
  const { provider } = parseModelRef(PREFERRED_CHAT_MODEL)
  if (isProviderConfigured(provider)) return PREFERRED_CHAT_MODEL
  return defaultModelRef(env)
}

/**
 * Default context window assumed for an Ollama model. This is NOT inert
 * metadata: the runtime runs with auto-compaction on, and pi triggers
 * compaction off `model.contextWindow`. Too low and a large model compacts far
 * too early; too high and a small model overflows. Since the locally-pulled set
 * has no fixed catalog to read windows from, we use one conservative default —
 * 32k, which also matches the `num_ctx` an agentic tool-caller needs — and let
 * a deployment override it (per the env below). Reading Ollama's `/api/show`
 * `context_length` to size this exactly is a follow-up for the live bring-up.
 */
const DEFAULT_OLLAMA_CONTEXT_WINDOW = 32768
const DEFAULT_OLLAMA_MAX_TOKENS = 8192

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
 * Read a positive integer from `env`, falling back when unset or invalid.
 * `parseInt` already skips surrounding whitespace and yields NaN for unset or
 * non-numeric values, so the `> 0` filter is the only guard needed.
 */
function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const n = Number.parseInt(env[name] ?? '', 10)
  return n > 0 ? n : fallback
}

/**
 * Find the first model matching one of `ids` in a hosted provider's pi-ai
 * registry, or undefined (unknown provider included). The one place that knows
 * hosted models come from the registry: `resolveHosted` throws on a miss, while
 * a tolerant caller (e.g. the issue slug generator, which tries candidate ids
 * and degrades gracefully) takes the undefined.
 */
export function findHostedModel(
  provider: string,
  ids: string[],
): Model<Api> | undefined {
  if (!getProviders().includes(provider as KnownProvider)) return undefined
  const models = getModels(provider as KnownProvider)
  for (const id of ids) {
    const model = models.find((m) => m.id === id)
    if (model) return model
  }
  return undefined
}

/**
 * Resolve a model from any pi.dev built-in provider (Anthropic, OpenAI, Google,
 * OpenRouter, …) against its registry, or throw if the provider or model id is
 * unknown. These are the hosted providers a crew member reaches by adding an
 * API key; the key is resolved at session boot from the environment, not here.
 * `ref` is the original string, threaded through only to keep error messages
 * pointing at what the crew member actually typed.
 */
function resolveHosted(
  provider: string,
  modelId: string,
  ref: string,
): Model<Api> {
  if (!getProviders().includes(provider as KnownProvider)) {
    throw new Error(`Unknown model provider "${provider}" in "${ref}"`)
  }
  const model = findHostedModel(provider, [modelId])
  if (!model)
    throw new Error(`Unknown ${provider} model "${modelId}" in "${ref}"`)
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
    contextWindow: envInt(
      env,
      'OLLAMA_CONTEXT_WINDOW',
      DEFAULT_OLLAMA_CONTEXT_WINDOW,
    ),
    maxTokens: envInt(env, 'OLLAMA_MAX_TOKENS', DEFAULT_OLLAMA_MAX_TOKENS),
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
  if (provider === 'ollama') return resolveOllama(modelId, env)
  return resolveHosted(provider, modelId, ref)
}
