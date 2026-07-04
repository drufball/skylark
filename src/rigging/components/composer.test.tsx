// @vitest-environment jsdom
import { render, cleanup, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Composer } from './composer'

describe('Composer', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders a textarea and send button', () => {
    const noop = () => {
      // noop
    }
    const { container } = render(<Composer onSend={noop} busy={false} />)
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.querySelector('button')).toBeTruthy()
  })

  it('calls onSend with trimmed text and clears input', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer onSend={onSend} busy={false} />)

    const textarea = container.querySelector('textarea')
    const button = container.querySelector('button')
    expect(textarea).toBeTruthy()
    expect(button).toBeTruthy()
    if (!textarea || !button) return

    fireEvent.change(textarea, { target: { value: '  hello world  ' } })
    fireEvent.click(button)

    expect(onSend).toHaveBeenCalledWith('hello world')
    expect(textarea.value).toBe('')
  })

  it('does not send empty or whitespace-only messages', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer onSend={onSend} busy={false} />)

    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    if (!button) return

    // Try empty
    fireEvent.click(button)
    expect(onSend).not.toHaveBeenCalled()

    // Try whitespace only
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    if (!textarea) return
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.click(button)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables button when busy', () => {
    const noop = () => {
      // noop
    }
    const { container } = render(<Composer onSend={noop} busy={true} />)
    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    if (!button) return
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('submits on Enter key', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer onSend={onSend} busy={false} />)

    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    if (!textarea) return
    fireEvent.change(textarea, { target: { value: 'test message' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSend).toHaveBeenCalledWith('test message')
  })

  it('does not submit on Shift+Enter (allows newline)', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer onSend={onSend} busy={false} />)

    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    if (!textarea) return
    fireEvent.change(textarea, { target: { value: 'test message' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('uses custom placeholder when provided', () => {
    const noop = () => {
      // noop
    }
    const { container } = render(
      <Composer onSend={noop} busy={false} placeholder="Custom placeholder" />,
    )
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()
    if (!textarea) return
    expect(textarea.getAttribute('placeholder')).toBe('Custom placeholder')
  })

  it('shows spinner icon when busy', () => {
    const noop = () => {
      // noop
    }
    const { container } = render(<Composer onSend={noop} busy={true} />)
    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    if (!button) return
    // The Loader2 icon has animate-spin class
    expect(button.querySelector('.animate-spin')).toBeTruthy()
  })
})
