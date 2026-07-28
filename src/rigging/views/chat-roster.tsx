import { Bot, User, X } from 'lucide-react'

import { cn } from '@rigging/lib/utils'
import { selectClass } from '@rigging/components/ui/input'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import type { ChatMemberItem } from './chat-thread'

// Who's in the chat, and how somebody else gets in: the member chips and the
// add-member select. The assembly in `chat.tsx` decides where the roster sits
// (the desktop header row, or the phone's overflow).

export interface CrewMember {
  id: string
  handle: string
  displayName: string
  type: 'human' | 'agent'
}

/**
 * Who's in the chat, and how somebody else gets in. Also one definition in two
 * homes: on a desktop pane it sits in the header row, on a phone it's the body
 * of the overflow — where it can afford to spell the word "Schedules" and show
 * every chip, because it isn't competing with the conversation for the row.
 */
export function Roster({
  members,
  addable,
  thumb,
  onAddMember,
  onRemoveMember,
}: {
  members: ChatMemberItem[]
  addable: CrewMember[]
  /**
   * Size every control for a thumb. True in the phone's overflow, where these
   * are the only way to change who's in a chat and there is room to spare;
   * false in the desktop header row, where the chips share a line with
   * everything else and a 44px pill per member would be the wrap all over
   * again.
   */
  thumb: boolean
  onAddMember: (userId: string) => void
  onRemoveMember: (userId: string) => void
}) {
  return (
    <div
      className={cn('flex flex-wrap items-center', thumb ? 'gap-2' : 'gap-1')}
    >
      {members.map((m) => (
        <span
          key={m.userId}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border bg-muted/40 text-xs',
            thumb ? cn('gap-2 pl-3 pr-1', TAP_TARGET) : 'px-2 py-0.5',
          )}
        >
          {m.type === 'agent' ? (
            <Bot className="size-3" />
          ) : (
            <User className="size-3" />
          )}
          @{m.handle}
          <button
            type="button"
            aria-label={`Remove ${m.handle}`}
            onClick={() => {
              onRemoveMember(m.userId)
            }}
            className={cn(
              'text-muted-foreground hover:text-destructive',
              thumb && cn('flex items-center px-2', TAP_TARGET),
            )}
          >
            <X className={thumb ? 'size-4' : 'size-3'} />
          </button>
        </span>
      ))}
      {addable.length > 0 && (
        <select
          aria-label="Add member"
          className={selectClass(thumb ? TAP_TARGET : 'text-xs')}
          value=""
          onChange={(e) => {
            if (e.target.value) onAddMember(e.target.value)
          }}
        >
          <option value="">+ add</option>
          {addable.map((c) => (
            <option key={c.id} value={c.id}>
              @{c.handle}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
