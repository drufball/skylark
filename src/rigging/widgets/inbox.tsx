import { CircleSmall } from 'lucide-react'

import { myInbox, type InboxItem } from '@hull/notifications/server'
import { NOTIFY_TOPIC_PATTERN } from '@hull/notifications/topic'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import { formatLocalTime } from '@rigging/lib/format-local-time'
import { cn } from '@rigging/lib/utils'

import { asRecord, parseLimit, type WidgetKind, type WidgetParse } from './kind'
import { useLiveRead, type LiveRead } from './use-live-read'

/**
 * `inbox` — the VIEWER's own notifications, in a tile.
 *
 * The per-viewer kind, and the first one. Every other kind shows the same thing
 * to every member of a chat: an `issue-list` is the board, a `files` tile is the
 * shelf. A notification belongs to a PERSON, so one `inbox` row on a shared
 * canvas has to show each member a different tile — and must never, on any path,
 * show one member another's news.
 *
 * That's held by construction rather than by care, in the same shape
 * `chat_view_state` used for the page a person has open (#cse4):
 *
 * - **The read** is `myInbox`, which resolves `currentActor()` server-side and
 *   runs under RLS, where the policy scopes rows to their owner. There is no
 *   door that takes a user id, so a tile cannot ask for somebody else's inbox
 *   even by mistake. The props can't name a person either — a blob that tries
 *   is refused, loudly, rather than quietly ignored.
 * - **The live half** subscribes to `notify:*` because the props can't name the
 *   viewer, so the instance can't name a topic. That is safe by construction:
 *   the stream gates every event through `canSeeTopic`, and a `notify:<userId>`
 *   topic admits exactly that user (the topic IS the entitlement — no probe).
 *   Two members on one row hear only their own notifications land.
 */

/** How many entries a tile-sized inbox shows before it needs a `limit`. */
export const DEFAULT_INBOX_LIMIT = 6

/** The most entries a tile will ever show — above this it stops being a tile. */
const MAX_INBOX_LIMIT = 50

/** The question an `inbox` widget asks — never WHOSE, only how much. */
export interface InboxProps {
  /** Show only what hasn't been read. */
  unreadOnly?: boolean
  /** Entry cap (1…50), defaulting to `DEFAULT_INBOX_LIMIT`. */
  limit?: number
}

/** The keys that would mean "somebody else's inbox" — there is no such thing. */
const AIMING_KEYS = ['userId', 'user', 'handle', 'ownerId'] as const

/**
 * The entries this widget asked for. Pure and exported so the filter is tested
 * without a render.
 */
export function pickEntries(
  items: InboxItem[],
  props: InboxProps,
): InboxItem[] {
  return items
    .filter((item) => !props.unreadOnly || !item.read)
    .slice(0, props.limit ?? DEFAULT_INBOX_LIMIT)
}

/** The compact tile's one line. Never a name — the tile is always yours. */
export function inboxHeadline(props: InboxProps): string {
  return props.unreadOnly ? 'Inbox · unread' : 'Inbox'
}

function parseProps(
  json: unknown,
): { ok: true; props: InboxProps } | { ok: false; detail: string } {
  const record = asRecord(json)
  if (!record) return { ok: false, detail: 'expected an object of props' }

  // Refused LOUDLY rather than dropped. An agent that writes `userId` has the
  // wrong model of this widget, and silently ignoring the key would leave it
  // believing it had pointed a tile at somebody — which is precisely the thing
  // this kind must never be able to do.
  const aimed = AIMING_KEYS.find((key) => record[key] !== undefined)
  if (aimed) {
    return {
      ok: false,
      detail: `an inbox widget always shows the viewer their OWN inbox, so it takes no “${aimed}” — drop it`,
    }
  }

  const { unreadOnly } = record
  if (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') {
    return { ok: false, detail: 'unreadOnly must be true or false' }
  }
  const limit = parseLimit(record.limit, MAX_INBOX_LIMIT)
  if (!limit.ok) return limit

  // Rebuilt field by field, not spread: an agent's extra keys never become props.
  return {
    ok: true,
    props: {
      ...(unreadOnly === undefined ? {} : { unreadOnly }),
      ...(limit.limit === undefined ? {} : { limit: limit.limit }),
    },
  }
}

/**
 * The viewer's inbox, read fresh — on mount and again every time `revision`
 * moves (the stack telling us something landed on `notify:*`, which for this
 * connection can only ever be the viewer's own).
 */
function useMyInbox(
  revision: number,
): LiveRead<Awaited<ReturnType<typeof myInbox>>> {
  return useLiveRead(() => myInbox(), [revision])
}

/** One entry: unread dot, what happened, when. */
function EntryRow({ entry }: { entry: InboxItem }) {
  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded-md border bg-background px-2 py-1.5 text-sm',
        TAP_TARGET,
      )}
    >
      <CircleSmall
        className={cn(
          'mt-1 size-3 shrink-0',
          entry.read ? 'text-transparent' : 'fill-primary text-primary',
        )}
        aria-label={entry.read ? undefined : 'unread'}
      />
      {/* The label over the time, not beside it. Observed live at 390px: inside
          a tile the `YYYY-MM-DD HH:MM` stamp held a third of the row and cut
          "@mate commented on #a1b2" down to "@mate c…". A tile is far narrower
          than the Inbox surface, so the row that works there doesn't work here —
          the label IS the notification, so it gets the whole width (clamped to
          two lines, the same call the stack's headline makes, #cse5) and the
          time goes underneath. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2">{entry.label}</span>
        <span className="text-xs text-muted-foreground">
          {formatLocalTime(entry.at)}
        </span>
      </span>
    </li>
  )
}

function InboxBody({
  props,
  revision,
}: {
  props: InboxProps
  revision: number
}) {
  const { value: inbox, failed } = useMyInbox(revision)
  if (!inbox) {
    return (
      <p className="px-3 pb-3 text-sm text-muted-foreground">
        {failed ? 'Couldn’t read your inbox just now.' : 'Reading your inbox…'}
      </p>
    )
  }
  const shown = pickEntries(inbox.items, props)
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      {/* Whose inbox this is, said out loud. Not decoration: the same row on a
          shared canvas shows each member something different, and the handle is
          how you can SEE that it's yours. */}
      <p className="text-xs text-muted-foreground">
        @{inbox.me.handle} ·{' '}
        {inbox.unread > 0 ? `${String(inbox.unread)} unread` : 'all caught up'}
      </p>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.unreadOnly
            ? 'Nothing unread.'
            : 'Nothing in your inbox — watch an issue and its news lands here.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {failed && (
        <p className="text-xs text-muted-foreground">
          Couldn’t read your inbox just now — showing the last list.
        </p>
      )}
    </div>
  )
}

export const inboxKind: WidgetKind = {
  summary:
    'The viewer’s OWN inbox — the notifications from the topics they watch, updating as they land. Per-viewer by nature: the same tile shows each member of a chat their own news and never anybody else’s, so it takes no user of any kind. Nothing to answer.',
  propsDoc:
    `{ unreadOnly?: boolean, limit?: number (1-${String(MAX_INBOX_LIMIT)}, default ${String(DEFAULT_INBOX_LIMIT)}) } — ` +
    'both optional; there is deliberately no way to name whose inbox',
  example: { unreadOnly: true, limit: 6 },
  parse: (json): WidgetParse => {
    const parsed = parseProps(json)
    if (!parsed.ok) return parsed
    const props = parsed.props
    return {
      ok: true,
      view: {
        headline: inboxHeadline(props),
        // The wildcard, because the props cannot name the viewer — and it leaks
        // nothing: `canSeeTopic` admits `notify:<userId>` to exactly that user.
        topics: [NOTIFY_TOPIC_PATTERN],
        Body: ({ revision }) => <InboxBody props={props} revision={revision} />,
      },
    }
  },
}
