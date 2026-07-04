import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'

import { Button } from '@rigging/components/ui/button'
import { Textarea } from '@rigging/components/ui/textarea'

/**
 * The shared message composer: textarea + send button + Enter-to-send.
 *
 * Used in chat, agent-chat, and issue threads for composing messages/comments.
 * Auto-clears after send, prevents empty sends, shows busy spinner.
 *
 * @param busy - Disables the button and shows a spinner
 * @param placeholder - Custom placeholder text (defaults to "Message…")
 * @param onSend - Called with the trimmed text when user submits
 */
export interface ComposerProps {
  busy: boolean
  placeholder?: string
  onSend: (text: string) => void
}

export function Composer({ busy, placeholder, onSend }: ComposerProps) {
  const [text, setText] = useState('')

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="border-t p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={
            placeholder ??
            'Message…  (Enter to send, Shift+Enter for a newline)'
          }
          rows={1}
          className="max-h-40 min-h-[2.5rem] resize-none"
        />
        <Button
          onClick={submit}
          disabled={busy || !text.trim()}
          aria-label="Send message"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </div>
    </div>
  )
}
