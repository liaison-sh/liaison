// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ENTITY A THREAD BELONGS TO. A task's comments, a contact's discussion:
// a thread created FROM an entity (`threads.created_from`) is that entity's
// conversation, hidden from the thread list, and is read where the entity is.
// A notification about a message in it, or a page that opens the thread
// directly, names the entity and opens on it, never as a bare conversation
// between its participants.
//
// One shape for every surface: the server builds it (the push, the desktop
// notification, the in-app inbox row, the thread detail), the clients read it
// back with `parseThreadAnchor` and word it with `threadAnchorTitle`.

/** The entity a thread was created from, with what a notification says about it. */
export interface ThreadAnchor {
  app: string
  entityType: string
  entityId: string
  /** The entity kind as its app's manifest names it ("Task"); the fallback for a kind with no translation. */
  kindLabel: string
  /** The entity's own name (a task's title). Null when the reader may not see it. */
  label: string | null
  /** The fact that tells two entities of the same name apart (a task's project). */
  secondaryLabel: string | null
  /**
   * `gone`: the entity's app is switched off (or removed) in the organization, so the
   * conversation keeps its name but cannot open it. Absent while the entity can be opened.
   */
  state?: "gone"
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/
const ID = /^[A-Za-z0-9_.:@~+=,-]{1,128}$/

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/** The anchor carried on a row or a response, or null when it is not one. */
export function parseThreadAnchor(value: unknown): ThreadAnchor | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.app !== "string" || !NAME.test(v.app)) return null
  if (typeof v.entityType !== "string" || !NAME.test(v.entityType)) return null
  if (typeof v.entityId !== "string" || !ID.test(v.entityId) || v.entityId.includes("..")) {
    return null
  }
  return {
    app: v.app,
    entityType: v.entityType,
    entityId: v.entityId,
    kindLabel: optionalText(v.kindLabel) ?? v.entityType,
    label: optionalText(v.label),
    secondaryLabel: optionalText(v.secondaryLabel),
    ...(v.state === "gone" ? { state: "gone" as const } : {}),
  }
}

type Translate = (key: string, params?: Record<string, string>) => string

/** The i18n key of an entity kind's name (`kernel.threadAnchor.kind.<app>.<entityType>`). */
export function threadAnchorKindKey(anchor: Pick<ThreadAnchor, "app" | "entityType">): string {
  return `kernel.threadAnchor.kind.${anchor.app}.${anchor.entityType}`
}

/** The entity kind in the reader's language, else its manifest name. */
export function threadAnchorKind(anchor: ThreadAnchor, t: Translate): string {
  const key = threadAnchorKindKey(anchor)
  const word = t(key)
  return word && word !== key ? word : anchor.kindLabel
}

/**
 * "Task: Fix the login page · Website": the kind, the entity's name and the
 * fact that tells it apart. A reader who may not see the entity gets the kind
 * alone.
 */
export function threadAnchorTitle(anchor: ThreadAnchor, t: Translate): string {
  const kind = threadAnchorKind(anchor, t)
  if (!anchor.label) return kind
  const head = `${kind}: ${anchor.label}`
  return anchor.secondaryLabel ? `${head} · ${anchor.secondaryLabel}` : head
}

/** `attention/<app>/<entityType>/<id>`: the route that opens the entity. */
export function threadAnchorRoute(
  anchor: Pick<ThreadAnchor, "app" | "entityType" | "entityId">,
): string {
  return `attention/${anchor.app}/${anchor.entityType}/${encodeURIComponent(anchor.entityId)}`
}

/**
 * The entity's route with the message to bring into view in its discussion:
 * `attention/<app>/<entityType>/<id>?thread=<threadId>&message=<messageId>`.
 */
export function threadAnchorMessageRoute(
  anchor: Pick<ThreadAnchor, "app" | "entityType" | "entityId">,
  threadId: string,
  messageId: string,
): string {
  return `${threadAnchorRoute(anchor)}?thread=${encodeURIComponent(threadId)}&message=${encodeURIComponent(messageId)}`
}
