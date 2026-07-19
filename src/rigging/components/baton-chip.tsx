import { Bot, User } from 'lucide-react'

import type { BatonHolder } from '@hull/issues/server'
import { cn } from '@rigging/lib/utils'

// The baton chip: a modest "whose turn it is" tag shown on the board card and
// the thread header. The one distinction it draws is the same one the night
// watch reads — a HUMAN holder ("waiting on @dru") is the "waiting for input"
// case; an agent holder ("@builder's turn") means work is (or should be) in
// flight. Presentational only; the door resolves the handle + human/agent flag.

export function BatonChip({
  holder,
  className,
}: {
  holder: BatonHolder
  className?: string
}) {
  const Icon = holder.isHuman ? User : Bot
  return (
    <span
      className={cn('flex items-center gap-1', className)}
      title={
        holder.isHuman
          ? `Waiting on @${holder.handle} for input`
          : `@${holder.handle} holds the baton`
      }
    >
      <Icon className="size-3" />
      {holder.isHuman ? `waiting on @${holder.handle}` : `@${holder.handle}`}
    </span>
  )
}
