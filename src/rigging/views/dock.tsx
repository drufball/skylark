import type { ComponentType, ReactNode } from 'react'
import { Anchor, Bot, Hammer, MessageSquare } from 'lucide-react'

import { cn } from '@rigging/lib/utils'

// The dock: the ship's persistent app-shell nav. It switches between the ship's
// surfaces — Chat (the front door), Issues (the board), and Agents (profiles +
// the session monitor). Presentational and router-agnostic: the link element is
// injected so the dock is testable without a router and reusable across routes.
// Items can still be marked `disabled` (rendered dimmed and non-navigating) when
// a future surface is reserved but not yet built.

export type DockSection = 'chat' | 'issues' | 'agents'

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
  /** Not yet built — rendered as a dimmed, non-navigating placeholder. */
  disabled?: boolean
}

const ITEMS: DockItem[] = [
  { section: 'chat', to: '/', label: 'Chat', Icon: MessageSquare },
  { section: 'issues', to: '/issues', label: 'Issues', Icon: Hammer },
  { section: 'agents', to: '/agents', label: 'Agents', Icon: Bot },
]

export interface DockProps {
  active: DockSection
  /** The router's Link component (or a stand-in in tests). */
  Link: DockLink
  children: ReactNode
}

/** The app shell: a slim left rail of sections, with the active surface beside it. */
export function Dock({ active, Link, children }: DockProps) {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-3">
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
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
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

  if (item.disabled) {
    return (
      <span
        className={cn(base, 'cursor-not-allowed text-muted-foreground/40')}
        aria-disabled="true"
        title={`${label} — coming soon`}
      >
        <Icon className="size-5" />
        {label}
      </span>
    )
  }

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
