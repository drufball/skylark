import { systemDb } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'
import { getUserByHandle } from '@hull/users/service'

import { setPassword } from './service'

// The default door onto the auth service: a password-reset escape hatch. This
// is what you run from the server itself (already-trusted shell access) when
// you're locked out — there's no email/forgot-password flow, on purpose, for
// a two-person home server. Runs on systemDb (see eslint.config.js's
// allowlist) since it needs to write credentials directly, no session in play.
//   node --env-file=.env --import tsx src/hull/auth/cli.ts reset-password <handle> <password>
// (or `npm run auth -- reset-password <handle> <password>`).

async function cmdResetPassword(
  handle: string,
  password: string,
): Promise<void> {
  const user = await getUserByHandle(systemDb, handle)
  if (!user) {
    process.stdout.write(`No such user @${handle}.\n`)
    process.exitCode = 1
    return
  }
  await setPassword(systemDb, user.id, password)
  process.stdout.write(`Password set for @${handle}.\n`)
}

async function main(): Promise<void> {
  const [command, handle, password] = process.argv.slice(2)
  if (command === 'reset-password' && handle && password) {
    return cmdResetPassword(handle, password)
  }
  process.stdout.write(
    'usage: auth reset-password <handle> <password>\n' +
      "  reset-password   set (or overwrite) a user's password directly\n",
  )
  process.exitCode = command ? 1 : 0
}

if (isMain(import.meta.url)) runCli(main)
