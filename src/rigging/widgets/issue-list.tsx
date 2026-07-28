import { AlertTriangle } from 'lucide-react'

import { listBoard, type BoardIssue } from '@hull/issues/server'
import { ISSUE_TOPIC_PATTERN } from '@hull/issues/topic'
import type { IssueStatus } from '@hull/issues/schema'
import {
  ISSUE_STATUS_META,
  ISSUE_STATUS_ORDER,
} from '@rigging/lib/issue-status-meta'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import { cn } from '@rigging/lib/utils'

import {
  asRecord,
  parseLimit,
  parseStringList,
  type WidgetKind,
  type WidgetParse,
} from './kind'
import { useLiveRead, type LiveRead } from './use-live-read'

/**
 * `issue-list` — a live list of issues, filtered.
 *
 * The kind that earns the deck choice. It composes ANOTHER service's data, and it
 * does so without a single new coupling in the hull: the props hold only the
 * QUESTION (which issues), the issues themselves are read fresh through the
 * issues service's own `listBoard` door on every render, and the tile goes live
 * off `issue:*` on the one subscription the stack already holds. A catalog in the
 * hull would have needed `hull/chat → hull/issues` here, and `hull/issues` will
 * eventually want a widget of its own — that's the cycle
 * `architecture.test.ts` exists to fail the build over.
 *
 * Access rides the door, not this file: `listBoard` enforces whatever the issues
 * service enforces, and the live signal is gated by `canSeeTopic` like every
 * other event (issue topics are public, exactly as the board's own subscription
 * treats them). So a widget can't become a way to see data you otherwise couldn't
 * — it has no read path of its own to leak through.
 */

/** How many rows a shelf-sized tile shows before it needs a `limit`. */
export const DEFAULT_ISSUE_LIMIT = 5

/** The most rows a tile will ever show — above this it stops being a tile. */
const MAX_ISSUE_LIMIT = 20

/** The question an `issue-list` asks: which issues, and how many. */
export interface IssueListProps {
  /** Keep only these statuses; absent means every status. */
  statuses?: IssueStatus[]
  /** Keep only these issues, by full id or short nano; absent means no pinning. */
  issueIds?: string[]
  /** Row cap (1…20), defaulting to `DEFAULT_ISSUE_LIMIT`. */
  limit?: number
}

/**
 * The issues this widget asked for, in the order the door returned them (newest
 * first). Pure and exported so the filter is tested without a render — and it is
 * the ONLY place the props become a selection, so the tile can't drift from the
 * headline.
 */
export function filterIssues(
  issues: BoardIssue[],
  props: IssueListProps,
): BoardIssue[] {
  const pinned = props.issueIds
  const statuses = props.statuses
  return issues
    .filter((i) => !pinned || pinned.includes(i.id) || pinned.includes(i.nano))
    .filter((i) => !statuses || statuses.includes(i.status))
    .slice(0, props.limit ?? DEFAULT_ISSUE_LIMIT)
}

/**
 * The pinned references nothing answers to any more. There is deliberately NO
 * foreign key from a widget to the data it shows (its contents are fetched, not
 * stored), so a referent CAN vanish — or never have existed, when an agent
 * invents an id. Naming the ones that are gone is the honest state; silently
 * showing a shorter list is the dishonest one.
 */
export function missingRefs(
  issues: BoardIssue[],
  issueIds: string[] | undefined,
): string[] {
  if (!issueIds) return []
  const known = new Set(issues.flatMap((i) => [i.id, i.nano]))
  return issueIds.filter((ref) => !known.has(ref))
}

/** The compact tile's one line: what this list is, before you open it. */
export function issueListHeadline(props: IssueListProps): string {
  if (props.statuses) return `Issues · ${props.statuses.join(', ')}`
  if (props.issueIds) return `Issues · ${String(props.issueIds.length)} pinned`
  return 'Issues · all'
}

function parseProps(
  json: unknown,
): { ok: true; props: IssueListProps } | { ok: false; detail: string } {
  const record = asRecord(json)
  if (!record) return { ok: false, detail: 'expected an object of props' }

  const statuses = parseStringList(record.statuses, 'statuses')
  if (!statuses.ok) return statuses
  for (const status of statuses.list ?? []) {
    // Validated against the issues service's OWN vocabulary — the reason this
    // parser is in rigging. A bogus status would otherwise render an empty list
    // and read as "no work on", which is a lie.
    if (!(ISSUE_STATUS_ORDER as string[]).includes(status)) {
      return {
        ok: false,
        detail: `“${status}” is not an issue status — this ship has: ${ISSUE_STATUS_ORDER.join(', ')}`,
      }
    }
  }

  const issueIds = parseStringList(record.issueIds, 'issueIds')
  if (!issueIds.ok) return issueIds

  const limit = parseLimit(record.limit, MAX_ISSUE_LIMIT)
  if (!limit.ok) return limit

  // Rebuilt field by field, not spread: an agent's extra keys never become props.
  return {
    ok: true,
    props: {
      ...(statuses.list ? { statuses: statuses.list as IssueStatus[] } : {}),
      ...(issueIds.list ? { issueIds: issueIds.list } : {}),
      ...(limit.limit === undefined ? {} : { limit: limit.limit }),
    },
  }
}

/**
 * The issues, read fresh — on mount and again every time `revision` moves (which
 * is the stack telling us an `issue:*` event landed). Never stored on the widget
 * row: the row holds the question, this holds the answer for exactly as long as
 * it's on screen.
 */
function useIssues(revision: number): LiveRead<BoardIssue[]> {
  return useLiveRead(() => listBoard(), [revision])
}

/** One issue as a row: its status, its short nano, its title. */
function IssueRow({ issue }: { issue: BoardIssue }) {
  const meta = ISSUE_STATUS_META[issue.status]
  const Icon = meta.icon
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm',
        TAP_TARGET,
      )}
    >
      <Icon className={cn('size-4 shrink-0', meta.tint)} />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {issue.nano}
      </span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
    </li>
  )
}

function IssueListBody({
  props,
  revision,
}: {
  props: IssueListProps
  revision: number
}) {
  const { value: issues, failed } = useIssues(revision)
  if (!issues) {
    return (
      <p className="px-3 pb-3 text-sm text-muted-foreground">
        {failed ? 'Couldn’t read the issues just now.' : 'Reading the board…'}
      </p>
    )
  }
  const shown = filterIssues(issues, props)
  const missing = missingRefs(issues, props.issueIds)
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No issues match this filter right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            Gone now: {missing.join(', ')}
          </span>
        </p>
      )}
      {failed && (
        <p className="text-xs text-muted-foreground">
          Couldn’t read the issues just now — showing the last list.
        </p>
      )}
    </div>
  )
}

export const issueListKind: WidgetKind = {
  summary:
    'A live list of issues, filtered by status or pinned by id, that updates itself as work moves. Nothing to answer; raise one when the crew will want to watch a slice of the board while you talk about it.',
  propsDoc: `{ statuses?: (${ISSUE_STATUS_ORDER.map((s) => `"${s}"`).join('|')})[], issueIds?: string[], limit?: number (1-${String(MAX_ISSUE_LIMIT)}, default ${String(DEFAULT_ISSUE_LIMIT)}) } — all optional; no filter means every issue`,
  example: { statuses: ['open', 'building'], limit: 5 },
  parse: (json): WidgetParse => {
    const parsed = parseProps(json)
    if (!parsed.ok) return parsed
    const props = parsed.props
    return {
      ok: true,
      view: {
        headline: issueListHeadline(props),
        // The WILDCARD, not one topic per pinned issue: a status filter has to
        // notice an issue MOVING INTO it, which a per-id subscription could
        // never hear. Issue events are public, so this leaks nothing a member
        // couldn't already see on the board.
        topics: [ISSUE_TOPIC_PATTERN],
        Body: ({ revision }) => (
          <IssueListBody props={props} revision={revision} />
        ),
      },
    }
  },
}
