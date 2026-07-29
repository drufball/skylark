import { getDefaultModel } from '@hull/agent/server'
import { listPlaybooksView, type PlaybookView } from '@hull/issues/server'
import { listCrew } from '@hull/users/server'
import type { UserRow } from '@hull/users/schema'

import { asRecord, type WidgetKind, type WidgetParse } from './kind'
import { useLiveRead, type LiveRead } from './use-live-read'

/**
 * `config` — the ship's own configuration, at a glance: the default model,
 * every playbook and its roster, and the crew's personas (who's running the
 * default chat-pilot config, who's been customized). The Config room's
 * standing readout (issue #0eyx) — everything its `config_playbook` /
 * `config_persona` / `config_model` tools change shows up here without
 * needing to open `/models` or `/agents`.
 *
 * **No filter, and that's deliberate — same posture as `files`'s empty-props
 * case.** This is a settings summary, not a list with a natural "which ones"
 * question the way `issue-list` has (statuses) or `files` has (a folder).
 * There is exactly one ship's worth of configuration, so the props are `{}`
 * and stay that way.
 *
 * **No topics of its own.** Every fact this tile shows already lives behind
 * its own service and its own topics (issues, users, agent) — none of which
 * this widget subscribes to, so a save doesn't animate the tile live the way
 * an `issue-list` does. That's an honest, bounded cost documented rather than
 * solved with a new ship-wide "config changed" event: reopening the tile (or
 * the room posting about what it just changed) is enough for a summary that's
 * read far less often than it's written.
 */

/** The tile's one-line summary — always the same, since there's no filter. */
export function configHeadline(): string {
  return 'Ship config'
}

/** One playbook row: its name, whether it's the ship default, and its roster. */
export function playbookLine(playbook: PlaybookView): string {
  const marker = playbook.isDefault ? ' (default)' : ''
  return `${playbook.name}${marker} — ${playbook.memberHandles.join(', ')}`
}

/** One crew line: the handle, and whether its prompt has been customized. */
export function crewLine(user: UserRow): string {
  return `@${user.handle} — ${user.systemPrompt ? 'custom prompt' : 'default'}`
}

interface ConfigSnapshot {
  defaultModel: string
  playbooks: PlaybookView[]
  crew: UserRow[]
}

async function readConfigSnapshot(): Promise<ConfigSnapshot> {
  const [def, playbooks, crew] = await Promise.all([
    getDefaultModel(),
    listPlaybooksView(),
    listCrew(),
  ])
  return {
    defaultModel: def.ref,
    playbooks,
    crew: crew.filter((u) => u.type === 'agent'),
  }
}

function useConfigSnapshot(revision: number): LiveRead<ConfigSnapshot> {
  return useLiveRead(() => readConfigSnapshot(), [revision])
}

function ConfigBody({ revision }: { revision: number }) {
  const { value: snapshot, failed } = useConfigSnapshot(revision)
  if (!snapshot) {
    return (
      <p className="px-3 pb-3 text-sm text-muted-foreground">
        {failed ? 'Couldn’t read the ship’s config just now.' : 'Reading…'}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3 px-3 pb-3 text-sm">
      <div>
        <p className="text-xs font-medium text-muted-foreground">
          Default model
        </p>
        <code className="text-sm">{snapshot.defaultModel}</code>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground">Playbooks</p>
        {snapshot.playbooks.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {snapshot.playbooks.map((p) => (
              <li key={p.id}>{playbookLine(p)}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground">Crew</p>
        <ul className="flex flex-col gap-0.5">
          {snapshot.crew.map((u) => (
            <li key={u.id}>{crewLine(u)}</li>
          ))}
        </ul>
      </div>
      {failed && (
        <p className="text-xs text-muted-foreground">
          Couldn’t refresh just now — showing the last read.
        </p>
      )}
    </div>
  )
}

export const configKind: WidgetKind = {
  summary:
    'The ship’s own configuration, at a glance: the default model, every playbook and its roster, and which crew personas have a custom prompt. Read-only and unfiltered — there’s exactly one ship’s worth of this. Nothing to answer.',
  propsDoc: '{} — no props; this tile always shows the whole ship',
  example: {},
  parse: (props): WidgetParse => {
    const record = asRecord(props)
    if (!record) return { ok: false, detail: 'expected an object of props' }
    return {
      ok: true,
      view: {
        headline: configHeadline(),
        topics: [],
        Body: ({ revision }) => <ConfigBody revision={revision} />,
      },
    }
  },
}
