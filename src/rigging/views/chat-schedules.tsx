import { useState } from 'react'
import { CalendarClock, Plus, Trash2 } from 'lucide-react'

import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { inputClass, selectClass } from '@rigging/components/ui/input'
import { TAP_TARGET } from '@rigging/lib/tap-target'

// The chat's schedules: standing messages that post themselves into the
// thread. The button and the panel both live here, so a crew member reshaping
// how scheduling looks opens this one file and reads one narrow interface
// (`ChatSchedules`); the assembly in `chat.tsx` only decides where they sit.

/** A schedule as the view shows it — timing fields arrive as ISO strings (serialized). */
export interface ScheduleItem {
  id: string
  authorHandle: string
  body: string
  enabled: boolean
  intervalMinutes: number | null
  fireAt: string | null
  nextFireAt: string | null
}

/** What the crew is asked to author a schedule with. */
export interface NewSchedule {
  body: string
  /** ISO timestamp for a one-shot; XOR intervalMinutes. */
  fireAt?: string
  /** Whole minutes for a recurring schedule; XOR fireAt. */
  intervalMinutes?: number
}

/**
 * Everything the host wires to turn scheduling on. The affordance shows itself
 * exactly when this group is passed — a host with no scheduling door simply
 * doesn't pass it.
 */
export interface ChatSchedules {
  /**
   * The active chat's schedules. Optional apart from the callbacks: "the host
   * has wired scheduling but hasn't loaded (or has no) schedules" is a real
   * state — the first render of every chat, in fact.
   */
  items?: ScheduleItem[]
  onCreate: (input: NewSchedule) => void
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}

/**
 * A one-line, human-ready timing summary for a schedule row. Pure and exported
 * so the wording is unit-tested; the view just renders it. A recurring row
 * shows its cadence and next fire; a one-shot shows its single time.
 */
export function scheduleSummary(s: {
  intervalMinutes: number | null
  fireAt: string | null
  nextFireAt: string | null
}): string {
  if (s.intervalMinutes != null) {
    const next = s.nextFireAt ? new Date(s.nextFireAt).toLocaleString() : '—'
    return `every ${String(s.intervalMinutes)} min · next ${next}`
  }
  const at = s.fireAt ? new Date(s.fireAt).toLocaleString() : '—'
  return `once · ${at}`
}

/**
 * The Schedules toggle. One definition, two homes — the desktop header's row
 * and the phone's overflow — because two copies of a control with a count on it
 * is two places for the count to be wrong.
 */
export function SchedulesButton({
  count,
  open,
  onToggle,
}: {
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('shrink-0', TAP_TARGET)}
      aria-label="Schedules"
      aria-pressed={open}
      onClick={onToggle}
    >
      <CalendarClock className="size-4" />
      Schedules
      {count > 0 ? ` (${String(count)})` : ''}
    </Button>
  )
}

export function SchedulesPanel({
  schedules,
  busy,
}: {
  schedules: ChatSchedules
  busy: boolean
}) {
  const items = schedules.items ?? []
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<'once' | 'repeat'>('once')
  const [at, setAt] = useState('')
  const [every, setEvery] = useState('30')

  function submit() {
    const trimmed = body.trim()
    if (!trimmed) return
    if (mode === 'once') {
      if (!at) return
      schedules.onCreate({ body: trimmed, fireAt: new Date(at).toISOString() })
    } else {
      const minutes = Number.parseInt(every, 10)
      if (Number.isNaN(minutes)) return
      schedules.onCreate({ body: trimmed, intervalMinutes: minutes })
    }
    setBody('')
    setAt('')
  }

  return (
    <div className="border-b bg-muted/20 px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Scheduled messages post themselves into this chat — everyone here can
          see them. A message from you nudges the agents; one from an agent is a
          standing announcement.
        </p>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedules yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">
                    @{s.authorHandle}
                  </span>{' '}
                  {s.body}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {scheduleSummary(s)}
                </span>
                <button
                  type="button"
                  aria-label={`${s.enabled ? 'Disable' : 'Enable'} schedule ${s.id}`}
                  onClick={() => {
                    schedules.onToggle(s.id, !s.enabled)
                  }}
                  className="shrink-0 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {s.enabled ? 'On' : 'Off'}
                </button>
                <button
                  type="button"
                  aria-label={`Delete schedule ${s.id}`}
                  onClick={() => {
                    schedules.onDelete(s.id)
                  }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={inputClass('min-w-40 flex-1')}
            placeholder="Message to schedule…"
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
            }}
          />
          <select
            aria-label="Schedule mode"
            className={selectClass()}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value === 'repeat' ? 'repeat' : 'once')
            }}
          >
            <option value="once">Once</option>
            <option value="repeat">Repeat</option>
          </select>
          {mode === 'once' ? (
            <input
              type="datetime-local"
              aria-label="Fire time"
              className={inputClass()}
              value={at}
              onChange={(e) => {
                setAt(e.target.value)
              }}
            />
          ) : (
            <label className="flex items-center gap-1 text-sm text-muted-foreground">
              every
              <input
                type="number"
                aria-label="Interval minutes"
                min={5}
                className={inputClass('w-20')}
                value={every}
                onChange={(e) => {
                  setEvery(e.target.value)
                }}
              />
              min
            </label>
          )}
          <Button
            size="sm"
            disabled={busy || !body.trim() || (mode === 'once' && !at)}
            onClick={submit}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
