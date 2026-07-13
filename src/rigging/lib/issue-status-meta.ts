import {
  CheckCircle2,
  CircleDot,
  Hammer,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { IssueStatus } from '@hull/issues/schema'
import type { BuildActivity } from '@hull/issues/activity'

/**
 * The canonical metadata for issue statuses: labels, icons, and tint classes.
 * Single source of truth for board, thread, and any other issue UI.
 */
export const ISSUE_STATUS_META: Record<
  IssueStatus,
  { label: string; icon: LucideIcon; tint: string }
> = {
  open: {
    label: 'Open',
    icon: CircleDot,
    tint: 'text-sky-500',
  },
  building: {
    label: 'Building',
    icon: Hammer,
    tint: 'text-amber-500',
  },
  done: {
    label: 'Done',
    icon: CheckCircle2,
    tint: 'text-emerald-500',
  },
  closed: {
    label: 'Closed',
    icon: XCircle,
    tint: 'text-muted-foreground',
  },
}

/** The display order for the board: discussions first, archive last. */
export const ISSUE_STATUS_ORDER: IssueStatus[] = [
  'open',
  'building',
  'done',
  'closed',
]

/**
 * The text tint for a build-activity state (see `computeBuildActivity`):
 * busy is the familiar calm amber, waiting is a cooler blue (still normal,
 * just a different kind of normal), and stalled is loud red — deliberately
 * NOT another shade of the same amber ellipsis that hid the incident this
 * feature exists to fix (issue #4mna). Single source so the board and thread
 * can't drift on what "alarming" looks like.
 */
export function activityTint(state: BuildActivity['state']): string {
  switch (state) {
    case 'busy':
      return 'text-amber-600'
    case 'waiting':
      return 'text-sky-600'
    case 'stalled':
      return 'text-red-600 font-semibold'
  }
}
