import type { ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'

import { useIsMobile } from '@rigging/lib/use-is-mobile'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@rigging/components/ui/sheet'

export interface CollapsibleSidebarProps {
  /** The list's name — used for the trigger button and the drawer's title. */
  label: string
  /** Whether the mobile drawer is open. Ignored above the breakpoint. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Extra classes for the docked `<aside>` shown at desktop widths. */
  className?: string
  children: ReactNode
}

/**
 * The list side of a list+content view with a docked sidebar — chat (chats),
 * agent-chat (sessions), files (the explorer). (issue-board and inbox are
 * single-column forum-style pages that navigate to a separate route per item
 * rather than splitting a pane, so they don't need this.) A fixed-width
 * docked sidebar at desktop widths; an off-canvas drawer (shadcn's Sheet)
 * below the mobile breakpoint. One place to get the collapse right instead of
 * near-identical reimplementations per view.
 *
 * The trigger lives here too — a caller only renders this once and wires
 * `open`/`onOpenChange` (typically local `useState`, reset to `false` on
 * selection so picking an item lands the user on content).
 */
export function CollapsibleSidebar({
  label,
  open,
  onOpenChange,
  className,
  children,
}: CollapsibleSidebarProps) {
  const isMobile = useIsMobile()

  if (!isMobile) {
    return (
      <aside className={cn('flex shrink-0 flex-col border-r', className)}>
        {children}
      </aside>
    )
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="m-2 self-start"
        aria-label={`Open ${label}`}
        onClick={() => {
          onOpenChange(true)
        }}
      >
        <PanelLeft className="size-4" />
      </Button>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-72 max-w-[85vw] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>{label} drawer</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  )
}
