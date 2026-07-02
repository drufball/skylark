/**
 * The ship-log topic namespace for shared files — the one piece of the files
 * contract the BROWSER needs (the explorer subscribes to the wildcard; a viewer
 * could subscribe to one file's topic). A node-free leaf, like issues/topic.ts,
 * so routes can import the namespace without dragging server-only code into the
 * client bundle.
 */

/** The prefix every file topic carries. The single source of the namespace. */
export const FILE_TOPIC_PREFIX = 'file:'

/**
 * The ship-log topic one file's change events are published under. File paths
 * never contain `:` (validateFilePath enforces it), so the path can't collide
 * with the topic grammar.
 */
export function fileTopic(path: string): string {
  return `${FILE_TOPIC_PREFIX}${path}`
}

/** The topic pattern matching every file's topic (the explorer subscribes here). */
export const FILE_TOPIC_PATTERN = `${FILE_TOPIC_PREFIX}*`
