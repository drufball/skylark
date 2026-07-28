import { useEffect, useState } from 'react'
import { ChevronLeft, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import { listFiles, readFile } from '@hull/files/server'
import { isValidFilePath } from '@hull/files/path'
import { FILE_TOPIC_PATTERN, fileTopic } from '@hull/files/topic'
import { cn } from '@rigging/lib/utils'

import {
  asRecord,
  isFilledString,
  TAP_TARGET,
  type WidgetKind,
  type WidgetParse,
} from './kind'

/**
 * `files` — the crew's shared documents, in a tile.
 *
 * **Read-only, and that is a security boundary, not a scope decision.** The
 * files service deliberately auto-merges every write to `main` with no PR
 * ("these are documents, not code" — [`hull/files/zine.md`](../../hull/files/zine.md)),
 * its path rule restricts traversal but not file EXTENSIONS, and a merge
 * auto-deploys the serving checkout. A widget that could write an arbitrary path
 * would therefore be a path from a chat message — something an agent, or anyone
 * an agent is talking to, can produce — to unreviewed executable code running in
 * a ship that is publicly exposed through a Cloudflare Tunnel. So this kind
 * imports exactly two doors, `listFiles` and `readFile`, and draws no control
 * that writes anything. Editing a document stays on the Files surface, where a
 * human is doing it on purpose.
 *
 * Everything else follows the catalog's usual shape: the props hold only the
 * QUESTION (which documents), the contents are read fresh through the files
 * service's own doors on every render, and the tile goes live off the file
 * topics on the one subscription the stack already holds.
 */

/** How many names a tile-sized list shows before it needs a `limit`. */
export const DEFAULT_FILE_LIMIT = 8

/** The most names a tile will ever show — above this it stops being a tile. */
const MAX_FILE_LIMIT = 50

/** The question a `files` widget asks: which documents. */
export interface FilesProps {
  /** Pin one document — the tile shows that document, with no list. */
  path?: string
  /** Browse only what's under this folder; absent means every document. */
  folder?: string
  /** Name cap (1…50), defaulting to `DEFAULT_FILE_LIMIT`. */
  limit?: number
}

/**
 * Every document this widget's FILTER matches, uncapped — what the tile would
 * show if it had the room. Split from `pickFiles` so the tile can say how many
 * it isn't showing without re-spelling the predicate.
 */
export function matchingFiles(paths: string[], props: FilesProps): string[] {
  const folder = props.folder
  return paths.filter((path) => !folder || path.startsWith(`${folder}/`))
}

/**
 * The documents this widget asked for, in the order the door returned them.
 * Pure and exported so the filter is tested without a render.
 */
export function pickFiles(paths: string[], props: FilesProps): string[] {
  return matchingFiles(paths, props).slice(0, props.limit ?? DEFAULT_FILE_LIMIT)
}

/** The compact tile's one line: which documents, before you open it. */
export function filesHeadline(props: FilesProps): string {
  if (props.path) return `Files · ${props.path}`
  if (props.folder) return `Files · ${props.folder}/`
  return 'Files · all'
}

/** An optional path-shaped field: absent, or a path the files service would take. */
function parsePath(
  value: unknown,
  field: string,
): { ok: true; path?: string } | { ok: false; detail: string } {
  if (value === undefined) return { ok: true }
  // Validated with the files service's OWN rule (`isValidFilePath`), imported
  // rather than re-spelled — so a traversal an agent writes is refused at the
  // raise, in the same words the write doors would have used, instead of
  // becoming a tile that says it couldn't read anything.
  if (!isFilledString(value) || !isValidFilePath(value))
    return {
      ok: false,
      detail: `${field} must be a shared-file path: relative, no “..”, no “:”`,
    }
  return { ok: true, path: value }
}

function parseProps(
  json: unknown,
): { ok: true; props: FilesProps } | { ok: false; detail: string } {
  const record = asRecord(json)
  if (!record) return { ok: false, detail: 'expected an object of props' }

  const path = parsePath(record.path, 'path')
  if (!path.ok) return path
  const folder = parsePath(record.folder, 'folder')
  if (!folder.ok) return folder
  if (path.path && folder.path) {
    return {
      ok: false,
      detail: 'give one of path (a document) or folder (a list), not both',
    }
  }

  const { limit } = record
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_FILE_LIMIT)
  ) {
    return {
      ok: false,
      detail: `limit must be a whole number from 1 to ${String(MAX_FILE_LIMIT)}`,
    }
  }

  // Rebuilt field by field, not spread: an agent's extra keys never become props.
  return {
    ok: true,
    props: {
      ...(path.path ? { path: path.path } : {}),
      ...(folder.path ? { folder: folder.path } : {}),
      ...(limit === undefined ? {} : { limit }),
    },
  }
}

/** One read of a files door: what came back, and whether the read failed. */
interface Read<T> {
  value: T | null
  failed: boolean
}

/**
 * The shared-document list, read fresh — on mount and again whenever `revision`
 * moves (the stack telling us a `file:*` event landed). Never stored on the row.
 */
function useFileList(revision: number, enabled: boolean): Read<string[]> {
  const [state, setState] = useState<Read<string[]>>({
    value: null,
    failed: false,
  })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void listFiles().then(
      (paths) => {
        if (!cancelled) setState({ value: paths, failed: false })
      },
      () => {
        // The ship degrades to "database: down" rather than crashing, and so
        // does a tile on it: keep the last good list, say the read failed.
        if (!cancelled) setState((prev) => ({ ...prev, failed: true }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [revision, enabled])
  return state
}

/** One document's contents, read fresh. `null` content means it isn't there. */
function useDocument(path: string | null, revision: number): Read<string> {
  const [state, setState] = useState<Read<string>>({
    value: null,
    failed: false,
  })
  const [loaded, setLoaded] = useState<string | null>(null)
  useEffect(() => {
    if (path === null) return
    let cancelled = false
    void readFile({ data: path }).then(
      (content) => {
        if (cancelled) return
        setState({ value: content, failed: false })
        setLoaded(path)
      },
      () => {
        if (!cancelled) setState((prev) => ({ ...prev, failed: true }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [path, revision])
  // `loaded` is what the CONTENT is of, so a tile can't show the previous
  // document's body under the new one's name for a frame.
  return { value: loaded === path ? state.value : null, failed: state.failed }
}

/** A document's body. Markdown gets rendered; anything else stays verbatim. */
function DocumentBody({ path, text }: { path: string; text: string }) {
  if (!path.endsWith('.md')) {
    return (
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
        {text}
      </pre>
    )
  }
  return (
    // Headings pulled down to body size, as `note` does: a tile is a tile, so
    // the markdown gives it structure rather than page-scale type.
    <article
      className={cn(
        'prose prose-sm dark:prose-invert max-h-64 max-w-none overflow-y-auto break-words',
        'prose-headings:my-1 prose-headings:text-sm prose-headings:font-semibold',
        'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1',
      )}
    >
      <ReactMarkdown>{text}</ReactMarkdown>
    </article>
  )
}

/** The open document, or the honest reason there's nothing to show. */
function OpenDocument({
  path,
  revision,
  onBack,
}: {
  path: string
  revision: number
  onBack: (() => void) | null
}) {
  const { value, failed } = useDocument(path, revision)
  return (
    <div className="flex flex-col gap-2">
      {/* The way back over the name, not beside it. Side by side in a tile on a
          390px phone the two shared one line and the document's own name — the
          thing telling you WHAT you're reading — was the half that truncated. */}
      <div className="flex flex-col">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className={cn(
              'flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground',
              TAP_TARGET,
            )}
          >
            <ChevronLeft className="size-3.5" />
            All documents
          </button>
        )}
        <span className="truncate font-mono text-xs text-muted-foreground">
          {path}
        </span>
      </div>
      {value === null ? (
        <p className="text-sm text-muted-foreground">
          {failed
            ? 'Couldn’t read the documents just now.'
            : /* There is no foreign key from a widget to what it shows, so the
                 referent CAN be gone — and the tile has to say which. */
              `“${path}” isn’t there any more.`}
        </p>
      ) : (
        <DocumentBody path={path} text={value} />
      )}
    </div>
  )
}

/** The browse list: every document this tile asked for, one tap to open. */
function DocumentList({
  props,
  revision,
  onOpen,
}: {
  props: FilesProps
  revision: number
  onOpen: (path: string) => void
}) {
  const { value, failed } = useFileList(revision, true)
  if (!value) {
    return (
      <p className="text-sm text-muted-foreground">
        {failed
          ? 'Couldn’t read the documents just now.'
          : 'Reading the shelf…'}
      </p>
    )
  }
  const matching = matchingFiles(value, props)
  const shown = pickFiles(value, props)
  if (shown.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {props.folder
          ? `Nothing in “${props.folder}” yet.`
          : 'No shared documents yet.'}
      </p>
    )
  }
  // What the cap is hiding, said out loud. A tile headlined "Files · all" that
  // silently stops at eight documents is the same dishonesty as a list quietly
  // dropping a pin — you'd have no way to tell a small shelf from a capped one.
  const hidden = matching.length - shown.length
  return (
    <>
      <ul className="flex flex-col gap-1">
        {shown.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => {
                onOpen(path)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-left text-sm',
                'hover:bg-muted/50',
                TAP_TARGET,
              )}
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{path}</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          and {hidden} more — narrow it with a folder, or raise the limit.
        </p>
      )}
    </>
  )
}

function FilesWidgetBody({
  props,
  revision,
}: {
  props: FilesProps
  revision: number
}) {
  // Which document the viewer has open, for a browse tile. Local to the tile:
  // "what I'm reading right now" is not the crew's business and is certainly
  // not the row's — the row holds the question, never the current answer.
  const [opened, setOpened] = useState<string | null>(null)
  const path = props.path ?? opened
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      {path === null ? (
        <DocumentList props={props} revision={revision} onOpen={setOpened} />
      ) : (
        <OpenDocument
          path={path}
          revision={revision}
          onBack={
            props.path
              ? null
              : () => {
                  setOpened(null)
                }
          }
        />
      )}
    </div>
  )
}

export const filesKind: WidgetKind = {
  summary:
    'The crew’s shared documents, browsable in a tile — a folder’s worth of names to tap through, or one document pinned open. READ-ONLY: it can never write, rename or delete a document. Nothing to answer; raise one when the crew will want a doc beside the conversation.',
  propsDoc: `{ path?: string (pin one document), folder?: string (browse one folder), limit?: number (1-${String(MAX_FILE_LIMIT)}, default ${String(DEFAULT_FILE_LIMIT)}) } — all optional; no filter means every document`,
  example: { folder: 'agents', limit: 8 },
  parse: (json): WidgetParse => {
    const parsed = parseProps(json)
    if (!parsed.ok) return parsed
    const props = parsed.props
    return {
      ok: true,
      view: {
        headline: filesHeadline(props),
        // Per INSTANCE, not per kind: a pinned document has no reason to wake
        // for every other document's save, while a LIST does — a new document
        // appearing is exactly what it exists to show.
        topics: [props.path ? fileTopic(props.path) : FILE_TOPIC_PATTERN],
        Body: ({ revision }) => (
          <FilesWidgetBody props={props} revision={revision} />
        ),
      },
    }
  },
}
