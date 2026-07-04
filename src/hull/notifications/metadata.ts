/**
 * Notification metadata emitters can include in their event payloads to control
 * how the generic reactor handles them. All fields are optional — events without
 * metadata work fine, just with no special reactor behavior.
 *
 * Emitters (issues, tasks, etc.) declare this in their payloads under the
 * `_notification` key. The notifications reactor reads it generically.
 */
export interface NotificationMetadata {
  /** Human-readable inbox copy (replaces service-specific describeNotification). */
  headline?: string
  /** Should the actor be auto-subscribed to the topic? (replaces isAutoWatchTopic). */
  autoWatch?: boolean
  /** User IDs to add beyond watchers (replaces ISSUE_OWNER_PING special case). */
  addRecipients?: string[]
  /** User IDs to exclude from watchers (replaces ISSUE_HANDOFF special case). */
  dropRecipients?: string[]
}

/**
 * Extract notification metadata from an event payload. Returns null if the
 * payload isn't an object or doesn't carry metadata.
 */
export function getNotificationMetadata(
  payload: unknown,
): NotificationMetadata | null {
  if (typeof payload !== 'object' || payload === null) return null
  const meta = (payload as { _notification?: unknown })._notification
  if (typeof meta !== 'object' || meta === null) return null
  return meta
}
