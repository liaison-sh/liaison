// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Links to a place in THIS deployment, in both directions.
//
// `copyLink` puts the deployment's own address of a route on the clipboard.
// `ownEntityLink` goes the other way: a pasted address that names one entity
// (project, task, thread, ticket) of this server becomes the entity reference
// the editor already stores as a chip (`@[title](app:entity:id)`). Anything
// else (another origin, a page that is not one entity, a sub route) stays an
// ordinary link. An entity chip is a reference, not a person: it never
// notifies anyone.
import { getTabType, matchUrlPattern, patternToUrl, urlToTabInfo } from "~/framework/app-registry"
import { serverAddressOverride } from "~/lib/env"
import { appLink, share } from "~/lib/share"
import { tNow } from "~/modules/i18n/i18n-context"
import { crossProjectTasksStore } from "~/modules/projects/cross-project-tasks-store"
import { projectStore } from "~/modules/projects/project-store"
import { tabStore } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"

/** The route of an entity page itself, without the view or sub route a tab sits on. */
export function entityRoute(tabType: string, entityId: string): string {
  const reg = getTabType(tabType)
  return reg ? patternToUrl(reg.urlPattern, entityId) : "/"
}

/** Puts the deployment's address of `routePath` on the clipboard and says so. */
export async function copyLink(routePath: string): Promise<boolean> {
  const url = appLink(routePath)
  let copied = false
  try {
    await navigator.clipboard.writeText(url)
    copied = true
  } catch {
    // No clipboard here (permissions, an insecure page): the share route below.
    copied = (await share({ url })) === "copied"
  }
  if (copied) addToast({ type: "success", message: tNow("kernel.linkCopied") })
  return copied
}

export interface OwnEntityLink {
  /** `app:entityType:id`, or `thread:<id>` for the kernel's own conversation. */
  ref: string
  /** The entity's title as far as the client already knows it. */
  label: string
}

function ownOrigin(): string | null {
  const override = serverAddressOverride()
  if (override !== null) return new URL(override).origin
  return typeof window === "undefined" ? null : window.location.origin
}

/** The title a store already holds for an entity, if any. */
function knownTitle(tabType: string, entityId: string): string | undefined {
  if (tabType === "projects:project") {
    return projectStore.project(entityId)?.name || undefined
  }
  if (tabType === "projects:task") {
    const summary = crossProjectTasksStore.items().find((task) => task.id === entityId)
    if (summary) return summary.title
    const projectId = projectStore.projectIdForTask(entityId)
    return projectId
      ? projectStore.tasksFor(projectId).find((task) => task.id === entityId)?.title
      : undefined
  }
  return undefined
}

function entityLabel(tabType: string, entityId: string, fallback: string): string {
  const reg = getTabType(tabType)
  const open = tabStore.tabs.find((tab) => tab.type === tabType && tab.entityId === entityId)
  const candidates = [
    knownTitle(tabType, entityId),
    reg?.resolveLabel?.(entityId),
    open?.label && open.label !== reg?.defaultLabel ? open.label : undefined,
  ]
  return candidates.find((c): c is string => typeof c === "string" && c.trim() !== "") ?? fallback
}

/**
 * The entity a pasted `text` names, or null when it is not exactly one address
 * of an entity page of this deployment.
 */
/**
 * The shape an entity id takes (a uuid, a handle). The path pattern's own
 * segment match takes any character but a slash, and the id lands verbatim in
 * the stored `@[label](ref)` token: a `)` in it closed the token early and let
 * the rest of the address write a second, hidden mention.
 */
const ENTITY_ID_RE = /^[A-Za-z0-9_-]+$/

export function ownEntityLink(text: string): OwnEntityLink | null {
  const trimmed = text.trim()
  if (trimmed === "" || /\s/.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.origin !== ownOrigin()) return null

  const info = urlToTabInfo(url.pathname)
  if (!info || !ENTITY_ID_RE.test(info.entityId)) return null
  const reg = getTabType(info.type)
  if (!reg || matchUrlPattern(reg.urlPattern, url.pathname)?.entityId !== info.entityId) {
    return null
  }
  // One entity page and nothing under it: a sub route is a place, not a thing.
  const segments = url.pathname.split("/").filter(Boolean)
  const patternSegments = reg.urlPattern.split("/").filter(Boolean)
  if (segments.length !== patternSegments.length) return null

  if (info.type === "kernel:thread") {
    return {
      ref: `thread:${info.entityId}`,
      label: entityLabel(info.type, info.entityId, "Thread"),
    }
  }
  if (!reg.referenceable || !info.type.includes(":")) return null
  return {
    ref: `${info.type}:${info.entityId}`,
    label: entityLabel(info.type, info.entityId, reg.defaultLabel),
  }
}

/**
 * A pasted address as the text it is inserted as. An address never needs a
 * mention token inside it, but a crafted one can carry `@[Name](user:<id>)`
 * that the server reads as a real mention once sent: its square brackets are
 * percent-encoded (the same address to any server) so no token survives.
 * Anything that is not a single http(s) address is returned unchanged.
 */
export function pastedAddressText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === "" || /\s/.test(trimmed) || !trimmed.includes("@[")) return text
  if (!/^https?:\/\//i.test(trimmed)) return text
  return trimmed.replace(/\[/g, "%5B").replace(/\]/g, "%5D")
}
