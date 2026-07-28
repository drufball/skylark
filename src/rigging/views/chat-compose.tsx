import { useState } from 'react'
import { Bot, Plus, User, Users } from 'lucide-react'

import { Button } from '@rigging/components/ui/button'
import { inputClass } from '@rigging/components/ui/input'
import type { CrewMember } from './chat-roster'

// Starting a conversation: the new-chat composer (pick members, name it) and
// the empty state a ship with no chat selected shows. The assembly in
// `chat.tsx` decides which of these fills the pane.

export function NewChat({
  crew,
  busy,
  onCreate,
}: {
  crew: CrewMember[]
  busy: boolean
  onCreate: (memberIds: string[], title: string) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')

  function toggle(id: string) {
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    )
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 p-8">
      <h1 className="text-lg font-medium">New chat</h1>
      <input
        className={inputClass()}
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
        }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Who's in it?</span>
        <span className="text-xs text-muted-foreground">
          You're always included. Pick the rest of the crew.
        </span>
        <div className="mt-1 flex flex-col gap-1">
          {crew.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => {
                  toggle(c.id)
                }}
              />
              {c.type === 'agent' ? (
                <Bot className="size-3.5" />
              ) : (
                <User className="size-3.5" />
              )}
              @{c.handle}
              <span className="text-xs text-muted-foreground">
                {c.displayName}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <Button
          disabled={busy || selected.length === 0}
          onClick={() => {
            onCreate(selected, title)
          }}
        >
          Start chat
        </Button>
      </div>
    </div>
  )
}

export function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Users className="mx-auto mb-3 size-8 text-muted-foreground" />
        <p className="text-lg font-medium">Start a conversation</p>
        <p className="mb-4 text-sm text-muted-foreground">
          A chat is a room with some of your crew in it — people and agents. It
          grows into whatever the two of you need it to be.
        </p>
        {/* The button, not just the word "New": on a phone the sidebar's own
            New button is inside a closed drawer, so pointing at it from here
            was pointing at something that wasn't on the screen. */}
        <Button onClick={onNew}>
          <Plus className="size-4" />
          New chat
        </Button>
      </div>
    </div>
  )
}
