import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import {
  getDefaultModel,
  listModelProviders,
  setProviderKey as setProviderKeyFn,
  removeProviderKey as removeProviderKeyFn,
} from '@hull/agent/server'
import { listLocalModels, pullLocalModel } from '@hull/local-model/server'
import { Dock } from '@rigging/views/dock'
import { Models } from '@rigging/views/models'

// Thin mount: binds /models to the Models view and the data it needs. A pull
// runs server-side and takes a while, so the page polls the loader while any
// pull is in flight and clears each model from "pulling" once it appears.

export const Route = createFileRoute('/models')({
  loader: async () => {
    const [local, providers, def] = await Promise.all([
      listLocalModels(),
      listModelProviders(),
      getDefaultModel(),
    ])
    return { local, providers, defaultRef: def.ref }
  },
  component: ModelsRoute,
})

function ModelsRoute() {
  const { local, providers, defaultRef } = Route.useLoaderData()
  const router = useRouter()
  const [requested, setRequested] = useState<string[]>([])

  // A model is still "pulling" only until it shows up installed. Deriving this
  // (rather than pruning state in an effect) means a stale `requested` entry is
  // harmless — it just filters out — and there's one source of truth.
  const installedNames = new Set(local.installed.map((m) => m.name))
  const pulling = requested.filter((m) => !installedNames.has(m))

  // Poll the loader while a pull is in flight so the model flips to "installed".
  useEffect(() => {
    if (pulling.length === 0) return
    const id = setInterval(() => {
      void router.invalidate()
    }, 4000)
    return () => {
      clearInterval(id)
    }
  }, [pulling.length, router])

  async function onPull(model: string) {
    setRequested((prev) => (prev.includes(model) ? prev : [...prev, model]))
    await pullLocalModel({ data: model })
  }

  async function onSaveKey(provider: string, key: string) {
    await setProviderKeyFn({ data: { provider, key } })
    await router.invalidate()
  }

  async function onRemoveKey(provider: string) {
    await removeProviderKeyFn({ data: provider })
    await router.invalidate()
  }

  return (
    <Dock active="models" Link={Link}>
      <Models
        defaultRef={defaultRef}
        installed={local.installed}
        catalog={local.catalog}
        recommended={local.recommended}
        providers={providers}
        pulling={pulling}
        onPull={(m) => void onPull(m)}
        onSaveKey={(p, k) => void onSaveKey(p, k)}
        onRemoveKey={(p) => void onRemoveKey(p)}
      />
    </Dock>
  )
}
