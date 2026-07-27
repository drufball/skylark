/**
 * The widget vocabulary, injected — how the hull's agent-facing door describes
 * kinds it is not allowed to know.
 *
 * **Hull holds the row; rigging holds the meaning.** A `chat_widgets` row is a
 * `kind` string and an opaque `props` blob; what a kind RENDERS as, and which
 * services it reads, is the rigging registry's business
 * ([`@rigging/widgets`](../../rigging/widgets/zine.md)). That split isn't taste
 * — a registry in the hull would import every service with a widget, and the day
 * `issues` wants one you get `hull/issues → hull/widgets → hull/issues`, a cycle
 * `architecture.test.ts` fails the build over. Rigging may import every hull
 * service freely, so the registry lives there.
 *
 * But `chat_widget` (session-tools.ts) has to TELL an agent which kinds exist and
 * what props each takes, or the tool is unusable. Hull can't import rigging, so
 * the composition root (`src/boot.ts`) hands the vocabulary down at boot and this
 * module holds it. One kind is described in exactly one place — the registry
 * entry — and the tool's description is generated from it, so a kind added there
 * needs no second edit here.
 *
 * A registration seam rather than a constructor argument because the read is
 * LAZY (at tool-call time, long after boot) and there are two callers that boot
 * the orchestrator — the server entry and the web doors — only one of which is
 * the composition root. Threading it through both would give the wrong one a
 * default, and a silently-empty default is the failure this module is loud about.
 */

import type { JsonValue } from './widgets'

/**
 * One kind as the hull knows it: a name, prose an agent reads, and a total
 * validator. No component, no topics — the hull needs none of that; those are
 * the halves that would drag another service in.
 */
export interface WidgetKindSpec {
  /** The `kind` string a row carries. */
  kind: string
  /** One line: what this kind is FOR, as the agent reads it. */
  summary: string
  /** The prop shape, spelled for a model (e.g. `{ text: string }`). */
  propsDoc: string
  /** A minimal blob that parses — the agent copies this and edits it. */
  example: JsonValue
  /** Null when the blob fits this kind, else why it doesn't. Never throws. */
  validate: (props: unknown) => string | null
}

/**
 * Mutable module state on purpose: the catalog is registered once at boot and
 * read on every tool call. Held in an object so a re-registration is one
 * assignment (and so a test can wipe it).
 */
const catalog: { specs: WidgetKindSpec[] } = { specs: [] }

/**
 * Teach this process the widget kinds it can raise. Called once from
 * `src/boot.ts` with the rigging registry's own entries; replaces whatever was
 * there, so a reload can't stack duplicates.
 */
export function registerWidgetKinds(specs: WidgetKindSpec[]): void {
  catalog.specs = specs
}

/** The kinds registered in this process — empty until boot registers them. */
export function knownWidgetKinds(): WidgetKindSpec[] {
  return catalog.specs
}

/** The one line an unregistered catalog says, in the description and the refusal. */
const NOTHING_REGISTERED =
  'this ship has no widget kinds registered, so nothing can be raised'

/**
 * The kinds and their prop shapes, as prose for the `chat_widget` tool's
 * description. Generated, never hand-written: a kind lands in the rigging
 * registry and shows up here on the next boot with nothing else to edit.
 *
 * The example is rendered as JSON because JSON is what the agent actually has to
 * write into `props` — a prose shape alone leaves it guessing at nesting.
 */
export function describeWidgetKinds(specs: WidgetKindSpec[]): string {
  if (specs.length === 0) return NOTHING_REGISTERED
  const lines = specs.map(
    (spec) =>
      `- ${spec.kind} — ${spec.summary}\n` +
      `  props: ${spec.propsDoc}\n` +
      `  example: ${JSON.stringify(spec.example)}`,
  )
  return `The widget kinds this ship can render, and the props each takes:\n${lines.join('\n')}`
}

/**
 * Is this `kind` + `props` pair something the ship can render? Null when yes,
 * otherwise the reason — which the tool throws back at the agent so it can fix
 * the blob on the spot. That immediate loop is why the agent's door validates at
 * all while the CLI's doesn't: an agent can correct itself mid-turn, whereas the
 * CLI's whole job includes storing a deliberately bad blob to SEE the honest
 * tile it renders as.
 */
export function validateWidgetProps(
  specs: WidgetKindSpec[],
  kind: string,
  props: unknown,
): string | null {
  if (specs.length === 0) return NOTHING_REGISTERED
  const spec = specs.find((s) => s.kind === kind)
  if (!spec) {
    const known = specs.map((s) => s.kind).join(', ')
    return `this ship doesn’t know a “${kind}” widget — it knows: ${known}`
  }
  const fault = spec.validate(props)
  return fault === null ? null : `these props don’t fit “${kind}”: ${fault}`
}
