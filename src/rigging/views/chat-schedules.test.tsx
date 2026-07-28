// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { scheduleSummary } from './chat-schedules'
import { installChatTestBed, renderView, setWidth } from './chat.test-support'

installChatTestBed()

describe('scheduleSummary', () => {
  it('summarizes a recurring schedule with its cadence', () => {
    expect(
      scheduleSummary({
        intervalMinutes: 30,
        fireAt: null,
        nextFireAt: '2026-07-18T13:00:00.000Z',
      }),
    ).toContain('every 30 min')
  })

  it('summarizes a one-shot schedule', () => {
    expect(
      scheduleSummary({
        intervalMinutes: null,
        fireAt: '2026-07-18T13:00:00.000Z',
        nextFireAt: null,
      }),
    ).toContain('once')
  })
})

describe('ChatView: schedules', () => {
  it('shows no Schedules affordance when the host wires no scheduling', () => {
    renderView({ activeId: 'c1' })
    expect(screen.queryByLabelText('Schedules')).toBeNull()
  })

  it('toggles the schedules panel and creates a recurring schedule', () => {
    const onCreate = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: {
        items: [],
        onCreate,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
      },
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.change(screen.getByPlaceholderText('Message to schedule…'), {
      target: { value: 'stand up' },
    })
    fireEvent.change(screen.getByLabelText('Schedule mode'), {
      target: { value: 'repeat' },
    })
    fireEvent.change(screen.getByLabelText('Interval minutes'), {
      target: { value: '15' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onCreate).toHaveBeenCalledWith({
      body: 'stand up',
      intervalMinutes: 15,
    })
  })

  it('creates a one-shot schedule from a fire time', () => {
    const onCreate = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: {
        items: [],
        onCreate,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
      },
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.change(screen.getByPlaceholderText('Message to schedule…'), {
      target: { value: 'launch' },
    })
    // Default mode is 'once'; give it a fire time and add.
    fireEvent.change(screen.getByLabelText('Fire time'), {
      target: { value: '2026-07-20T09:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const arg = onCreate.mock.calls[0][0] as {
      body: string
      fireAt?: string
      intervalMinutes?: number
    }
    expect(arg.body).toBe('launch')
    expect(arg.intervalMinutes).toBeUndefined()
    expect(new Date(arg.fireAt ?? '').getMinutes()).toBe(0)
  })

  it('deletes a schedule from the panel', () => {
    const onDelete = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: {
        items: [
          {
            id: 's1',
            authorHandle: 'dru',
            body: 'ping',
            enabled: true,
            intervalMinutes: 30,
            fireAt: null,
            nextFireAt: '2026-07-18T13:00:00.000Z',
          },
        ],
        onCreate: vi.fn(),
        onToggle: vi.fn(),
        onDelete,
      },
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.click(screen.getByLabelText('Delete schedule s1'))
    expect(onDelete).toHaveBeenCalledWith('s1')
  })

  it('toggles a schedule on/off from the panel', () => {
    const onToggle = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: {
        items: [
          {
            id: 's1',
            authorHandle: 'dru',
            body: 'ping',
            enabled: true,
            intervalMinutes: 30,
            fireAt: null,
            nextFireAt: '2026-07-18T13:00:00.000Z',
          },
        ],
        onCreate: vi.fn(),
        onToggle,
        onDelete: vi.fn(),
      },
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.click(screen.getByLabelText('Disable schedule s1'))
    expect(onToggle).toHaveBeenCalledWith('s1', false)
  })

  /**
   * `items` is optional apart from the three callbacks that turn the
   * affordance on, so "the host has wired scheduling but hasn't loaded (or
   * has no) schedules" is a real state — the first render of every chat, in
   * fact. The control shows itself without a count rather than "(0)" or
   * "(undefined)", on both layouts.
   */
  it('shows the control with no count before any schedules have loaded', () => {
    for (const width of [390, 1280]) {
      setWidth(width)
      const { unmount } = renderView({
        activeId: 'c1',
        schedules: {
          items: undefined,
          onCreate: vi.fn(),
          onToggle: vi.fn(),
          onDelete: vi.fn(),
        },
      })
      if (width === 390) fireEvent.click(screen.getByLabelText('More'))
      expect(screen.getByLabelText('Schedules').textContent).toBe('Schedules')
      unmount()
    }
  })
})
