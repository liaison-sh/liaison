// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a client action may point at. An app declares its targets in its manifest
// (`clientActionTargets: [{ type, kinds, viewTool }]`); a target no app declared
// is refused. The kernel never reads an app's tables: it asks the app's own
// internal read tool, with system origin, for what the person outside is shown
// and the hash of exactly that.

import { withPrivilegedDb } from "~/db/privileged"
import type { CLIENT_ACTION_KINDS } from "~/db/schema/kernel/client-actions"
import { rootLogger } from "~/lib/logger"
import { appBridgeManifest } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { storedFileSha256 } from "./document-files"

export type ClientActionKind = (typeof CLIENT_ACTION_KINDS)[number]

const log = rootLogger.child({ module: "client-actions" })

/** How long the app's read tool may take before the page answers `down`. */
export const VIEW_TOOL_BUDGET_MS = 5_000

export interface ClientActionTarget {
  app: string
  type: string
  kinds: ClientActionKind[]
  viewTool: string
  /** "app": only the declaring app's own send makes links to it, never the generic tool. */
  mintedBy: "app" | "any"
}

/** What the app's read tool returns for one target. */
export interface ClientActionView {
  title: string
  /** Shown as "<name> at <org>": the person who sent it. */
  senderName: string | null
  summary: Array<{ k: string; v: string }>
  /** The frozen source the person reads, when the target has one. */
  sourceBlocks: unknown[] | null
  /** Plain text of the document, when the target has one. */
  text: string | null
  pdfFileId: string | null
  /**
   * The server-made picture of each page of an uploaded file, made once at freeze
   * (never rebuilt for an open action), with its hash and its text.
   */
  pages: Array<{ n: number; pictureFileId: string; sha256: string; text: string | null }> | null
  /** Hex SHA-256 over the pages' hashes in order: what the trail records as shown. */
  pagesSha256: string | null
  /** Hex SHA-256 of exactly what is shown: checked again when the person decides. */
  sha256: string
  wordsKey: string | null
  wordsParams: Record<string, string>
  /**
   * Where each signer's copy of a signed target stands, by client action id
   * (`waiting_for_others`, `on_its_way`, `sent`, `not_sent`); only the holder's
   * own entry is ever shown. Empty when the target has no copies.
   */
  copyStates: Record<string, CopyState>
  /**
   * The per-document portal share a send of this target opens for a portal client
   * of its company (`agreement` or `change_request`), as the app names it; absent
   * when the target opens none.
   */
  portalShareKind?: PortalShareKindOfTarget | null
}

export const TARGET_PORTAL_SHARE_KINDS = ["agreement", "change_request"] as const
export type PortalShareKindOfTarget = (typeof TARGET_PORTAL_SHARE_KINDS)[number]

export const COPY_STATES = ["waiting_for_others", "on_its_way", "sent", "not_sent"] as const
export type CopyState = (typeof COPY_STATES)[number]

export interface ViewRequest {
  orgId: string
  targetApp: string
  targetType: string
  targetId: string
  /** Whose permissions the read runs with: the person who sent the action. */
  actingUserId: string | null
}

type ViewFn = (req: ViewRequest, signal: AbortSignal) => Promise<ClientActionView | null>

const testTargets = new Map<
  string,
  { kinds: ClientActionKind[]; view: ViewFn; mintedBy: "app" | "any" }
>()

const key = (app: string, type: string) => `${app}\u0000${type}`

/**
 * Tests only: declare a target as an app's manifest would, with the view the
 * app's tool would return. Production targets come from manifests alone.
 */
export const ClientActionTargetsTestAccess = {
  set(
    app: string,
    type: string,
    kinds: ClientActionKind[],
    view: ViewFn,
    mintedBy: "app" | "any" = "any",
  ): void {
    if (process.env.NODE_ENV !== "test") throw new Error("test targets are for tests only")
    testTargets.set(key(app, type), { kinds, view, mintedBy })
  },
  clear(app: string, type: string): void {
    testTargets.delete(key(app, type))
  },
}

/** The declared target, or null when no app of this org declares it. */
export function declaredTarget(
  orgId: string,
  app: string,
  type: string,
): ClientActionTarget | null {
  const t = testTargets.get(key(app, type))
  if (t) return { app, type, kinds: t.kinds, viewTool: "__test__", mintedBy: t.mintedBy }
  const decl = appBridgeManifest(orgId, app)?.clientActionTargets?.find((d) => d.type === type)
  if (!decl) return null
  return {
    app,
    type,
    kinds: decl.kinds.filter((k): k is ClientActionKind =>
      ["sign", "accept", "approve"].includes(k),
    ),
    viewTool: decl.viewTool,
    mintedBy: decl.mintedBy === "app" ? "app" : "any",
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asView(data: unknown): ClientActionView | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  const sha = typeof d.sha256 === "string" ? d.sha256 : null
  if (!sha || !HEX64.test(sha) || typeof d.title !== "string") return null
  const sender = d.sender as { name?: unknown } | undefined
  return {
    title: d.title,
    senderName: typeof sender?.name === "string" ? sender.name : null,
    summary: Array.isArray(d.summary)
      ? d.summary
          .filter(
            (r): r is { k: string; v: string } =>
              !!r && typeof r.k === "string" && typeof r.v === "string",
          )
          .map((r) => ({ k: r.k, v: r.v }))
      : [],
    sourceBlocks: Array.isArray(d.source_blocks) ? d.source_blocks : null,
    text: typeof d.text === "string" ? d.text : null,
    pdfFileId: typeof d.pdf_file_id === "string" ? d.pdf_file_id : null,
    pages: Array.isArray(d.pages)
      ? d.pages
          .filter(
            (p): p is { n: number; picture_file_id: string; sha256: string; text?: unknown } =>
              !!p &&
              Number.isInteger(p.n) &&
              typeof p.picture_file_id === "string" &&
              typeof p.sha256 === "string" &&
              HEX64.test(p.sha256),
          )
          .map((p) => ({
            n: p.n,
            pictureFileId: p.picture_file_id,
            sha256: p.sha256,
            text: typeof p.text === "string" ? p.text : null,
          }))
      : null,
    pagesSha256:
      typeof d.pages_sha256 === "string" && HEX64.test(d.pages_sha256) ? d.pages_sha256 : null,
    sha256: sha,
    wordsKey: typeof d.words_key === "string" ? d.words_key : null,
    wordsParams:
      d.words_params && typeof d.words_params === "object"
        ? Object.fromEntries(
            Object.entries(d.words_params as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : {},
    portalShareKind: (TARGET_PORTAL_SHARE_KINDS as readonly unknown[]).includes(d.portal_share_kind)
      ? (d.portal_share_kind as PortalShareKindOfTarget)
      : null,
    copyStates:
      d.copies && typeof d.copies === "object" && !Array.isArray(d.copies)
        ? Object.fromEntries(
            Object.entries(d.copies as Record<string, unknown>).filter(
              (e): e is [string, CopyState] =>
                typeof e[1] === "string" && (COPY_STATES as readonly string[]).includes(e[1]),
            ),
          )
        : {},
  }
}

async function viewThroughTool(
  target: ClientActionTarget,
  req: ViewRequest,
  signal: AbortSignal,
): Promise<ClientActionView | null> {
  if (!req.actingUserId) return null
  const userId = req.actingUserId
  const perms = await withPrivilegedDb(req.orgId, "client-action-view-perms", (tx) =>
    loadEffectivePermissions(tx, userId, req.orgId),
  )
  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const answer = await executeToolCore({
    toolName: `${target.app}:${target.viewTool}`,
    orgId: req.orgId,
    actor: {
      actorType: "user",
      userId,
      orgId: req.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    params: { targetType: req.targetType, targetId: req.targetId },
    origin: "system",
    signal,
  })
  if (!("data" in answer)) return null
  return asView(await withStoredFileHash(req.orgId, answer.data))
}

/**
 * A view that names its stored file (`pdf_file_id`) without a hash gets the file's SHA-256 from
 * the kernel: the app shows the file, the kernel fingerprints its bytes. A view with its own
 * hash is left as it is.
 */
export async function withStoredFileHash(orgId: string, data: unknown): Promise<unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data
  const d = data as Record<string, unknown>
  if (d.sha256 !== undefined && d.sha256 !== null) return data
  if (typeof d.pdf_file_id !== "string" || !UUID.test(d.pdf_file_id)) return data
  const sha = await storedFileSha256(orgId, d.pdf_file_id)
  return sha ? { ...d, sha256: sha } : data
}

/**
 * The target as the person outside sees it, or `down` when the app's tool
 * failed, refused or took longer than VIEW_TOOL_BUDGET_MS. Never throws.
 */
export async function viewTarget(
  req: ViewRequest,
  budgetMs: number = VIEW_TOOL_BUDGET_MS,
): Promise<ClientActionView | "down"> {
  const target = declaredTarget(req.orgId, req.targetApp, req.targetType)
  if (!target) return "down"
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"down">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("down")
    }, budgetMs)
  })
  const test = testTargets.get(key(req.targetApp, req.targetType))
  const asked = (
    test ? test.view(req, controller.signal) : viewThroughTool(target, req, controller.signal)
  ).then(
    (v) => v ?? ("down" as const),
    (err) => {
      log.warn({ err, app: req.targetApp, type: req.targetType }, "client action view failed")
      return "down" as const
    },
  )
  try {
    return await Promise.race([asked, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
