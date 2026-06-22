import {
  CheckCircle2,
  CircleDot,
  Hammer,
  XCircle,
  type LucideIcon,
} from 'lucide-react'

import type { IssueStatus } from '@hull/issues/schema'

// One home for how an issue status looks. The board and the thread both render
// status — its label, its icon, its tint — so the mapping lives here once and
// the two surfaces can't disagree. Adding a status to the schema forces an
// update here (the records are keyed by IssueStatus), not a hunt across views.

/** The human label for each status. */
export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  building: 'Building',
  done: 'Done',
  closed: 'Closed',
}

/** The icon that marks each status on the board. */
export const STATUS_ICON: Record<IssueStatus, LucideIcon> = {
  open: CircleDot,
  building: Hammer,
  done: CheckCircle2,
  closed: XCircle,
}

/** The icon tint (text color) for each status. */
export const STATUS_TINT: Record<IssueStatus, string> = {
  open: 'text-sky-500',
  building: 'text-amber-500',
  done: 'text-emerald-500',
  closed: 'text-muted-foreground',
}

/** The pill background + text tint for a status badge in the thread header. */
export const STATUS_BADGE_TINT: Record<IssueStatus, string> = {
  open: 'bg-sky-500/15 text-sky-600',
  building: 'bg-amber-500/15 text-amber-600',
  done: 'bg-emerald-500/15 text-emerald-600',
  closed: 'bg-muted text-muted-foreground',
}
