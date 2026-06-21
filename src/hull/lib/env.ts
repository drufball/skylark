// Shared environment-flag names. The canonical home so the agent-fake and the
// database isolation can't desync on the literal — both read the SAME constant.

/**
 * Smoke/test mode. When set, the server swaps the live agent for a deterministic
 * fake (no model calls) AND the db resolver forces the `skylark_smoke` database
 * (no real data). One switch, both kinds of isolation — see hull/agent/
 * fake-session.ts and hull/db/url.ts.
 */
export const FAKE_RUNTIME_ENV = 'SKYLARK_FAKE_RUNTIME'
