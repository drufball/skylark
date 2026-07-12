// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AUTOSAVE_DEBOUNCE_MS, FilesView, type FilesViewProps } from './files'

afterEach(cleanup)

function setWidth(width: number) {
  window.innerWidth = width
  window.dispatchEvent(new Event('resize'))
}
const originalWidth = window.innerWidth
afterEach(() => {
  setWidth(originalWidth)
})

function renderView(props: Partial<FilesViewProps> = {}) {
  const onSelect = vi.fn()
  const onSave = vi.fn()
  const onCreate = vi.fn()
  const onDelete = vi.fn()
  const result = render(
    <FilesView
      files={[]}
      selected={null}
      content={null}
      busy={false}
      onSelect={onSelect}
      onSave={onSave}
      onCreate={onCreate}
      onDelete={onDelete}
      {...props}
    />,
  )
  return { ...result, onSelect, onSave, onCreate, onDelete }
}

describe('FilesView', () => {
  it('shows the empty state and the nothing-selected pane', () => {
    renderView()
    expect(screen.getByText(/no files yet/i)).toBeTruthy()
    expect(screen.getByText(/select a file/i)).toBeTruthy()
  })

  it('lists files and selects on click', () => {
    const { onSelect } = renderView({ files: ['a.md', 'notes/b.md'] })
    fireEvent.click(screen.getByText('notes/b.md'))
    expect(onSelect).toHaveBeenCalledWith('notes/b.md')
  })

  it('renders the selected file as markdown', () => {
    renderView({
      files: ['a.md'],
      selected: 'a.md',
      content: '# Hello\n\nsome text',
    })
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeTruthy()
    expect(screen.getByText('some text')).toBeTruthy()
  })

  it('creates a file through the new-file form', () => {
    const { onCreate } = renderView()
    fireEvent.click(screen.getByText(/new file/i))
    fireEvent.change(screen.getByPlaceholderText('notes/plan.md'), {
      target: { value: 'plan.md' },
    })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith('plan.md')
  })

  it('auto-saves a paused edit after the debounce, not before', () => {
    vi.useFakeTimers()
    try {
      const { onSave } = renderView({
        files: ['a.md'],
        selected: 'a.md',
        content: 'before',
      })
      fireEvent.click(screen.getByText('Edit'))
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'after' },
      })
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1)
      expect(onSave).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onSave).toHaveBeenCalledWith('a.md', 'after')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps typing alive: each keystroke resets the debounce', () => {
    vi.useFakeTimers()
    try {
      const { onSave } = renderView({
        files: ['a.md'],
        selected: 'a.md',
        content: '',
      })
      fireEvent.click(screen.getByText('Edit'))
      const box = screen.getByRole('textbox')
      fireEvent.change(box, { target: { value: 'x' } })
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100)
      fireEvent.change(box, { target: { value: 'xy' } })
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 100)
      expect(onSave).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(onSave).toHaveBeenCalledTimes(1)
      expect(onSave).toHaveBeenCalledWith('a.md', 'xy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaving edit mode flushes an unsaved draft immediately', () => {
    const { onSave } = renderView({
      files: ['a.md'],
      selected: 'a.md',
      content: 'before',
    })
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'after' },
    })
    fireEvent.click(screen.getByText('Done'))
    expect(onSave).toHaveBeenCalledWith('a.md', 'after')
  })

  it('remote updates flow into the open file while NOT editing', () => {
    const { rerender } = renderView({
      files: ['a.md'],
      selected: 'a.md',
      content: 'first',
    })
    rerender(
      <FilesView
        files={['a.md']}
        selected="a.md"
        content="second"
        busy={false}
        onSelect={vi.fn()}
        onSave={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('second')).toBeTruthy()
  })

  it('a remote update must not clobber the draft mid-edit', () => {
    const onSave = vi.fn()
    const props = {
      files: ['a.md'],
      selected: 'a.md',
      busy: false,
      onSelect: vi.fn(),
      onSave,
      onCreate: vi.fn(),
      onDelete: vi.fn(),
    }
    const { rerender } = render(<FilesView {...props} content="first" />)
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'my typing' },
    })
    rerender(<FilesView {...props} content="remote change" />)
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'my typing')
  })

  it('flushes a dirty draft when switching files before the debounce fires', () => {
    const onSave = vi.fn()
    const props = {
      files: ['a.md', 'b.md'],
      busy: false,
      onSelect: vi.fn(),
      onSave,
      onCreate: vi.fn(),
      onDelete: vi.fn(),
    }
    const { rerender } = render(
      <FilesView {...props} selected="a.md" content="before" />,
    )
    fireEvent.click(screen.getByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'typed but not yet saved' },
    })
    // Switching the selected file remounts the open pane immediately — the
    // keystrokes inside the debounce window must be saved, not dropped.
    rerender(<FilesView {...props} selected="b.md" content="other" />)
    expect(onSave).toHaveBeenCalledWith('a.md', 'typed but not yet saved')
  })

  it('renders a missing file (null content) as not-found, not as an editable empty file', () => {
    renderView({ files: [], selected: 'gone.md', content: null })
    expect(screen.getByText(/no such file/i)).toBeTruthy()
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('pins the view to its container height with its own overflow, so the file list and open file each scroll independently instead of the whole row dragging away', () => {
    const { container } = renderView({
      files: ['a.md'],
      selected: 'a.md',
      content: 'hello',
    })
    expect(container.firstElementChild?.className).toContain('h-full')
    expect(container.firstElementChild?.className).toContain('overflow-hidden')
    expect(container.querySelector('aside')?.className).toContain('min-h-0')
    expect(container.querySelector('section')?.className).toContain('min-h-0')
  })

  it('deletes only after confirmation', () => {
    const confirmSpy = vi
      .spyOn(window, 'confirm')
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)
    const { onDelete } = renderView({
      files: ['a.md'],
      selected: 'a.md',
      content: 'x',
    })
    const del = screen.getByLabelText('Delete a.md')
    fireEvent.click(del)
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(del)
    expect(onDelete).toHaveBeenCalledWith('a.md')
    confirmSpy.mockRestore()
  })

  it('on mobile, hides the explorer behind a trigger and closes it on selection', () => {
    setWidth(500)
    const { onSelect } = renderView({ files: ['a.md', 'notes/b.md'] })
    expect(screen.queryByText('notes/b.md')).toBeNull()
    fireEvent.click(screen.getByLabelText(/open files/i))
    expect(screen.getByText('notes/b.md')).toBeTruthy()
    fireEvent.click(screen.getByText('notes/b.md'))
    expect(onSelect).toHaveBeenCalledWith('notes/b.md')
    expect(screen.queryByText('notes/b.md')).toBeNull()
  })

  it('on desktop, the explorer stays docked with no trigger', () => {
    setWidth(1024)
    renderView({ files: ['a.md'] })
    expect(screen.getByText('a.md')).toBeTruthy()
    expect(screen.queryByLabelText(/open files/i)).toBeNull()
  })
})
