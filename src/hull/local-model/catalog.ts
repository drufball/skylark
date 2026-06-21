// The local-model catalog: the Ollama models Skylark auto-selects from by
// detected memory. Ordered smallest → largest; `selectModel` picks the largest
// whose `minMemGB` fits the machine's usable memory budget.
//
// Choices (mid-2026): the Qwen3 family for reliable tool-calling (an agentic
// coding assistant lives or dies on tool calls), with Qwen3-Coder-30B-A3B — an
// MoE that runs at ~3B speed with 30B quality — as the coding default once
// there's room. The famous big open models (Kimi K2, DeepSeek, GLM flagship)
// are 200–600GB and don't run on this class of machine; those arrive via API
// keys, not here.

export interface LocalModelSpec {
  /** Ollama model tag, e.g. "qwen3-coder:30b". */
  model: string
  /**
   * Minimum usable memory (GB) to run this acceptably at its default
   * quantization, leaving headroom for the KV cache at a working context.
   */
  minMemGB: number
  /** Human label for setup output and the model picker. */
  label: string
  /** One line on why this tier — surfaced during setup. */
  notes: string
}

/** Smallest → largest. Keep `minMemGB` ascending so selection stays monotonic. */
export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    model: 'qwen3:4b',
    minMemGB: 3,
    label: 'Qwen3 4B',
    notes: 'Fits ~8GB machines; reliable tool-calling for a small agent.',
  },
  {
    model: 'qwen3:8b',
    minMemGB: 6,
    label: 'Qwen3 8B',
    notes: 'Strong small tool-caller; the ~16GB default.',
  },
  {
    model: 'qwen3-coder:30b',
    minMemGB: 20,
    label: 'Qwen3-Coder 30B-A3B',
    notes: 'Agentic coding default for 32GB+ — 30B quality at ~3B MoE speed.',
  },
]
