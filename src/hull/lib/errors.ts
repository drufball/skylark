/**
 * Turn an unknown thrown value into a readable string. Drivers and SDKs don't
 * always reject with an Error, so this is the one place that knows how to render
 * whatever came back — importable downward by every deck.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
