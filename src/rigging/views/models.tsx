import { Check, CircleOff } from 'lucide-react'

import { cn } from '@rigging/lib/utils'

// The Models surface: what runs the crew's agents. Every model call goes
// through the ship's LLM gateway (LiteLLM); this page shows what the gateway
// serves and where to change it. Presentational: data in as props, so it's
// testable without a server or router.

export interface ModelsData {
  /** The model new sessions default to, e.g. "claude-sonnet-5". */
  defaultRef: string
  /** Whether the gateway answered, the model names it serves, and where its
   * admin UI lives (models and provider keys are managed there). */
  gateway: { ok: boolean; models: string[]; uiUrl: string }
}

export function Models({ defaultRef, gateway }: ModelsData) {
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
          change it, or pin a model per agent in Crew.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Gateway</h2>
          <span
            className={cn(
              'flex items-center gap-1 text-xs',
              gateway.ok ? 'text-emerald-600' : 'text-muted-foreground',
            )}
          >
            {gateway.ok ? (
              <>
                <Check className="size-3.5" /> reachable
              </>
            ) : (
              <>
                <CircleOff className="size-3.5" /> unreachable
              </>
            )}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Every model call goes through the ship’s LLM gateway (LiteLLM).{' '}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={gateway.uiUrl}
            target="_blank"
            rel="noreferrer"
          >
            Manage models &amp; keys
          </a>{' '}
          in the gateway’s own UI — add a provider key and name the models it
          should serve (Anthropic, OpenAI, a local server, …) without touching
          the ship. Log in as <code>admin</code> with the{' '}
          <code>LITELLM_MASTER_KEY</code> from <code>.env</code>.
        </p>
        {gateway.ok && !gateway.models.includes(defaultRef) && (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            New sessions default to <code>{defaultRef}</code>, but the gateway
            doesn’t serve it yet — add a model by that name in the gateway UI,
            or point <code>SKYLARK_DEFAULT_MODEL</code> at one it does serve.
          </p>
        )}
        {gateway.ok ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {gateway.models.map((model) => (
              <li key={model} className="flex items-center gap-2 p-3">
                <code className="text-sm">{model}</code>
                {model === defaultRef && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    default
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            The gateway isn’t answering — start it with{' '}
            <code>npm run gateway:up</code> (it needs Docker, like Postgres).
          </p>
        )}
      </section>
    </main>
  )
}
