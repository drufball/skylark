// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CollapsibleSidebar } from './collapsible-sidebar'

function setWidth(width: number) {
  window.innerWidth = width
  window.dispatchEvent(new Event('resize'))
}

const originalWidth = window.innerWidth

afterEach(() => {
  cleanup()
  setWidth(originalWidth)
})

describe('CollapsibleSidebar', () => {
  it('renders as a plain docked aside above the breakpoint, with no trigger', () => {
    setWidth(1024)
    render(
      <CollapsibleSidebar
        label="Chats"
        open={false}
        onOpenChange={vi.fn()}
        className="w-72"
      >
        <p>the list</p>
      </CollapsibleSidebar>,
    )
    expect(screen.getByText('the list')).toBeTruthy()
    expect(screen.queryByLabelText(/open chats/i)).toBeNull()
  })

  it('below the breakpoint, hides content behind a trigger button until opened', () => {
    setWidth(500)
    const onOpenChange = vi.fn()
    render(
      <CollapsibleSidebar
        label="Chats"
        open={false}
        onOpenChange={onOpenChange}
      >
        <p>the list</p>
      </CollapsibleSidebar>,
    )
    expect(screen.queryByText('the list')).toBeNull()
    const trigger = screen.getByLabelText(/open chats/i)
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('below the breakpoint, shows content in the drawer when open', () => {
    setWidth(500)
    render(
      <CollapsibleSidebar label="Chats" open={true} onOpenChange={vi.fn()}>
        <p>the list</p>
      </CollapsibleSidebar>,
    )
    expect(screen.getByText('the list')).toBeTruthy()
  })

  it("closing the drawer (e.g. the Sheet's own close button) calls onOpenChange(false)", () => {
    setWidth(500)
    const onOpenChange = vi.fn()
    render(
      <CollapsibleSidebar label="Chats" open={true} onOpenChange={onOpenChange}>
        <p>the list</p>
      </CollapsibleSidebar>,
    )
    fireEvent.click(screen.getByText('Close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
