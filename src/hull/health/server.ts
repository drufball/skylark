import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'

import { shipHealth } from './service'

/**
 * The server door onto shipHealth. Always runs on the server; called from
 * routes like a local function, with the result fully typed across the wire.
 */
export const getShipHealth = createServerFn({ method: 'GET' }).handler(() =>
  shipHealth(db),
)
