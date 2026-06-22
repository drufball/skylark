import { execFile } from 'node:child_process'
import { arch as osArch, cpus, platform as osPlatform, totalmem } from 'node:os'
import { promisify } from 'node:util'

import { OLLAMA_PROVIDER } from '@hull/lib/ollama'

import { LOCAL_MODEL_CATALOG, type LocalModelSpec } from './catalog'

// Pick a local model that fits the machine. The logic splits in two: the
// impure `detectHardware` reads the OS (RAM, arch) and probes the GPU, while
// the pure `usableMemoryGB`/`selectModel` map a `Hardware` snapshot to a model.
// The pure half is unit-tested across every memory tier; the probe is injected
// so tests never shell out.

/**
 * Apple Silicon shares one memory pool between CPU and GPU; Metal will hand the
 * GPU roughly two-thirds to three-quarters of it. ~70% is a safe working budget
 * that leaves the OS and apps room.
 */
const UNIFIED_MEMORY_FRACTION = 0.7

/**
 * With no GPU the model runs from system RAM on the CPU; budget ~65% so the box
 * stays usable while inference runs.
 */
const CPU_MEMORY_FRACTION = 0.65

/** A snapshot of what the machine can offer an inference runtime. */
export interface Hardware {
  platform: NodeJS.Platform
  arch: string
  /** Total system memory, in GB (decimal, 1 dp). */
  totalMemGB: number
  /** Largest discrete-GPU VRAM in GB, if a GPU was detected. */
  vramGB?: number
  /** Apple Silicon: CPU and GPU share one memory pool. */
  isUnifiedMemory: boolean
  cpuCount: number
}

/** The model chosen for a machine, plus the reasoning behind it. */
export interface ModelSelection {
  /** Bare Ollama tag, e.g. "qwen3-coder:30b" — what `ollama pull` takes. */
  model: string
  /** Provider-prefixed ref for the agent runtime, e.g. "ollama/qwen3-coder:30b". */
  modelRef: string
  /** Usable memory budget the choice was made against, in GB. */
  usableMemGB: number
  /** The hardware snapshot the choice was made from. */
  hardware: Hardware
  /** False when even the smallest model is a tight fit — surface a warning. */
  fitsComfortably: boolean
  /** One-line explanation for setup output. */
  reason: string
}

function round1(gb: number): number {
  return Math.round(gb * 10) / 10
}

/**
 * The memory budget to size a model against. Unified-memory machines share RAM
 * with the GPU (budget a fraction of total); a discrete GPU is sized by its
 * VRAM (what runs fast on-device); otherwise it's CPU inference from RAM.
 */
export function usableMemoryGB(hw: Hardware): number {
  if (hw.isUnifiedMemory) return round1(hw.totalMemGB * UNIFIED_MEMORY_FRACTION)
  // Detection yields undefined or a positive number, so a truthy check is enough.
  if (hw.vramGB) return hw.vramGB
  return round1(hw.totalMemGB * CPU_MEMORY_FRACTION)
}

/**
 * Choose the largest catalog model whose `minMemGB` fits the usable budget. If
 * nothing fits (a very small machine), fall back to the smallest model and flag
 * the tight fit so callers can warn rather than silently ship a model that
 * crawls.
 */
export function selectModel(
  hw: Hardware,
  catalog: LocalModelSpec[] = LOCAL_MODEL_CATALOG,
): ModelSelection {
  const usableMemGB = usableMemoryGB(hw)
  const fitting = catalog.filter((spec) => spec.minMemGB <= usableMemGB)
  const fitsComfortably = fitting.length > 0
  const chosen = fitsComfortably ? fitting[fitting.length - 1] : catalog[0]
  const reason = fitsComfortably
    ? `${chosen.label} — ${String(usableMemGB)}GB usable. ${chosen.notes}`
    : `${chosen.label} — only ${String(usableMemGB)}GB usable; this is a tight fit and may run slowly.`
  return {
    model: chosen.model,
    modelRef: `${OLLAMA_PROVIDER}/${chosen.model}`,
    usableMemGB,
    hardware: hw,
    fitsComfortably,
    reason,
  }
}

/** Injectable OS/probe readers, so detection is testable without real hardware. */
export interface DetectDeps {
  platform: () => NodeJS.Platform
  arch: () => string
  totalmem: () => number
  cpus: () => unknown[]
  /** Resolve discrete-GPU VRAM in GB, or undefined if none/unknown. */
  detectVramGB: () => Promise<number | undefined>
}

/**
 * Read a `Hardware` snapshot from this machine. Apple Silicon is flagged as
 * unified memory and skips the VRAM probe (there's no separate VRAM — the GPU
 * uses system RAM). Everything else probes for a discrete GPU.
 */
export async function detectHardware(
  deps: Partial<DetectDeps> = {},
): Promise<Hardware> {
  const d: DetectDeps = { ...defaultDetectDeps, ...deps }
  const platform = d.platform()
  const arch = d.arch()
  const isUnifiedMemory = platform === 'darwin' && arch === 'arm64'
  const totalMemGB = round1(d.totalmem() / 1e9)
  const vramGB = isUnifiedMemory ? undefined : await d.detectVramGB()
  return {
    platform,
    arch,
    totalMemGB,
    vramGB,
    isUnifiedMemory,
    cpuCount: d.cpus().length,
  }
}

/* v8 ignore start -- live OS/GPU probing; the pure selection logic is unit-tested */
const execFileAsync = promisify(execFile)

/**
 * Discrete-GPU VRAM via `nvidia-smi` — dependency-free and works on any unix
 * terminal. Returns the largest GPU's VRAM in GB, or undefined when nvidia-smi
 * is absent (no NVIDIA GPU, or an Apple/AMD/CPU-only box), in which case
 * selection falls back to a RAM budget.
 */
async function nvidiaVramGB(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.total',
      '--format=csv,noheader,nounits',
    ])
    const mbs = stdout
      .trim()
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (mbs.length === 0) return undefined
    return round1(Math.max(...mbs) / 1024)
  } catch {
    return undefined
  }
}

const defaultDetectDeps: DetectDeps = {
  platform: osPlatform,
  arch: osArch,
  totalmem,
  cpus,
  detectVramGB: nvidiaVramGB,
}
/* v8 ignore stop */
