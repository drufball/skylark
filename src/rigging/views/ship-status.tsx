import { Anchor } from 'lucide-react'

import type { ShipHealth } from '@hull/health/service'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@rigging/components/ui/card'

// A plain presentational view. It lives in rigging, takes its data as props,
// and is wired to a URL by a thin mount in src/routes. It could just as well be
// rendered by a route defined in home — that's the point of decoupling views
// from the serving layer.
export function ShipStatus({ health }: { health: ShipHealth }) {
  const up = health.db === 'up'

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Anchor className="size-5 text-muted-foreground" />
            <CardTitle className="text-2xl">Skylark</CardTitle>
          </div>
          <CardDescription>
            The ship is afloat. An operating system for personal software.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            hull · rigging · home — three decks, one ship.
          </p>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                up ? 'bg-emerald-500' : 'bg-destructive',
              )}
              aria-hidden
            />
            <span className="text-muted-foreground">
              database:{' '}
              <span className="font-medium text-foreground">{health.db}</span>
            </span>
          </div>
          {!up && (
            <p className="text-sm text-muted-foreground">
              The ship is asleep — try <code>npm run db:up</code>.
            </p>
          )}
          <Button className="w-fit">Hoist the sails ☀️🏴‍☠️</Button>
        </CardContent>
      </Card>
    </main>
  )
}
