// The one canonical-origin decision behind the tunnel/LAN split (#q6xm):
// Skylark's public-access story is a Cloudflare Tunnel (HTTPS) in front of a
// plain-HTTP dev server also reachable directly on the LAN
// (`http://<local-ip>:3000`). Those are two different origins for the same
// app — a session cookie set at one is invisible at the other, so switching
// between "at home, on the LAN" and "away, through the tunnel" looks exactly
// like a random logout. `canonicalOriginRedirect` is the fix: if the ship
// knows its one public hostname (`SKYLARK_PUBLIC_HOST`, written by
// `scripts/setup-tunnel`), any request that didn't arrive on that hostname
// (and isn't plain local dev) gets redirected there — one canonical origin,
// one cookie jar, always.
//
// Pure and host-agnostic on purpose: the caller (`server.ts`'s
// `canonicalRedirectUrl` door) supplies the ambient inputs (the request's
// Host header, its own env), so the decision itself is unit-tested without a
// running server.

/** Localhost is always exempt — `npm run dev` and the smoke suite hit the app
 * there directly, often with `SKYLARK_PUBLIC_HOST` already set in `.env`;
 * redirecting local dev traffic out to the public hostname would make
 * ordinary local testing impossible. */
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost')
  )
}

/** The `Host` header's hostname, without its port (if any) — `getRequestHost`
 * returns `host[:port]`; IPv6 hosts arrive bracketed (`[::1]:3000`). */
function hostnameOf(host: string): string {
  const bracketed = /^\[(.+)\]/.exec(host)
  if (bracketed) return bracketed[1]
  return host.split(':')[0]
}

/**
 * The absolute URL to redirect to, or null if this request is already on the
 * canonical origin (or there isn't one configured — `SKYLARK_PUBLIC_HOST`
 * unset, e.g. a ship with no public tunnel yet).
 */
export function canonicalOriginRedirect(input: {
  /** The request's `Host` header (`getRequestHost()`), e.g. `192.168.1.5:3000`. */
  host: string | undefined
  /** `SKYLARK_PUBLIC_HOST` — the ship's one public hostname, if configured. */
  publicHost: string | undefined
  /** `pathname + search` of the request being redirected — preserved verbatim. */
  path: string
}): string | null {
  const publicHost = input.publicHost?.trim()
  if (!publicHost) return null
  const host = input.host?.trim()
  if (!host) return null

  const hostname = hostnameOf(host)
  if (hostname === publicHost || isLocalHostname(hostname)) return null

  return `https://${publicHost}${input.path}`
}
