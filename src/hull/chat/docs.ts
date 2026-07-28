/**
 * Where ONE chat's own working docs live in the ship's shared files — the
 * subfolder-per-chat convention #wkh8 asked for. A node-free leaf, like
 * `topic.ts` and `memory-paths.ts` (agent's own version of this same idea):
 * pure and derived from the chat id alone, so nothing has to be provisioned —
 * no new column, no migration, no "create the folder" step. The files
 * service has no notion of folders as rows; a folder exists the moment
 * something is written under it, same as any other shared-file path.
 *
 * Deliberately just `chats/<chatId>`, not a prettified slug: a well-known
 * room already carries a readable id (`room-issues`), and an ordinary chat's
 * uuid is at least stable and discoverable (`npm run chat -- show <id>` names
 * the same id back). A generated human slug would need somewhere to be
 * stored to stay stable across a title rename — the exact migration this
 * derivation avoids.
 *
 * This is a naming convention and a shortcut, never a restriction: the
 * `files` widget's `folder`/`path` props still take ANY path, and files
 * itself stays one shared library, one repo, one staging branch, one sweep —
 * see `hull/files/zine.md`. Nothing here silos storage per chat.
 */

/** The shared-files folder a chat's own working docs live under. */
export function chatDocsDir(chatId: string): string {
  return `chats/${chatId}`
}
