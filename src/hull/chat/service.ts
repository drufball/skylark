/**
 * The chat service's public surface, re-exported from its four modules so the
 * many existing call sites keep importing `./service` (they can migrate to the
 * direct modules at leisure):
 *
 * - `messages.ts` — the response rules and chat/member/message persistence
 *   (and the whole-service doc: membership is visibility).
 * - `schedules.ts` — scheduled posts: the timing rules and the firing sweep.
 * - `widgets-store.ts` — the widget rows: raise, list, reorder, dismiss, answer.
 * - `canvas.ts` — canvas pages, placement, and per-viewer page state.
 */

export * from './canvas'
export * from './messages'
export * from './schedules'
export * from './widgets-store'
