import type { ComponentType, ReactNode } from 'react'
import {
  Anchor,
  Bell,
  Bot,
  Boxes,
  FolderOpen,
  Hammer,
  LogOut,
  MessageSquare,
} from 'lucide-react'

import { cn } from '@rigging/lib/utils'

// The dock: the ship's persistent app-shell nav. It switches between the ship's
// surfaces — Chat (the front door), Issues (the board), Files (shared docs),
// Inbox (notifications), Agents (profiles + the session monitor), and Models
// (local + hosted models). Presentational and router-agnostic: the link element
// is injected so the dock is testable without a router and reusable across
// routes.

export type DockSection =
  | 'chat'
  | 'issues'
  | 'files'
  | 'inbox'
  | 'agents'
  | 'models'

/** A navigation link, injected so the dock doesn't depend on a router. */
export type DockLink = ComponentType<{
  to: string
  className?: string
  children: ReactNode
}>

interface DockItem {
  section: DockSection
  to: string
  label: string
  Icon: typeof Anchor
}

const ITEMS: DockItem[] = [
  { section: 'chat', to: '/', label: 'Chat', Icon: MessageSquare },
  { section: 'issues', to: '/issues', label: 'Issues', Icon: Hammer },
  { section: 'files', to: '/files', label: 'Files', Icon: FolderOpen },
  { section: 'inbox', to: '/inbox', label: 'Inbox', Icon: Bell },
  { section: 'agents', to: '/agents', label: 'Agents', Icon: Bot },
  { section: 'models', to: '/models', label: 'Models', Icon: Boxes },
]

export interface DockProps {
  active: DockSection
  /** The router's Link component (or a stand-in in tests). */
  Link: DockLink
  /** Ends the session and returns to /login. */
  onLogout: () => void
  /**
   * How many commits `origin/main` is ahead of the serving checkout (issue
   * #f70a) — undefined, null, or 0 all mean "nothing to say," so the banner
   * renders only for a genuine positive count.
   */
  behindOrigin?: number | null
  children: ReactNode
}

/** The app shell: a slim left rail of sections, with the active surface beside it. */
export function Dock({
  active,
  Link,
  onLogout,
  behindOrigin,
  children,
}: DockProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {typeof behindOrigin === 'number' && behindOrigin > 0 && (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-b bg-amber-500/10 px-3 py-1 text-center text-xs text-amber-700 dark:text-amber-400">
          <span aria-hidden>⚓</span>
          <span>
            ship is {behindOrigin} commit{behindOrigin === 1 ? '' : 's'} behind
            origin — merged work isn&apos;t live yet
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r bg-muted/30 py-3">
          <Anchor
            className="mb-3 size-6 text-muted-foreground"
            aria-label="Skylark"
          />
          {ITEMS.map((item) => (
            <DockButton
              key={item.section}
              item={item}
              active={item.section === active}
              Link={Link}
            />
          ))}
          <button
            type="button"
            onClick={onLogout}
            className="mt-auto flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="size-5" />
            Log out
          </button>
        </nav>
        {/* overflow-y-auto is a fallback for a surface that manages no internal
            scroll of its own (e.g. Models) — a surface that fills this slot
            exactly (chat/issues/files/inbox, each already h-full + its own
            ScrollArea) never grows past it, so this never triggers for them. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

function DockButton({
  item,
  active,
  Link,
}: {
  item: DockItem
  active: boolean
  Link: DockLink
}) {
  const { Icon, label } = item
  const base =
    'flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] font-medium'

  return (
    <Link
      to={item.to}
      className={cn(
        base,
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon className="size-5" aria-current={active ? 'page' : undefined} />
      {label}
    </Link>
  )
}
