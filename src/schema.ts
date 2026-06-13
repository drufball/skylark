// The ship's full schema — assembled here, above the decks.
//
// Each service owns its tables in its own folder (e.g. src/home/garden/schema.ts)
// and re-exports them from here as it comes aboard. This barrel exists so
// drizzle-kit can see every table at once to generate migrations. It lives in
// the serving layer — not the hull — because aggregating tables from home and
// rigging would otherwise force the hull to import upward, breaking the one law
// (home → rigging → hull).
//
// No services have tables yet, so the ship carries none. Resist adding
// speculative tables: a table with no service is a barnacle.

export {}
