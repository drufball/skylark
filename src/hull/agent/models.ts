import type { Model } from '@earendil-works/pi-ai'

// Model resolution through the LiteLLM gateway. A stored model is a string the
// runtime hands to pi.dev; this module turns that string into a concrete pi
// `Model` pointed at the gateway. The app knows exactly one inference endpoint
// — which providers back which model names is the gateway's business
// (litellm.config.yaml), so swapping providers (hosted or local) never touches
// app code.

/**
 * The default when nothing is configured: the strong hosted model. Every
 * session that doesn't pin a model boots on this; `SKYLARK_DEFAULT_MODEL`
 * overrides it. The name must exist in litellm.config.yaml's model_list.
 */
export const FALLBACK_DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * The model a session boots with when it doesn't pin one. Reads
 * `SKYLARK_DEFAULT_MODEL` (a crew member's explicit choice), falling back to
 * the strong hosted default.
 */
export function defaultModelRef(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SKYLARK_DEFAULT_MODEL?.trim()
  if (configured) return configured
  return FALLBACK_DEFAULT_MODEL
}

/** Where the LiteLLM gateway listens when `SKYLARK_GATEWAY_URL` is unset. */
const DEFAULT_GATEWAY_URL = 'http://localhost:4000'

/**
 * The gateway's OpenAI-compatible endpoint (…/v1). `SKYLARK_GATEWAY_URL`
 * points at a gateway elsewhere (with or without the /v1 suffix); the default
 * is the LiteLLM container `docker compose` brings up next to Postgres.
 */
export function gatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SKYLARK_GATEWAY_URL?.trim()
  if (configured) return withV1(configured)
  return withV1(DEFAULT_GATEWAY_URL)
}

/** Normalize a gateway root to its OpenAI-compatible /v1 endpoint. */
function withV1(root: string): string {
  const trimmed = root.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * The key sent to the gateway. `LITELLM_MASTER_KEY` is shared with the
 * gateway container (docker-compose passes the same env var), so app and
 * gateway agree by construction; the fallback matches the compose default for
 * the local, not-exposed gateway.
 */
export function gatewayApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LITELLM_MASTER_KEY?.trim()
  if (configured) return configured
  return 'sk-litellm'
}

/**
 * Default context window assumed for a gateway model. This is NOT inert
 * metadata: the runtime runs with auto-compaction on, and pi triggers
 * compaction off `model.contextWindow`. The gateway's OpenAI-compatible
 * surface doesn't advertise windows, so we assume the default model's class
 * (Claude Sonnet: 200k) and let a deployment override per env below — e.g.
 * point the config at a small local model and shrink the window to match.
 */
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_MAX_TOKENS = 32768

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
 * Resolve a stored model string to a concrete pi `Model` pointed at the
 * gateway. The ref passes through verbatim as the gateway model name — the
 * gateway's config decides what backs it (a hosted provider, a local server,
 * a wildcard route). Cost is zero because the gateway owns accounting, and
 * the compat flags disable OpenAI-platform-only features (`store`, the
 * `developer` role, `reasoning_effort`, `strict` tool schemas) that the
 * provider behind a given name may not implement. The env is injectable so
 * the endpoint and window are testable without touching the process
 * environment.
 */
export function resolveModel(
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): Model<'openai-completions'> {
  const id = ref.trim()
  if (!id) throw new Error('Empty model id')
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'litellm',
    baseUrl: gatewayBaseUrl(env),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: envInt(
      env,
      'SKYLARK_MODEL_CONTEXT_WINDOW',
      DEFAULT_CONTEXT_WINDOW,
    ),
    maxTokens: envInt(env, 'SKYLARK_MODEL_MAX_TOKENS', DEFAULT_MAX_TOKENS),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    },
  }
}

/**
 * Extract model names from the gateway's `GET /v1/models` response
 * (`{ data: [{ id }, …] }`). Tolerant of junk: the caller treats the gateway
 * as best-effort (down → empty list), so a surprising payload must degrade
 * the same way, never throw.
 */
export function parseGatewayModels(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
}
