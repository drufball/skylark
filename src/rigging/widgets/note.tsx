import ReactMarkdown from 'react-markdown'

import { cn } from '@rigging/lib/utils'

import {
  asRecord,
  isFilledString,
  type WidgetKind,
  type WidgetParse,
} from './kind'

/**
 * `note` — a small markdown card pinned in a chat.
 *
 * The trivial kind, and it's here on purpose: it reads no service, subscribes to
 * no topic, and offers nothing to answer, which is exactly what proves the
 * catalog's shape isn't over-fitted to interactive widgets. Genuinely useful too
 * — the standing reminder a conversation keeps coming back to belongs above the
 * composer rather than scrolled away up the thread.
 *
 * Markdown comes from `react-markdown`, already in the repo for the files view;
 * the `prose` classes are the same Tailwind typography plugin that view uses.
 */

/** The tile's one-line summary, derived from the note itself. */
export function noteHeadline(text: string): string {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  // A closed tile is a tap target, not a document: the markers that carry
  // meaning down the page ("# ", "- ", "> ") read as noise on one line.
  const stripped = first?.replace(/^([#>]+|[-*+])\s*/, '').trim()
  return stripped && stripped !== '' ? stripped : 'Note'
}

export const noteKind: WidgetKind = {
  summary:
    'A small markdown card pinned above the composer — a standing reminder, a snippet, a short checklist. Nothing to answer; raise one when the crew will want to keep re-reading something.',
  propsDoc: '{ text: string } — markdown, kept short enough to read in a tile',
  example: { text: '**Standup** 09:30 — bring the board' },
  parse: (props): WidgetParse => {
    const record = asRecord(props)
    if (!record) return { ok: false, detail: 'expected an object of props' }
    if (!isFilledString(record.text))
      return { ok: false, detail: 'text must be a non-empty string' }
    const text = record.text
    return {
      ok: true,
      view: {
        headline: noteHeadline(text),
        topics: [],
        Body: () => (
          // Headings are pulled down to body size on purpose. `prose` sizes an
          // `#` heading for a page, and on a 390px phone that filled the whole
          // shelf with two enormous words — a note is a tile, not a document, so
          // the markdown gives it STRUCTURE (bold, lists, code) rather than
          // scale. Margins are tightened for the same reason.
          <article
            className={cn(
              'prose prose-sm dark:prose-invert max-w-none break-words px-3 pb-3',
              'prose-headings:my-1 prose-headings:text-sm prose-headings:font-semibold',
              'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1',
            )}
          >
            <ReactMarkdown>{text}</ReactMarkdown>
          </article>
        ),
      },
    }
  },
}
