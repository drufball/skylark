import { pathToFileURL } from 'node:url'
import { errorMessage } from './errors'

// The shared ANSI palette every CLI door dims its secondary text with. One home
// so the escape codes can't drift (and a re-theme touches one line, not four).
export const DIM = '\x1b[2m'
export const CYAN = '\x1b[36m'
export const RESET = '\x1b[0m'

/**
 * True when this module is the process entrypoint (not imported by a test).
 * Uses the idiomatic resolved-path comparison.
 */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1]
  return entry ? metaUrl === pathToFileURL(entry).href : false
}

/**
 * Run a CLI's main(), translate exit code + errors.
 * The one place that knows how a door exits.
 */
export function runCli(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`\n${errorMessage(err)}\n`)
      process.exit(1)
    })
}
