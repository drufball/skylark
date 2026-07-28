// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hull/files/server', () => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
}))
import { listFiles, readFile } from '@hull/files/server'

import { filesKind, filesHeadline, matchingFiles, pickFiles } from './files'

// `files` is the READ-ONLY window onto the crew's shared documents. The tests
// that matter most here are the ones about what it CANNOT do: it imports only
// the two reading doors, and nothing in the tile writes. See the zine — the
// files service auto-merges to main with no PR and a merge auto-deploys the
// running ship, so a widget that could write a path would be a path from a chat
// message to unreviewed code in a publicly-tunnelled process.

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(listFiles).mockReset()
  vi.mocked(readFile).mockReset()
})

/** The view a good blob parses to, or a failure the test can read. */
function parse(props: unknown) {
  const result = filesKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

function body(props: unknown) {
  const { Body } = parse(props)
  return <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />
}

describe('files: parsing', () => {
  it('accepts an empty blob — every shared document', () => {
    expect(parse({}).headline).toBe('Files · all')
  })

  it('headlines a pinned document by its path', () => {
    expect(parse({ path: 'agents/tilde/index.md' }).headline).toBe(
      'Files · agents/tilde/index.md',
    )
  })

  it('headlines a folder by its name', () => {
    expect(parse({ folder: 'agents' }).headline).toBe('Files · agents/')
  })

  it.each([
    ['null', null],
    ['a string', 'notes.md'],
    ['a number', 7],
    ['an array', ['notes.md']],
  ])('refuses props that are %s, not an object', (_label, props) => {
    expect(filesKind.parse(props)).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['traversal', { path: '../../etc/passwd' }],
    ['absolute', { path: '/etc/passwd' }],
    ['a topic-breaking colon', { path: 'a:b.md' }],
    ['blank', { path: '  ' }],
    ['not a string', { path: 7 }],
  ])('refuses a path that is %s', (_label, props) => {
    // The refusal happens at the RAISE, through validateWidgetProps — so an
    // agent that writes a traversal is told on the spot rather than getting a
    // tile that shrugs. Same rule the files service's own doors enforce
    // (`isValidFilePath`), imported rather than re-spelled.
    expect(filesKind.parse(props)).toMatchObject({ ok: false })
  })

  it.each([
    ['traversal', { folder: '../secrets' }],
    ['absolute', { folder: '/etc' }],
    ['not a string', { folder: [] }],
  ])('refuses a folder that is %s', (_label, props) => {
    expect(filesKind.parse(props)).toMatchObject({ ok: false })
  })

  it('refuses a blob that pins a document AND a folder', () => {
    const result = filesKind.parse({ path: 'a.md', folder: 'agents' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/one|both/i)
  })

  it.each([
    ['not a number', { limit: 'eight' }],
    ['zero', { limit: 0 }],
    ['fractional', { limit: 2.5 }],
    ['absurd', { limit: 5000 }],
  ])('refuses a limit that is %s', (_label, props) => {
    expect(filesKind.parse(props)).toMatchObject({ ok: false })
  })

  it('parses its own documented example', () => {
    expect(filesKind.parse(filesKind.example).ok).toBe(true)
  })
})

describe('files: which topics keep it live', () => {
  it('a browse tile watches every document, so a NEW one appears', () => {
    expect(parse({}).topics).toEqual(['file:*'])
    expect(parse({ folder: 'agents' }).topics).toEqual(['file:*'])
  })

  it('a pinned document watches only its own topic', () => {
    // Declared per INSTANCE: a tile showing one document has no reason to wake
    // for every other document's save.
    expect(parse({ path: 'notes.md' }).topics).toEqual(['file:notes.md'])
  })
})

describe('pickFiles', () => {
  const all = ['agents/bix.md', 'agents/tilde.md', 'notes.md', 'plan.md']

  it('keeps everything when no folder is named', () => {
    expect(pickFiles(all, {})).toEqual(all)
  })

  it('keeps only what is under the folder', () => {
    expect(pickFiles(all, { folder: 'agents' })).toEqual([
      'agents/bix.md',
      'agents/tilde.md',
    ])
  })

  it('does not mistake a sibling prefix for a folder', () => {
    // "agent" must not swallow "agents/…": the separator is part of the match.
    expect(pickFiles(all, { folder: 'agent' })).toEqual([])
  })

  it('caps the list at the limit, defaulting to a tile-sized handful', () => {
    const many = Array.from({ length: 30 }, (_, n) => `doc${String(n)}.md`)
    expect(pickFiles(many, {}).length).toBeLessThan(many.length)
    expect(pickFiles(many, { limit: 2 })).toHaveLength(2)
  })
})

describe('matchingFiles', () => {
  it('is the filter without the cap — what the tile counts against', () => {
    const many = Array.from({ length: 12 }, (_, n) => `doc${String(n)}.md`)
    expect(matchingFiles(many, { limit: 2 })).toHaveLength(12)
    expect(matchingFiles(['a/x.md', 'b/y.md'], { folder: 'a' })).toEqual([
      'a/x.md',
    ])
  })
})

describe('filesHeadline', () => {
  it('names the whole shelf when nothing is narrowed', () => {
    expect(filesHeadline({})).toBe('Files · all')
  })
})

describe('files: the body', () => {
  it('reads the list fresh through the files service’s own door', async () => {
    vi.mocked(listFiles).mockResolvedValue(['notes.md', 'plan.md'])
    render(body({}))
    expect(await screen.findByText('notes.md')).toBeTruthy()
    expect(screen.getByText('plan.md')).toBeTruthy()
  })

  it('shows a pinned document’s real contents', async () => {
    vi.mocked(readFile).mockResolvedValue('# Standing orders\n\nkeep it small')
    render(body({ path: 'notes.md' }))
    expect(await screen.findByText(/keep it small/)).toBeTruthy()
    expect(readFile).toHaveBeenCalledWith({ data: 'notes.md' })
  })

  it('says a deleted document is gone rather than showing an empty card', async () => {
    // There is no foreign key from a widget to what it shows (contents are
    // fetched, never stored), so the referent CAN vanish — and the tile has to
    // say so out loud, naming it.
    vi.mocked(readFile).mockResolvedValue(null)
    render(body({ path: 'gone.md' }))
    expect(
      await screen.findByText(/“gone\.md” isn’t there any more/i),
    ).toBeTruthy()
  })

  it('says the shelf is empty rather than drawing a void', async () => {
    vi.mocked(listFiles).mockResolvedValue([])
    render(body({}))
    expect(await screen.findByText(/no shared documents/i)).toBeTruthy()
  })

  it('says how many documents it is NOT showing', async () => {
    // Observed live at 390px: a tile headlined "Files · all" showing the first
    // eight of eleven documents, with nothing saying so. A list that silently
    // stops is the same dishonesty as an `issue-list` quietly dropping a pin.
    vi.mocked(listFiles).mockResolvedValue(
      Array.from({ length: 11 }, (_, n) => `doc${String(n)}.md`),
    )
    render(body({ limit: 8 }))
    expect(await screen.findByText(/3 more/)).toBeTruthy()
  })

  it('says nothing about more when it is showing everything', async () => {
    vi.mocked(listFiles).mockResolvedValue(['notes.md'])
    render(body({}))
    expect(await screen.findByText('notes.md')).toBeTruthy()
    expect(screen.queryByText(/more/)).toBeNull()
  })

  it('says a folder holds nothing, naming the folder', async () => {
    vi.mocked(listFiles).mockResolvedValue(['notes.md'])
    render(body({ folder: 'agents' }))
    expect(await screen.findByText(/nothing in “agents”/i)).toBeTruthy()
  })

  it('opens a document from the list, and comes back', async () => {
    vi.mocked(listFiles).mockResolvedValue(['notes.md'])
    vi.mocked(readFile).mockResolvedValue('the note body')
    render(body({}))
    fireEvent.click(await screen.findByRole('button', { name: /notes\.md/ }))
    expect(await screen.findByText('the note body')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /all documents/i }))
    expect(
      await screen.findByRole('button', { name: /notes\.md/ }),
    ).toBeTruthy()
  })

  it('offers nothing that writes — no save, no delete, no editing', async () => {
    // The security requirement, pinned as a test: this widget browses and
    // reads. A `files` tile that could write a path would reach unreviewed
    // executable code in the running ship (the sweep auto-merges to main with
    // no PR, and a merge auto-deploys).
    vi.mocked(listFiles).mockResolvedValue(['notes.md'])
    vi.mocked(readFile).mockResolvedValue('the note body')
    render(body({}))
    fireEvent.click(await screen.findByRole('button', { name: /notes\.md/ }))
    expect(await screen.findByText('the note body')).toBeTruthy()
    for (const name of [/save/i, /delete/i, /remove/i, /edit/i, /new file/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('re-reads when the ship’s log says a document changed', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after')
    const { Body } = parse({ path: 'notes.md' })
    const { rerender } = render(
      <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('before')).toBeTruthy()
    rerender(
      <Body revision={1} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('after')).toBeTruthy()
  })

  it('degrades to an honest line when the door fails, never a white screen', async () => {
    vi.mocked(listFiles).mockRejectedValue(new Error('database: down'))
    render(body({}))
    await waitFor(() => {
      expect(screen.getByText(/couldn’t read the documents/i)).toBeTruthy()
    })
  })

  it('says so when reading a PINNED document fails, rather than claiming it’s gone', async () => {
    // "The read failed" and "the document was deleted" are different facts, and
    // a tile that reported the first as the second would send somebody looking
    // for a file that's still there.
    vi.mocked(readFile).mockRejectedValue(new Error('database: down'))
    render(body({ path: 'notes.md' }))
    await waitFor(() => {
      expect(screen.getByText(/couldn’t read the documents/i)).toBeTruthy()
    })
    expect(screen.queryByText(/isn’t there any more/i)).toBeNull()
  })

  it('shows a non-markdown document verbatim', async () => {
    // Markdown is a rendering choice for `.md`; everything else is text, and
    // guessing at structure in it would misrepresent the file.
    vi.mocked(readFile).mockResolvedValue('key = value\n# not a heading')
    render(body({ path: 'ship.conf' }))
    expect(await screen.findByText(/# not a heading/)).toBeTruthy()
  })
})
