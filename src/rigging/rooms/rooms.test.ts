import { describe, expect, it } from 'vitest'

import { SEED_AGENTS } from '@hull/users/service'
import { resolveWidget } from '@rigging/widgets/registry'

import { DEFAULT_ROOMS, roomViewLink } from './rooms'

// The default rooms are DATA — a title, an agent, and widget blobs. Nothing
// checks them at runtime (the seed just writes rows), so this file is the
// check: every room names a kind this ship can render, with props the catalog
// actually accepts, and an agent the crew seed actually puts aboard.

describe('the default rooms', () => {
  it('gives every room a distinct well-known id', () => {
    const ids = DEFAULT_ROOMS.map((room) => room.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('opens a room for each of the ship’s three standing surfaces', () => {
    expect(DEFAULT_ROOMS.map((room) => room.title)).toEqual([
      'Issues',
      'Files',
      'Inbox',
    ])
  })

  it('arranges only widgets the catalog can render, with props it accepts', () => {
    for (const room of DEFAULT_ROOMS) {
      expect(room.widgets.length).toBeGreaterThan(0)
      for (const widget of room.widgets) {
        const resolved = resolveWidget(widget.kind, widget.props)
        expect(
          resolved.ok,
          `${room.title}/${widget.kind}: ${resolved.ok ? '' : resolved.detail}`,
        ).toBe(true)
      }
    }
  })

  /**
   * Issues, Files and Inbox left the rail when they got rooms. Their routes are
   * deliberately still alive — a widget tile is a readout, not the whole board
   * — so each room has to carry the way through to its own richer view, or the
   * view becomes a page nobody can find.
   */
  it('links every room through to the view it is the room for', () => {
    for (const room of DEFAULT_ROOMS) {
      const link = roomViewLink(room.id)
      expect(link, room.title).not.toBeNull()
      expect(link?.to.startsWith('/')).toBe(true)
      expect(link?.label.length).toBeGreaterThan(0)
    }
  })

  it('gives an ordinary chat no view link at all', () => {
    expect(roomViewLink('019fa5b1-f0f1-7000-8000-000000000000')).toBeNull()
  })

  it('puts an agent from the standard crew in every room', () => {
    // "The agent is right there beside the thing" is the whole point of a room,
    // so a room with nobody in it would be a dead surface — and the handle has
    // to be one the crew seed really creates, not a new persona invented here.
    const aboard = new Set(SEED_AGENTS.map((agent) => agent.handle))
    for (const room of DEFAULT_ROOMS) {
      expect(aboard.has(room.agentHandle), room.agentHandle).toBe(true)
    }
  })
})
