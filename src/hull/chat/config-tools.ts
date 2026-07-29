import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { SessionToolsProvider } from '@hull/agent/runtime'
import { getShipDefaultModel, setShipDefaultModel } from '@hull/agent/settings'
import type { Database } from '@hull/db/client'
import {
  listPlaybooks,
  seedPlaybooks,
  upsertPlaybook,
  type PlaybookInput,
} from '@hull/issues/playbooks'
import {
  createUser,
  getUserByHandle,
  updateAgentUser,
  validateHandle,
} from '@hull/users/service'
import { CHAT_CONFIG } from '@hull/agent/agent-config'
import { uuidv7 } from '@earendil-works/pi-agent-core'

import { findChatForSession } from './messages'
import type { AsActor } from './session-tools'

/**
 * The Config room's well-known chat id (`rigging/rooms/rooms.ts`'s
 * `room-config`). Hardcoded here rather than threaded in as a parameter: a
 * default room's id is already the ship-wide well-known constant every other
 * seam keys off (`chatDocsDir`, the seed, the nav round trip), so gating on
 * the SAME literal keeps this tool from ever accidentally landing on a
 * different chat because a caller passed the wrong string.
 */
const CONFIG_ROOM_CHAT_ID = 'room-config'

/**
 * The Config room's agent-facing tools: `config_playbook`, `config_persona`,
 * `config_model` — the conversational front door issue #0eyx asks for onto
 * three services that stay exactly as separate as they are today (playbooks,
 * crew personas, the ship's default model). Every one of these ALREADY has a
 * real web door (`savePlaybook`, `createAgentUser`/`updateAgentUser`,
 * `getDefaultModel`/`setDefaultModel`); this is the same operations wrapped
 * as tools an agent's own turn can call, exactly the way `chat_post` wraps
 * `addMessage` rather than inventing a second way to post.
 *
 * Registered ONLY on the Config room's resident session — same gating shape
 * as `createChatSessionTools`, which hands out `chat_post`/`chat_widget` only
 * to a session that backs a chat membership. These tools are more powerful
 * (a persona edit changes what every OTHER agent does), so this module is
 * deliberately separate from session-tools.ts rather than folded into it —
 * a session should have to opt in explicitly (by being the Config room's
 * agent) rather than get them as a side effect of being in any chat at all.
 *
 * Runs under the agent's own actor (`asActor`), same posture as chat's tools:
 * `users`/`playbooks` carry no RLS (public read/write within the crew, like
 * `extensions`), so this doesn't change who CAN do these things — only who
 * can do them by talking instead of opening a settings page.
 */

const PLAYBOOK_PARAMS = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('save')], {
    description:
      '"list" every playbook (roster + entrypoint, by handle), or "save" one — creating it if the name is new, updating it if the name already exists.',
  }),
  name: Type.Optional(
    Type.String({ description: 'save: the playbook’s name.' }),
  ),
  description: Type.Optional(
    Type.String({ description: 'save: a short description of the strategy.' }),
  ),
  memberHandles: Type.Optional(
    Type.Array(Type.String(), {
      description: 'save: the roster, by handle (e.g. ["tilde", "bix"]).',
    }),
  ),
  entrypointHandle: Type.Optional(
    Type.String({
      description:
        'save: which roster member’s session a "building" issue seeds. Must be in memberHandles.',
    }),
  ),
  memberInstructions: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'save: optional per-member brief, keyed by HANDLE (not id) — every key must be a roster member.',
    }),
  ),
})

const PERSONA_PARAMS = Type.Object({
  action: Type.Union([Type.Literal('create'), Type.Literal('edit')], {
    description:
      '"create" a brand new agent persona, or "edit" an existing one’s config.',
  }),
  handle: Type.String({
    description:
      'create: the new agent’s handle (lowercase, digits, underscore). edit: which agent.',
  }),
  displayName: Type.Optional(
    Type.String({ description: 'create: the crew name shown for this agent.' }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        'The persona’s system prompt — who it is and how it behaves. Omitted on create defaults to the standard chat-pilot prompt.',
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Allowlist of tool names (e.g. ["read","bash"]). Omitted keeps/uses the default coding tools.',
    }),
  ),
})

const MODEL_PARAMS = Type.Object({
  action: Type.Union(
    [Type.Literal('get'), Type.Literal('set'), Type.Literal('clear')],
    {
      description:
        '"get" the current default model (override or env fallback), "set" the ship-wide override, or "clear" it back to the env default.',
    },
  ),
  model: Type.Optional(
    Type.String({ description: 'set: the gateway model name to default to.' }),
  ),
})

function said(text: string) {
  return { content: [{ type: 'text' as const, text }], details: { id: null } }
}

/** A playbook input, spelled in handles, resolved to the ids the service wants. */
async function resolvePlaybookInput(
  db: Database,
  params: {
    name?: string
    description?: string
    memberHandles?: string[]
    entrypointHandle?: string
    memberInstructions?: Record<string, string>
  },
): Promise<PlaybookInput> {
  const name = params.name?.trim()
  if (!name) throw new Error('config_playbook save needs a name')
  const memberHandles = params.memberHandles ?? []
  if (memberHandles.length === 0)
    throw new Error('config_playbook save needs at least one memberHandles')
  const entrypointHandle = params.entrypointHandle?.trim()
  if (!entrypointHandle)
    throw new Error('config_playbook save needs an entrypointHandle')

  async function idFor(handle: string): Promise<string> {
    const user = await getUserByHandle(db, handle)
    if (!user) throw new Error(`no crew member called @${handle}`)
    return user.id
  }

  const memberIds = await Promise.all(memberHandles.map(idFor))
  const entrypointId = await idFor(entrypointHandle)

  const memberInstructions: Record<string, string> = {}
  for (const [handle, text] of Object.entries(
    params.memberInstructions ?? {},
  )) {
    memberInstructions[await idFor(handle)] = text
  }

  return {
    name,
    description: params.description ?? '',
    memberIds,
    entrypointId,
    memberInstructions,
  }
}

function configPlaybookTool(asActor: AsActor, agentUserId: string) {
  return defineTool({
    name: 'config_playbook',
    label: 'List or save an issue playbook',
    description:
      'List every playbook (who works an issue, and who starts) or save one — creating it if the name is new, updating its roster/entrypoint/description if it already exists. A playbook names its crew by HANDLE, never by id.',
    promptSnippet:
      'config_playbook(action, name, memberHandles, entrypointHandle) — list or save an issue-handling playbook.',
    parameters: PLAYBOOK_PARAMS,
    execute: async (_toolCallId, params) => {
      if (params.action === 'list') {
        // Ensures the ship default exists before listing it, same as the web
        // door (`listPlaybooksView`) — a fresh ship's playbooks table is
        // otherwise empty until something writes to it.
        await asActor(agentUserId, (tx) => seedPlaybooks(tx))
        const rows = await asActor(agentUserId, (tx) => listPlaybooks(tx))
        if (rows.length === 0) return said('No playbooks yet.')
        return said(
          rows
            .map((p) => `${p.name}: ${String(p.memberIds.length)} member(s)`)
            .join('\n'),
        )
      }
      const input = await asActor(agentUserId, (tx) =>
        resolvePlaybookInput(tx, params),
      )
      const saved = await asActor(agentUserId, (tx) =>
        upsertPlaybook(tx, input),
      )
      return said(`Saved playbook \u201c${saved.name}\u201d.`)
    },
  })
}

function configPersonaTool(asActor: AsActor, agentUserId: string) {
  return defineTool({
    name: 'config_persona',
    label: 'Create or edit an agent persona',
    description:
      'Create a brand new agent crew member, or edit an existing one’s system prompt / tools. Every agent not otherwise configured boots as a read-only chat pilot; a fresh persona created here gets the same default unless you set systemPrompt/tools yourself.',
    promptSnippet:
      'config_persona(action, handle, systemPrompt) — create or edit an agent’s persona.',
    parameters: PERSONA_PARAMS,
    execute: async (_toolCallId, params) => {
      const handle = params.handle.trim()
      if (params.action === 'create') {
        const clean = validateHandle(handle)
        const existing = await asActor(agentUserId, (tx) =>
          getUserByHandle(tx, clean),
        )
        if (existing) throw new Error(`@${clean} already exists`)
        const trimmedDisplayName = params.displayName?.trim()
        const displayName =
          trimmedDisplayName && trimmedDisplayName.length > 0
            ? trimmedDisplayName
            : clean
        await asActor(agentUserId, (tx) =>
          createUser(tx, {
            id: uuidv7(),
            handle: clean,
            displayName,
            type: 'agent',
            ...CHAT_CONFIG,
            extensionIds: [],
            ...(params.systemPrompt !== undefined
              ? { systemPrompt: params.systemPrompt }
              : {}),
            ...(params.tools !== undefined ? { tools: params.tools } : {}),
          }),
        )
        return said(`Created @${clean}.`)
      }
      const user = await asActor(agentUserId, (tx) =>
        getUserByHandle(tx, handle),
      )
      if (user?.type !== 'agent') throw new Error(`no agent called @${handle}`)
      await asActor(agentUserId, (tx) =>
        updateAgentUser(tx, user.id, {
          ...(params.systemPrompt !== undefined
            ? { systemPrompt: params.systemPrompt }
            : {}),
          ...(params.tools !== undefined ? { tools: params.tools } : {}),
        }),
      )
      return said(`Updated @${handle}.`)
    },
  })
}

function configModelTool(asActor: AsActor, agentUserId: string) {
  return defineTool({
    name: 'config_model',
    label: 'Get, set or clear the ship default model',
    description:
      'Get the ship’s current default model (the ship override if one is set, else SKYLARK_DEFAULT_MODEL), set an override every new session boots on from now on, or clear it back to the env default.',
    promptSnippet:
      'config_model(action, model) — get, set, or clear the ship-wide default model.',
    parameters: MODEL_PARAMS,
    execute: async (_toolCallId, params) => {
      if (params.action === 'get') {
        const override = await asActor(agentUserId, (tx) =>
          getShipDefaultModel(tx),
        )
        return said(
          override
            ? `Ship default model override: ${override}`
            : 'No override set — new sessions boot on SKYLARK_DEFAULT_MODEL (or the built-in fallback).',
        )
      }
      if (params.action === 'set') {
        const model = params.model?.trim()
        if (!model) throw new Error('config_model set needs a model')
        await asActor(agentUserId, (tx) => setShipDefaultModel(tx, model))
        return said(`Ship default model set to ${model}.`)
      }
      await asActor(agentUserId, (tx) => setShipDefaultModel(tx, null))
      return said(
        'Cleared the ship default model override — new sessions boot on SKYLARK_DEFAULT_MODEL again.',
      )
    },
  })
}

/**
 * Chat's Config-room contribution to a session's tools — gated by chat
 * MEMBERSHIP, exactly like `createChatSessionTools`, but narrowed one step
 * further: to the ONE well-known chat (`room-config`), not every chat the
 * session happens to back. These tools are more powerful than
 * `chat_post`/`chat_widget` — a persona edit changes what every OTHER
 * agent does — so a session only gets them by being the Config room's
 * own resident session, never by being in just any chat.
 *
 * Every read/write still runs under the agent's own actor (`asActor`), same
 * posture as chat's own tools — `users`/`playbooks`/`ship_settings`
 * carry no RLS (public within the crew, like `extensions`), so this doesn't
 * change WHO can do these things, only who can do them by talking instead of
 * opening a settings page.
 */
export function createConfigSessionTools(deps: {
  asActor: AsActor
}): SessionToolsProvider {
  const { asActor } = deps
  return async ({ sessionId, agentUserId }) => {
    if (!agentUserId) return []
    const chat = await asActor(agentUserId, (tx) =>
      findChatForSession(tx, { sessionId, agentUserId }),
    )
    if (chat?.chatId !== CONFIG_ROOM_CHAT_ID) return []
    return [
      configPlaybookTool(asActor, agentUserId),
      configPersonaTool(asActor, agentUserId),
      configModelTool(asActor, agentUserId),
    ]
  }
}
