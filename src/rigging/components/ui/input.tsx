import * as React from 'react'

import { cn } from '@rigging/lib/utils'

// Shared focus ring style - consistent across all form inputs
const FOCUS_RING =
  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn(inputClass(className))} {...props} />
}

/**
 * The shared class string for text inputs.
 * Use this for hand-rolled inputs that need the same styling.
 */
function inputClass(extra?: string) {
  return cn(
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
    FOCUS_RING,
    extra,
  )
}

/**
 * The shared class string for select elements.
 * Use this for consistency with other form inputs.
 */
function selectClass(extra?: string) {
  return cn(
    'rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30',
    FOCUS_RING,
    extra,
  )
}

export { Input, inputClass, selectClass }
