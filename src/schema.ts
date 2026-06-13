// The ship's root schema.
//
// drizzle-kit is pointed at every `src/**/schema.ts` (see drizzle.config.ts), so
// each service's tables are discovered automatically — there is no barrel to
// re-export into and nothing to forget. This root file is where any cross-cutting
// tables would live, and it guarantees drizzle-kit always has a schema to read.
// No tables live here yet; resist adding speculative ones.

export {}
