#!/usr/bin/env node
// Filter a newline-separated list of changed files (stdin) down to what
// Stryker should mutate. Derived from test-excludes.mjs — the same single
// source of truth the full sweep (stryker.config.mjs) and the coverage gate
// (vitest.config.ts) use — so the diff gate can't drift from them. Used by
// scripts/mutate-diff.
import picomatch from 'picomatch'

import {
  MUTATE_SOURCES,
  SHARED_EXCLUDES,
  STRYKER_ONLY_EXCLUDES,
} from '../test-excludes.mjs'

const isSource = picomatch(MUTATE_SOURCES)
const isExcluded = picomatch([...SHARED_EXCLUDES, ...STRYKER_ONLY_EXCLUDES])

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

for (const line of input.split('\n')) {
  const file = line.trim()
  if (file && isSource(file) && !isExcluded(file)) console.log(file)
}
