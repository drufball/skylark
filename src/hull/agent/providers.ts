// The hosted model providers Skylark surfaces in the model-management UI: the
// ones a crew member can switch on by adding an API key. Resolution already
// works for any pi.dev provider (see models.ts); this is the curated set we
// *show* and manage keys for. Ollama (local) isn't here — it needs no key.

export interface ProviderInfo {
  /** pi.dev provider id, e.g. "anthropic". */
  id: string
  /** Display name for the UI. */
  label: string
  /** Where to get a key. */
  consoleUrl: string
}

export const HOSTED_PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    consoleUrl: 'https://console.anthropic.com',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    consoleUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (DeepSeek, Kimi, GLM, Qwen…)',
    consoleUrl: 'https://openrouter.ai/keys',
  },
]

export interface ProviderStatus extends ProviderInfo {
  /** True when a key is configured (env var or stored credential). */
  configured: boolean
}

/**
 * Pair each hosted provider with whether it has auth configured. The
 * `isConfigured` predicate is injected so this stays pure and testable — the
 * live wiring passes a check backed by pi's AuthStorage.
 */
export function providersWithStatus(
  isConfigured: (providerId: string) => boolean,
): ProviderStatus[] {
  return HOSTED_PROVIDERS.map((provider) => ({
    ...provider,
    configured: isConfigured(provider.id),
  }))
}

/** True if `id` is one of the curated hosted providers. */
export function isHostedProvider(id: string): boolean {
  return HOSTED_PROVIDERS.some((p) => p.id === id)
}
