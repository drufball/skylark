import { createServerFn } from '@tanstack/react-start'

import { errorMessage } from '@hull/lib/errors'

import { LOCAL_MODEL_CATALOG } from './catalog'
import { listInstalledModels, pullModel } from './ollama-client'
import { detectHardware, selectModel } from './service'

// The web doors onto the local-model service: what's installed, what the
// catalog offers, what this machine should run, and a way to pull more.

/**
 * The local-model picture: models already pulled, the catalog of suggestions,
 * and the model auto-selected for this machine. If the Ollama daemon is down,
 * `installed` is empty rather than an error — the page still renders.
 */
export const listLocalModels = createServerFn({ method: 'GET' }).handler(
  async () => {
    const hardware = await detectHardware()
    const installed = await listInstalledModels().catch((err: unknown) => {
      console.error(`ollama list failed: ${errorMessage(err)}`)
      return []
    })
    return {
      installed,
      catalog: LOCAL_MODEL_CATALOG,
      recommended: selectModel(hardware),
    }
  },
)

/**
 * Start pulling a model. Fire-and-forget: a pull can take minutes (and gigabytes),
 * so we don't hold the request open — the UI polls `listLocalModels` until the
 * model appears. Failures land in the server log.
 */
export const pullLocalModel = createServerFn({ method: 'POST' })
  .validator((model: string) => model)
  .handler(({ data: model }) => {
    void pullModel(model).catch((err: unknown) => {
      console.error(`ollama pull ${model} failed: ${errorMessage(err)}`)
    })
    return Promise.resolve({ ok: true })
  })
