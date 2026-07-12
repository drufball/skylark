import { useEffect, useRef, useState } from 'react'
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import { ScrollArea } from '@rigging/components/ui/scroll-area'
import { Textarea } from '@rigging/components/ui/textarea'
import { CollapsibleSidebar } from '@rigging/components/collapsible-sidebar'

// The files surface: the crew's shared documents. An explorer rail on the left,
// the selected file on the right — rendered markdown by default, a plain editor
// behind the Edit toggle. Edits AUTO-SAVE (debounced) through the files service
// onto its staging branch; there is no save button. Presentational and
// routing-agnostic: the route wires it to the files service and the address
// bar, and re-runs its loader on ship's-log events so every tab stays live.

export interface FilesViewProps {
  files: string[]
  /** The open file's path, or null when nothing is selected. */
  selected: string | null
  /** The open file's content, or null when it doesn't exist (yet). */
  content: string | null
  busy: boolean
  onSelect: (path: string) => void
  onSave: (path: string, content: string) => void
  onCreate: (path: string) => void
  onDelete: (path: string) => void
}

/** How long typing must pause before the draft auto-saves. */
export const AUTOSAVE_DEBOUNCE_MS = 800

export function FilesView({
  files,
  selected,
  content,
  busy,
  onSelect,
  onSave,
  onCreate,
  onDelete,
}: FilesViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  return (
    <main className="flex h-screen">
      <CollapsibleSidebar
        label="Files"
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        className="w-64"
      >
        <header className="border-b px-4 py-4">
          <h1 className="text-lg font-semibold">Files</h1>
          <p className="text-sm text-muted-foreground">
            Shared docs — everyone edits live.
          </p>
        </header>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-0.5 p-2">
            <NewFile busy={busy} onCreate={onCreate} />
            {files.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                No files yet.
              </p>
            ) : (
              files.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => {
                    onSelect(path)
                    setDrawerOpen(false)
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    'hover:bg-accent hover:text-accent-foreground',
                    path === selected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </CollapsibleSidebar>
      {selected === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a file — or create one.
        </div>
      ) : (
        <OpenFile
          key={selected}
          path={selected}
          content={content}
          busy={busy}
          onSave={onSave}
          onDelete={onDelete}
        />
      )}
    </main>
  )
}

/**
 * The open file. The draft is the editor's local truth while editing (a remote
 * update must not clobber keystrokes); outside editing the loader's content is
 * shown directly, so live updates from other tabs and crew flow straight in.
 */
function OpenFile({
  path,
  content,
  busy,
  onSave,
  onDelete,
}: {
  path: string
  content: string | null
  busy: boolean
  onSave: (path: string, content: string) => void
  onDelete: (path: string) => void
}) {
  // null is the service's "no such file" — a deleted file or a stale deep
  // link. Rendering it as an editable empty file would silently recreate it.
  if (content === null) return <MissingFile path={path} />
  return (
    <ExistingFile
      path={path}
      content={content}
      busy={busy}
      onSave={onSave}
      onDelete={onDelete}
    />
  )
}

function MissingFile({ path }: { path: string }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-6 py-3">
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No such file — it may have been deleted.
      </div>
    </section>
  )
}

function ExistingFile({
  path,
  content,
  busy,
  onSave,
  onDelete,
}: {
  path: string
  content: string
  busy: boolean
  onSave: (path: string, content: string) => void
  onDelete: (path: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const dirty = draft !== content

  // Auto-save: a pause in typing flushes the draft. Cleared on every keystroke.
  const saveRef = useRef(onSave)
  useEffect(() => {
    saveRef.current = onSave
  }, [onSave])
  useEffect(() => {
    if (!editing || !dirty) return
    const timer = setTimeout(() => {
      saveRef.current(path, draft)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [editing, dirty, draft, path])

  // Switching files remounts this component (it's keyed by path), which cancels
  // the pending autosave — so flush a dirty draft on unmount rather than losing
  // the keystrokes typed inside the debounce window.
  const flushRef = useRef({ editing, dirty, draft, path })
  useEffect(() => {
    flushRef.current = { editing, dirty, draft, path }
  })
  useEffect(
    () => () => {
      const last = flushRef.current
      if (last.editing && last.dirty) saveRef.current(last.path, last.draft)
    },
    [],
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-6 py-3">
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm">{path}</h2>
        <span className="text-xs text-muted-foreground">
          {dirty ? 'saving…' : editing ? 'saved' : ''}
        </span>
        <Button
          variant={editing ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            // Entering edit seeds the draft from what's on screen; leaving it
            // flushes anything unsaved immediately rather than waiting out the
            // debounce.
            if (!editing) setDraft(content)
            else if (dirty) onSave(path, draft)
            setEditing(!editing)
          }}
        >
          <Pencil className="size-4" />
          {editing ? 'Done' : 'Edit'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete ${path}?`)) onDelete(path)
          }}
          aria-label={`Delete ${path}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      {editing ? (
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          className="flex-1 resize-none rounded-none border-0 p-6 font-mono text-sm focus-visible:ring-0"
        />
      ) : (
        <ScrollArea className="flex-1">
          <article className="prose prose-sm dark:prose-invert max-w-3xl p-6">
            {content === '' ? (
              <p className="text-muted-foreground">This file is empty.</p>
            ) : (
              <ReactMarkdown>{content}</ReactMarkdown>
            )}
          </article>
        </ScrollArea>
      )}
    </section>
  )
}

function NewFile({
  busy,
  onCreate,
}: Pick<FilesViewProps, 'busy' | 'onCreate'>) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')

  function submit() {
    const p = path.trim()
    if (!p || busy) return
    onCreate(p)
    setPath('')
    setOpen(false)
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="mb-1 justify-start"
        onClick={() => {
          setOpen(true)
        }}
      >
        <Plus className="size-4" />
        New file
      </Button>
    )
  }

  return (
    <form
      className="mb-1 flex gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
        autoFocus
        value={path}
        onChange={(e) => {
          setPath(e.target.value)
        }}
        placeholder="notes/plan.md"
        className="w-full min-w-0 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-accent-foreground/30"
      />
      <Button type="submit" size="sm" disabled={busy || !path.trim()}>
        Create
      </Button>
    </form>
  )
}
