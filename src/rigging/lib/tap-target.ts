/**
 * The tap-target floor a thumb needs — 2.75rem is 44px.
 *
 * It started life in `widgets/kind.ts`, next to the one surface that cared about
 * it. It doesn't live there any more because it isn't a widget fact: the
 * composer's Send button, the sidebar's only way back to the list on a phone and
 * the chat header's controls all reach for the same floor, and importing a
 * WIDGET module to spell a design token was the sort of dependency that reads as
 * a mistake a year later. A token belongs in `lib`, beside the other things
 * every deck-mate may use (`cn`, `ISSUE_STATUS_META`).
 */
export const TAP_TARGET = 'min-h-11'
