import { describe, expect, it, vi } from 'vitest'

import { LOCAL_MODEL_CATALOG } from './catalog'
import { detectHardware, selectModel, usableMemoryGB } from './service'
import type { Hardware } from './service'

function hw(overrides: Partial<Hardware>): Hardware {
  return {
    platform: 'linux',
    arch: 'x64',
    totalMemGB: 16,
    vramGB: undefined,
    isUnifiedMemory: false,
    cpuCount: 8,
    ...overrides,
  }
}

describe('usableMemoryGB', () => {
  it('budgets ~70% of unified memory (Apple Silicon shares RAM with the GPU)', () => {
    expect(usableMemoryGB(hw({ isUnifiedMemory: true, totalMemGB: 16 }))).toBe(
      11.2,
    )
    expect(usableMemoryGB(hw({ isUnifiedMemory: true, totalMemGB: 8 }))).toBe(
      5.6,
    )
  })

  it('uses discrete VRAM when present (GPU-bound for good speed)', () => {
    expect(usableMemoryGB(hw({ vramGB: 24 }))).toBe(24)
  })

  it('falls back to ~65% of system RAM with no GPU (CPU inference)', () => {
    expect(usableMemoryGB(hw({ totalMemGB: 32, vramGB: undefined }))).toBe(20.8)
  })
})

describe('selectModel', () => {
  it('picks the 4B model for an 8GB Mac (16GB-and-down step-down)', () => {
    const sel = selectModel(hw({ isUnifiedMemory: true, totalMemGB: 8 }))
    expect(sel.model).toBe('qwen3:4b')
    expect(sel.modelRef).toBe('ollama/qwen3:4b')
    expect(sel.fitsComfortably).toBe(true)
  })

  it('picks the 8B tool-caller for a 16GB Mac', () => {
    const sel = selectModel(hw({ isUnifiedMemory: true, totalMemGB: 16 }))
    expect(sel.model).toBe('qwen3:8b')
  })

  it('picks the 30B coder for a 32GB Mac', () => {
    const sel = selectModel(hw({ isUnifiedMemory: true, totalMemGB: 32 }))
    expect(sel.model).toBe('qwen3-coder:30b')
  })

  it('picks the 30B coder for a 64GB Mac', () => {
    const sel = selectModel(hw({ isUnifiedMemory: true, totalMemGB: 64 }))
    expect(sel.model).toBe('qwen3-coder:30b')
  })

  it('picks the 30B coder for a 24GB-VRAM Linux GPU box', () => {
    const sel = selectModel(hw({ vramGB: 24, totalMemGB: 64 }))
    expect(sel.model).toBe('qwen3-coder:30b')
  })

  it('picks the 8B for a CPU-only 16GB Linux box', () => {
    const sel = selectModel(hw({ totalMemGB: 16, vramGB: undefined }))
    expect(sel.model).toBe('qwen3:8b')
  })

  it('falls back to the smallest model and flags a tight fit on tiny machines', () => {
    const sel = selectModel(hw({ isUnifiedMemory: true, totalMemGB: 4 }))
    expect(sel.model).toBe(LOCAL_MODEL_CATALOG[0].model)
    expect(sel.fitsComfortably).toBe(false)
  })

  it('always selects a model that exists in the catalog', () => {
    const sel = selectModel(hw({ totalMemGB: 32 }))
    expect(LOCAL_MODEL_CATALOG.map((s) => s.model)).toContain(sel.model)
  })
})

describe('detectHardware', () => {
  it('marks Apple Silicon as unified memory and skips the VRAM probe', async () => {
    const detectVramGB = vi.fn(() => Promise.resolve(99))
    const detected = await detectHardware({
      platform: () => 'darwin',
      arch: () => 'arm64',
      totalmem: () => 32 * 1e9,
      cpus: () => Array.from({ length: 12 }),
      detectVramGB,
    })
    expect(detected.isUnifiedMemory).toBe(true)
    expect(detected.totalMemGB).toBe(32)
    expect(detected.vramGB).toBeUndefined()
    expect(detectVramGB).not.toHaveBeenCalled()
  })

  it('probes VRAM on a discrete-GPU Linux box', async () => {
    const detected = await detectHardware({
      platform: () => 'linux',
      arch: () => 'x64',
      totalmem: () => 64 * 1e9,
      cpus: () => Array.from({ length: 16 }),
      detectVramGB: () => Promise.resolve(24),
    })
    expect(detected.isUnifiedMemory).toBe(false)
    expect(detected.vramGB).toBe(24)
    expect(detected.cpuCount).toBe(16)
  })
})
