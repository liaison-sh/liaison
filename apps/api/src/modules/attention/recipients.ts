// SPDX-License-Identifier: FSL-1.1-ALv2
export type RecipientSpec =
  | { kind: "field"; path: string }
  | { kind: "participants"; path: string }
  | { kind: "mentions"; path: string }
  | { kind: "actor" }
  | { kind: "scope_holders"; scope: string; dimensionFilter?: Record<string, unknown> }

export interface RecipientContext {
  orgId: string
  loadScopeHolders?: (
    orgId: string,
    scope: string,
    dimensionFilter?: Record<string, unknown>,
  ) => Promise<string[]>
  /**
   * Phase 16 Task A2 — per-user attention-subscription narrowing applied
   * *after* the producer-side recipient resolver. Returns `false` to drop a
   * candidate. When undefined, no narrowing happens (back-compat). The
   * translator builds this closure from the event's `(source, kind, axes)`.
   */
  applySubscriptionFilter?: (userId: string) => Promise<boolean>
}

interface EventLike {
  actorId?: string | null
  data?: unknown
}

function readPath(payload: unknown, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = payload
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const MENTION_REF_RE = /data-mention-ref=["']user:([^"']+)["']/g
const MENTION_MARKDOWN_RE = /@\[[^\]]+\]\(user:([^)\s]+)\)/g

export function extractMentionUserIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter(
        (m): m is { type: string; id: string } =>
          !!m &&
          typeof m === "object" &&
          (m as any).type === "user" &&
          typeof (m as any).id === "string",
      )
      .map((m) => m.id)
  }
  if (typeof value !== "string") return []
  const ids: string[] = []
  for (const re of [MENTION_REF_RE, MENTION_MARKDOWN_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(value)) !== null) {
      ids.push(m[1])
    }
  }
  return ids
}

function dedupe(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
}

export async function resolveRecipients(
  spec: RecipientSpec,
  event: EventLike,
  ctx: RecipientContext,
): Promise<string[]> {
  let initial: string[]
  switch (spec.kind) {
    case "field": {
      const v = readPath(event, spec.path)
      initial = dedupe([typeof v === "string" ? v : undefined])
      break
    }
    case "participants": {
      const v = readPath(event, spec.path)
      initial = dedupe(Array.isArray(v) ? (v as string[]) : [])
      break
    }
    case "mentions": {
      const v = readPath(event, spec.path)
      initial = dedupe(extractMentionUserIds(v))
      break
    }
    case "actor":
      initial = dedupe([event.actorId ?? undefined])
      break
    case "scope_holders": {
      if (!ctx.loadScopeHolders) return []
      const ids = await ctx.loadScopeHolders(ctx.orgId, spec.scope, spec.dimensionFilter)
      initial = dedupe(ids)
      break
    }
    default:
      return []
  }
  if (!ctx.applySubscriptionFilter || initial.length === 0) return initial
  const allowed: string[] = []
  for (const id of initial) {
    if (await ctx.applySubscriptionFilter(id)) allowed.push(id)
  }
  return allowed
}
