import { screen } from '@testing-library/react'

/**
 * Class tokens of the nearest `selector` ancestor of the node holding `text`.
 *
 * Split on whitespace so callers can assert a *standalone* class — `bg-accent`
 * (the active-selection accent) must not match `hover:bg-accent` (the always-on
 * hover style). A substring check would silently pass for inactive rows; this
 * is the foot-gun the split exists to dodge, kept in one home so it can't rot.
 *
 * `selector` defaults to `'*'`, so `closest('*')` returns the text node's own
 * element when the class lives directly on it; pass `'button'` / `'a'` when the
 * styled element is an ancestor.
 */
export const classTokensOf = (text: string, selector = '*'): string[] =>
  screen.getByText(text).closest(selector)?.className.split(/\s+/) ?? []
