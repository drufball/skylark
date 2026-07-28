import { createFileRoute, redirect } from '@tanstack/react-router'

// `/home` was the home canvas for exactly one slice, and then the home canvas
// became the front door. The route stays as a forward rather than a 404: the
// crew had it in the dock and in their thumbs for a while, and the whole point
// of this slice's care about `/?chat=` is that moving a door must not break the
// links people already have. `?page=` travels, so a bookmarked page still
// opens on that page.

interface LegacyHomeSearch {
  page?: string
}

export const Route = createFileRoute('/home')({
  validateSearch: (search: Record<string, unknown>): LegacyHomeSearch => ({
    page: typeof search.page === 'string' ? search.page : undefined,
  }),
  beforeLoad: ({ search }) => {
    redirect({ to: '/', search: { page: search.page }, throw: true })
  },
})
