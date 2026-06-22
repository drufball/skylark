import { DIM, isMain, RESET, runCli } from '@hull/lib/cli'

import { LOCAL_MODEL_CATALOG } from './catalog'
import { detectHardware, selectModel } from './service'

// The default door onto the local-model service: detect the machine's hardware
// and report the model Skylark would auto-select for it. The Ollama bring-up
// (hoist) calls `select` to learn what to pull. Needs no database or env —
// it only reads the OS:
//   node --import tsx src/hull/local-model/cli.ts <detect|select|catalog>
// (or `npm run local-model -- <command>`).

async function cmdDetect(): Promise<void> {
  const hw = await detectHardware()
  process.stdout.write(
    `${hw.platform}/${hw.arch}  ${String(hw.totalMemGB)}GB RAM` +
      (hw.isUnifiedMemory ? ' (unified)' : '') +
      (hw.vramGB ? `  ${String(hw.vramGB)}GB VRAM` : '') +
      `  ${String(hw.cpuCount)} CPUs\n`,
  )
}

async function cmdSelect(args: string[]): Promise<void> {
  const hw = await detectHardware()
  const sel = selectModel(hw)
  // `--ref` prints just the provider-prefixed model ref, for scripts to capture.
  if (args.includes('--ref')) {
    process.stdout.write(`${sel.modelRef}\n`)
    return
  }
  // `--quiet` prints just the bare Ollama tag, for `ollama pull` in hoist.
  if (args.includes('--quiet')) {
    process.stdout.write(`${sel.model}\n`)
    return
  }
  process.stdout.write(`${sel.modelRef}\n${DIM}${sel.reason}${RESET}\n`)
}

function cmdCatalog(): void {
  for (const spec of LOCAL_MODEL_CATALOG) {
    process.stdout.write(
      `${spec.model}  ${DIM}≥${String(spec.minMemGB)}GB · ${spec.label} — ${spec.notes}${RESET}\n`,
    )
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'detect':
      return cmdDetect()
    case 'select':
      return cmdSelect(args)
    case 'catalog':
      cmdCatalog()
      return
    default:
      process.stdout.write(
        'usage: local-model <detect|select|catalog>\n' +
          '  detect              print this machine’s hardware\n' +
          '  select [--ref|--quiet]  print the auto-selected model (ref / bare tag)\n' +
          '  catalog             list the local model catalog\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

/* v8 ignore start -- CLI entrypoint wiring */
if (isMain(import.meta.url)) runCli(main)
/* v8 ignore stop */
