import { Check } from 'lucide-react'

import { Button } from '@rigging/components/ui/button'
import { cn } from '@rigging/lib/utils'

import {
  asRecord,
  isFilledString,
  TAP_TARGET,
  type WidgetKind,
  type WidgetParse,
} from './kind'

/**
 * `choice` — one question, a fixed set of answers. Yes/no is `options: ['Yes','No']`.
 *
 * The kind the whole feature was built around: an agent needs a decision, the
 * crew taps one button on a phone, and the answer arrives as an ordinary chat
 * message. Zero service coupling and no live data — its topics are `[]` — so it
 * proves the catalog shape doesn't need a service to be useful.
 */
export const choiceKind: WidgetKind = {
  summary:
    'A question with a fixed set of answers, shown as tappable buttons. The crew taps one and it arrives as an ordinary chat message. Prefer this over typing a question when you already know the possible answers — it is one tap on a phone instead of a sentence.',
  propsDoc:
    '{ question: string, options: string[] } — options must be a non-empty list of non-empty strings',
  example: { question: 'Ship the new theme?', options: ['Yes', 'No'] },
  parse: (props): WidgetParse => {
    const record = asRecord(props)
    if (!record) return { ok: false, detail: 'expected an object of props' }
    if (!isFilledString(record.question))
      return { ok: false, detail: 'question must be a non-empty string' }
    const { options } = record
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every(isFilledString)
    ) {
      return {
        ok: false,
        detail: 'options must be a non-empty array of non-empty strings',
      }
    }
    return {
      ok: true,
      view: {
        headline: record.question,
        topics: [],
        Body: ({ onAnswer, spent, answer }) =>
          answer === null ? (
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              {options.map((option) => (
                <Button
                  key={option}
                  variant="outline"
                  disabled={spent}
                  onClick={() => {
                    onAnswer(option)
                  }}
                  className={cn('flex-1 basis-32', TAP_TARGET)}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : (
            /* Answered, and still on screen — so this is a canvas or a home
               tile, where the decision IS the state.
               The options stay laid out exactly as they were, with the chosen
               one marked and the rest struck through: "Yes" on its own doesn't
               say what it beat, and prose about it ("not Not yet") reads like a
               riddle. Same shapes, same order, one of them now settled. */
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              {options.map((option) => (
                <span
                  key={option}
                  className={cn(
                    'flex flex-1 basis-32 items-center justify-center gap-1',
                    'rounded-md border px-3 text-sm',
                    TAP_TARGET,
                    option === answer
                      ? 'border-primary font-medium'
                      : 'text-muted-foreground line-through',
                  )}
                >
                  {option === answer && (
                    <Check
                      className="size-4 shrink-0 text-primary"
                      aria-hidden
                    />
                  )}
                  {option}
                </span>
              ))}
            </div>
          ),
      },
    }
  },
}
