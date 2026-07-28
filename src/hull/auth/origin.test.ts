import { describe, expect, it } from 'vitest'

import { canonicalOriginRedirect } from './origin'

describe('canonicalOriginRedirect', () => {
  it('does nothing when no public host is configured', () => {
    expect(
      canonicalOriginRedirect({
        host: '192.168.1.5:3000',
        publicHost: undefined,
        path: '/chat',
      }),
    ).toBeNull()
  })

  it('does nothing when the request already arrived on the public hostname', () => {
    expect(
      canonicalOriginRedirect({
        host: 'skylark.build',
        publicHost: 'skylark.build',
        path: '/chat',
      }),
    ).toBeNull()
  })

  it('does nothing for a request on the public hostname with an explicit port', () => {
    expect(
      canonicalOriginRedirect({
        host: 'skylark.build:443',
        publicHost: 'skylark.build',
        path: '/chat',
      }),
    ).toBeNull()
  })

  it('does nothing for plain localhost dev traffic', () => {
    expect(
      canonicalOriginRedirect({
        host: 'localhost:3000',
        publicHost: 'skylark.build',
        path: '/chat',
      }),
    ).toBeNull()
  })

  it('does nothing for 127.0.0.1 dev traffic', () => {
    expect(
      canonicalOriginRedirect({
        host: '127.0.0.1:3000',
        publicHost: 'skylark.build',
        path: '/',
      }),
    ).toBeNull()
  })

  it('redirects a LAN address to the public hostname, preserving the path', () => {
    expect(
      canonicalOriginRedirect({
        host: '192.168.1.5:3000',
        publicHost: 'skylark.build',
        path: '/chat?x=1',
      }),
    ).toBe('https://skylark.build/chat?x=1')
  })

  it('redirects a different, unrelated hostname too', () => {
    expect(
      canonicalOriginRedirect({
        host: 'some-old-bookmark.example.com',
        publicHost: 'skylark.build',
        path: '/',
      }),
    ).toBe('https://skylark.build/')
  })

  it('does nothing when the Host header is missing', () => {
    expect(
      canonicalOriginRedirect({
        host: undefined,
        publicHost: 'skylark.build',
        path: '/',
      }),
    ).toBeNull()
  })
})
