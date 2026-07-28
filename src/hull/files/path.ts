/**
 * What a shared document may be CALLED — the pure, node-free half of the files
 * contract, split out of `service.ts` for exactly the reason `topic.ts` was: the
 * BROWSER needs it. The rigging's `files` widget validates a pinned path when it
 * parses its props, so an agent that writes `../../etc/passwd` is refused at the
 * raise instead of getting a tile that shrugs. `service.ts` reaches the ship's
 * log (and through it the database), so a view can't import it; the rule lives
 * here and `service.ts` re-exports the throwing form its doors use.
 *
 * One rule, one place. A second copy in the widget would be two path policies
 * that agree until they don't — and this is the one policy where "until they
 * don't" means a path the files service would have refused.
 */

/**
 * Is this a valid shared-file path? Relative, no traversal, no empty segments,
 * no `:` (it would break the `file:<path>` topic grammar), no control
 * characters. **Total**: every input answers, nothing throws.
 */
export function isValidFilePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) return false
  // eslint-disable-next-line no-control-regex
  if (/[:\u0000-\u001f]/.test(path)) return false
  return !path.split('/').some((s) => s === '' || s === '.' || s === '..')
}

/**
 * The path unchanged when valid, else the refusal every write door throws — the
 * service stores exactly what the crew named.
 */
export function validateFilePath(path: string): string {
  if (!isValidFilePath(path)) throw new Error(`Invalid file path: "${path}"`)
  return path
}
