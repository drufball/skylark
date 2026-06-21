import { useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'

import type { LocalModelSpec } from '@hull/local-model/catalog'
import type { InstalledModel } from '@hull/local-model/ollama-client'
import type { ModelSelection } from '@hull/local-model/service'
import type { ProviderStatus } from '@hull/agent/providers'
import { Button } from '@rigging/components/ui/button'
import { cn } from '@rigging/lib/utils'

// The Models surface: what runs the crew's agents. Local (Ollama) models on top
// — Skylark is local-first — then hosted providers you switch on with a key.
// Presentational: data in as props, actions out as callbacks, so it's testable
// without a server or router.

export interface ModelsData {
  /** The model new sessions default to, e.g. "ollama/qwen3-coder:30b". */
  defaultRef: string
  installed: InstalledModel[]
  catalog: LocalModelSpec[]
  /** The model auto-selected for this machine. */
  recommended: ModelSelection
  providers: ProviderStatus[]
}

export interface ModelsProps extends ModelsData {
  /** Model tags currently being pulled (show a spinner, disable the button). */
  pulling: string[]
  onPull: (model: string) => void
  onSaveKey: (provider: string, key: string) => void
  onRemoveKey: (provider: string) => void
}

function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`
}

export function Models({
  defaultRef,
  installed,
  catalog,
  recommended,
  providers,
  pulling,
  onPull,
  onSaveKey,
  onRemoveKey,
}: ModelsProps) {
  const installedNames = new Set(installed.map((m) => m.name))

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Models</h1>
        <p className="text-sm text-muted-foreground">
          Default:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
            {defaultRef}
          </code>{' '}
          — set <code>SKYLARK_DEFAULT_MODEL</code> in <code>.env</code> to
          change it, or pin a model per agent profile.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Local models (Ollama)</h2>
        <p className="text-sm text-muted-foreground">
          Recommended for this machine:{' '}
          <span className="font-medium text-foreground">
            {recommended.model}
          </span>{' '}
          — {recommended.reason}
        </p>

        <ul className="flex flex-col divide-y rounded-md border">
          {catalog.map((spec) => {
            const isInstalled = installedNames.has(spec.model)
            const isPulling = pulling.includes(spec.model)
            const size = installed.find((m) => m.name === spec.model)?.sizeBytes
            return (
              <li
                key={spec.model}
                className="flex items-center justify-between gap-4 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{spec.label}</span>
                    <code className="text-xs text-muted-foreground">
                      {spec.model}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {spec.notes}
                    {size ? ` · ${formatGB(size)}` : ''}
                  </p>
                </div>
                {isInstalled ? (
                  <span className="flex shrink-0 items-center gap-1 text-sm text-emerald-600">
                    <Check className="size-4" /> installed
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isPulling}
                    onClick={() => {
                      onPull(spec.model)
                    }}
                  >
                    {isPulling ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> pulling…
                      </>
                    ) : (
                      <>
                        <Download className="size-4" /> Pull
                      </>
                    )}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>

        <OtherInstalled installed={installed} catalog={catalog} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Hosted providers</h2>
        <p className="text-sm text-muted-foreground">
          Add a key to use a hosted model. The famous big open models (Kimi,
          DeepSeek, GLM) are too large to run locally — reach them through
          OpenRouter. Keys are stored in pi.dev’s credential file, not the
          database.
        </p>
        <ul className="flex flex-col gap-3">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              onSaveKey={onSaveKey}
              onRemoveKey={onRemoveKey}
            />
          ))}
        </ul>
      </section>
    </main>
  )
}

/** Installed models that aren't in the catalog (pulled by hand or by a profile). */
function OtherInstalled({
  installed,
  catalog,
}: {
  installed: InstalledModel[]
  catalog: LocalModelSpec[]
}) {
  const catalogNames = new Set(catalog.map((s) => s.model))
  const extra = installed.filter((m) => !catalogNames.has(m.name))
  if (extra.length === 0) return null
  return (
    <p className="text-xs text-muted-foreground">
      Also installed:{' '}
      {extra.map((m, i) => (
        <span key={m.name}>
          {i > 0 ? ', ' : ''}
          <code>{m.name}</code> ({formatGB(m.sizeBytes)})
        </span>
      ))}
    </p>
  )
}

function ProviderRow({
  provider,
  onSaveKey,
  onRemoveKey,
}: {
  provider: ProviderStatus
  onSaveKey: (provider: string, key: string) => void
  onRemoveKey: (provider: string) => void
}) {
  const [key, setKey] = useState('')

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{provider.label}</span>
        <span
          className={cn(
            'flex items-center gap-1 text-xs',
            provider.configured ? 'text-emerald-600' : 'text-muted-foreground',
          )}
        >
          {provider.configured ? (
            <>
              <Check className="size-3.5" /> key configured
            </>
          ) : (
            'no key'
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          placeholder={provider.configured ? 'Replace key…' : 'Paste API key…'}
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
          }}
          aria-label={`${provider.label} API key`}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          size="sm"
          disabled={!key.trim()}
          onClick={() => {
            onSaveKey(provider.id, key.trim())
            setKey('')
          }}
        >
          Save
        </Button>
        {provider.configured && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onRemoveKey(provider.id)
            }}
          >
            Remove
          </Button>
        )}
      </div>
      <a
        href={provider.consoleUrl}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-xs text-muted-foreground underline"
      >
        Get a key ↗
      </a>
    </li>
  )
}
