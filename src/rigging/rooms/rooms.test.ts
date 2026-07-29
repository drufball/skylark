import { describe, expect, it } from 'vitest'

import { SEED_AGENTS } from '@hull/users/service'
import { resolveWidget } from '@rigging/widgets/registry'

import { DEFAULT_ROOMS, roomForView, roomViewLink } from './rooms'

// The default rooms are DATA — a title, an agent, and widget blobs. Nothing
// checks them at runtime (the seed just writes rows), so this file is the
// check: every room names a kind this ship can render, with props the catalog
// actually accepts, and an agent the crew seed actually puts aboard.

describe('the default rooms', () => {
  it('gives every room a distinct well-known id', () => {
    const ids = DEFAULT_ROOMS.map((room) => room.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('opens a room for each of the ship’s standing surfaces', () => {
    expect(DEFAULT_ROOMS.map((room) => room.title)).toEqual([
      'Issues',
      'Files',
      'Inbox',
      'Config',
    ])
  })

  /**
   * `/inbox` is a permanent rail entry (#933f), not a surface the Inbox room
   * owns — so unlike Issues and Files, it names no `view`. The room is still
   * an ordinary conversation with @bix, carrying a filtered `inbox` tile.
   */
  it('gives the Inbox room no view link — that surface lives in the rail now', () => {
    const inbox = DEFAULT_ROOMS.find((room) => room.id === 'room-inbox')
    expect(inbox?.view).toBeUndefined()
  })

  /**
   * The Config room (#0eyx) names no `view` either — but for a different
   * reason than Inbox: its three underlying surfaces (`/models`,
   * `/agents?tab=playbooks`, `/agents?tab=crew`) are surfaces the rail ALREADY
   * reaches (Models, Crew), so a `view` here would list one of them twice.
   */
  it('gives the Config room no view link — its surfaces are already in the rail', () => {
    const config = DEFAULT_ROOMS.find((room) => room.id === 'room-config')
    expect(config?.view).toBeUndefined()
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
   * Issues and Files left the rail when they got rooms; their routes are
   * deliberately still alive — a widget tile is a readout, not the whole board
   * — so each of THOSE rooms has to carry the way through to its own richer
   * view, or the view becomes a page nobody can find. Inbox is the exception
   * (see above): it names no view because `/inbox` is in the rail.
   */
  it('links every room that names a view through to it', () => {
    const withView = DEFAULT_ROOMS.filter((room) => room.view)
    expect(withView.length).toBeGreaterThan(0)
    for (const room of withView) {
      const link = roomViewLink(room.id)
      expect(link, room.title).not.toBeNull()
      expect(link?.to.startsWith('/')).toBe(true)
      expect(link?.label.length).toBeGreaterThan(0)
    }
  })

  it('gives an ordinary chat no view link at all', () => {
    expect(roomViewLink('019fa5b1-f0f1-7000-8000-000000000000')).toBeNull()
  })

  /**
   * The other half of the same door. #cse7 linked a room OUT to its view and
   * gave the view nothing back, so `/issues` was a one-way trip: the only way
   * out was the browser's back button, which isn't navigation, it's a rescue.
   */
  it('links every room’s view back to the room it came from', () => {
    for (const room of DEFAULT_ROOMS) {
      if (!room.view) continue
      const back = roomForView(room.view.to)
      expect(back, room.view.to).not.toBeNull()
      expect(back?.to).toContain(room.id)
      expect(back?.label).toContain(room.title)
    }
  })

  it('offers no way back from a surface that is nobody’s room', () => {
    expect(roomForView('/models')).toBeNull()
  })

  it('round-trips: out to the view, and back to the same room', () => {
    for (const room of DEFAULT_ROOMS) {
      if (!room.view) continue
      const out = roomViewLink(room.id)
      expect(out).not.toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(roomForView(out!.to)?.to).toBe(`/chat?chat=${room.id}`)
    }
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
