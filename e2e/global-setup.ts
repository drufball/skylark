import { execSync } from 'node:child_process'

// Seed the crew before any smoke test runs. currentActor() throws on an
// unseeded ship (and the SSE route + doors refuse the connection), so a known
// crew is the precondition for every authenticated path. `users seed` is
// idempotent and hits the same local Postgres the dev server uses.
export default function globalSetup(): void {
  execSync('npm run users seed', { stdio: 'inherit' })
}
