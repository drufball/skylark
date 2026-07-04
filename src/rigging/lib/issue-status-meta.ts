import {
  CheckCircle2,
  CircleDot,
  Hammer,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { IssueStatus } from '@hull/issues/schema'

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
