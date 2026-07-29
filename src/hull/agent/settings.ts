import { eq } from 'drizzle-orm'

import type { Database } from '@hull/db/client'

import { shipSettings } from './schema'

/**
 * The ship's own settings: a singleton row keyed by the fixed id `"ship"`.
 * Today the only field is the default-model override — see the doc comment on
 * `shipSettings` in schema.ts for why this exists instead of a per-user
 * preference, and `defaultModelRef`/`DEFAULT_MODEL` (models.ts/runtime.ts) for
 * how the env var still decides when nothing here has been set.
 */
const SHIP_SETTINGS_ID = 'ship'

/** The stored override, or null if the ship has never set one. */
export async function getShipDefaultModel(
  db: Database,
): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(shipSettings)
      .where(eq(shipSettings.id, SHIP_SETTINGS_ID))
  ).at(0)
  return row?.defaultModel ?? null
}

/**
 * Set (or clear, with `null`) the ship-wide default-model override. An
 * upsert on the one well-known row id, so repeat calls converge rather than
 * accumulate — same idempotent-singleton shape as `registerExtension`.
 */
export async function setShipDefaultModel(
  db: Database,
  model: string | null,
): Promise<void> {
  if (model !== null && model.trim().length === 0) {
    throw new Error('ship default model override must not be empty')
  }
  await db
    .insert(shipSettings)
    .values({ id: SHIP_SETTINGS_ID, defaultModel: model })
    .onConflictDoUpdate({
      target: shipSettings.id,
      set: { defaultModel: model },
    })
}

/**
 * What a fresh session should actually boot on: the ship's override if the
 * Config room (or the Models page) has set one, else the caller's own
 * fallback — in practice `DEFAULT_MODEL` (the env-resolved constant read once
 * at boot). Callers pass their fallback explicitly rather than this module
 * importing `runtime.ts` itself, so agent/runtime → agent/settings stays a
 * one-way edge (runtime already depends on models.ts; settings.ts must not
 * depend back on runtime.ts).
 */
export async function resolveDefaultModel(
  db: Database,
  fallback: string,
): Promise<string> {
  return (await getShipDefaultModel(db)) ?? fallback
}
