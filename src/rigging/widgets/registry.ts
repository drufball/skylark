import type { WidgetKindSpec } from '@hull/chat/widget-catalog'

import { choiceKind } from './choice'
import { issueListKind } from './issue-list'
import { noteKind } from './note'
import type { WidgetKind, WidgetView } from './kind'

/**
 * The widget catalog: kind → what it renders as, what its props mean, and the
 * ship-log topics that keep it live.
 *
 * **It lives in rigging, and that is the point.** The hull holds the ROW — a
 * `kind` string and an opaque `props` blob (`hull/chat/schema.ts`), knowing
 * nothing about any specific kind. The catalog is the opposite: it has to know
 * every service's topic grammar (`chatTopic`, `issueTopic`, and whatever files and
 * sessions grow next) and how to read each service's data. In
 * `src/hull/widgets/` that would mean the hull importing every service that has a
 * widget — and the day `issues` wants one you get
 * `hull/issues → hull/widgets → hull/issues`, a cycle `src/architecture.test.ts`
 * would fail the build over, correctly. Rigging may import every hull service
 * freely: that's the `home → rigging → hull` direction working as designed.
 *
 * **Hull holds the row; rigging holds the meaning.**
 *
 * Adding a kind is one new module plus one line in the map below. Nothing in
 * `chat.tsx` changes, and nothing in the hull changes: the agent-facing
 * vocabulary is GENERATED from these same entries and handed down to the hull's
 * `chat_widget` tool by the composition root (`src/boot.ts` →
 * `registerWidgetKinds`), so a kind is described in exactly one place.
 */
export const WIDGET_REGISTRY = {
  choice: choiceKind,
  note: noteKind,
  'issue-list': issueListKind,
} satisfies Record<string, WidgetKind>

/**
 * Why a props blob was refused. `unknown-kind` means the row names a widget this
 * ship can't render at all; `bad-props` means the kind is known but the blob
 * doesn't fit it. Two different tiles, because they're two different things to
 * fix — and the first WILL happen as ships gain and lose kinds, since a row
 * outlives the definition that made it.
 */
export type WidgetFault = 'unknown-kind' | 'bad-props'

/** A widget row resolved for rendering, or the reason it isn't one. */
export type WidgetResolution =
  | { ok: true; view: WidgetView }
  | { ok: false; fault: WidgetFault; detail: string }

/**
 * Read a widget row's `kind` + `props` into something renderable, or say why not.
 * **Total**: every input produces a result and nothing throws, so a blob an agent
 * got wrong costs one honest tile rather than a white screen.
 *
 * `kind` is matched exactly — a near-miss like `Choice` is an unknown kind, not a
 * typo we guess at, because guessing would render a different widget than the row
 * claims to be.
 */
export function resolveWidget(kind: string, props: unknown): WidgetResolution {
  if (!Object.hasOwn(WIDGET_REGISTRY, kind))
    return { ok: false, fault: 'unknown-kind', detail: kind }
  const entry = (WIDGET_REGISTRY as Record<string, WidgetKind>)[kind]
  const parsed = entry.parse(props)
  return parsed.ok
    ? { ok: true, view: parsed.view }
    : { ok: false, fault: 'bad-props', detail: parsed.detail }
}

/**
 * The catalog as the hull's agent-facing door needs it: names, prose, and a
 * validator, with the components and topics left behind (those are the halves
 * that would drag a service into the hull).
 *
 * Handed over by `src/boot.ts` at server start — the composition root is the one
 * place allowed to know both decks, so the hull learns the vocabulary without
 * ever importing rigging.
 */
export function widgetKindSpecs(): WidgetKindSpec[] {
  return Object.entries(WIDGET_REGISTRY).map(([kind, entry]) => ({
    kind,
    summary: entry.summary,
    propsDoc: entry.propsDoc,
    example: entry.example,
    validate: (props: unknown) => {
      const parsed = entry.parse(props)
      return parsed.ok ? null : parsed.detail
    },
  }))
}
