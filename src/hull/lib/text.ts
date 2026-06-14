/** Truncate to `max` characters, replacing the tail with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The first line of a string, trimmed. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim()
}
