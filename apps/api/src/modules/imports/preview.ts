// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import previews and the runs they start, shared by the agent's import tools
 * (modules/agent/tools/import-tools.ts) and the Imports view's routes
 * (modules/imports/routes.ts). A preview is a dry-run row whose hash binds
 * the transform version and its code, what it reads (files, or a connection
 * with its adapter and credentials version) and its counts; starting one
 * re-derives all of it.
 */
import { createHash } from "node:crypto"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import type { ImportRunRow } from "~/db/schema/kernel"
import { wrapExternalContent } from "~/lib/external-content"
import { countMembersByEmail, liveActor } from "~/modules/imports/authority"
import { enqueueImportRun } from "~/modules/imports/job"
import { getImportKind, type ImportKindInfo } from "~/modules/imports/kinds"
import { missingWriteScopes, runImport, transformRunSource } from "~/modules/imports/runner"
import { createImportRun, failRun, getImportRun, mergeRunReport } from "~/modules/imports/runs"
import { resolveImportFile } from "~/modules/imports/source"
import {
  apiConnectionFacts,
  fileRulesSchema,
  loadPinnedTransform,
  loadTransform,
  prepareTransform,
  sha256Of,
  type TransformSource,
  transformInputSchema,
  transformSourceOfRun,
} from "~/modules/imports/transform-run"
import { ImportError } from "~/modules/imports/types"

/** A preview above this share of refused records cannot be started. */
export const PREVIEW_MAX_ERROR_RATE = 0.05
/** A preview older than this is stale: preview again. */
const PREVIEW_TTL_MS = 24 * 3600_000
const PREVIEW_DEFAULT_BATCHES = 5
const PREVIEW_DEFAULT_PAGES = 3
const PREVIEW_MAX_CALLS = 20
const SAMPLES_PER_KIND = 3
export const ERRORS_SHOWN = 20
const STRING_CLIP = 300
const ARRAY_CLIP = 5

/** What the kernel runtime hands an import tool handler (a subset of AppContext). */
export interface ImportActorCtx {
  orgId: string
  userId: string
  /** The person who approved this call; null for a direct call. */
  approverUserId?: string | null
  approvalRequestId?: string
  scopes?: string[]
}

const SOURCE_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Characters of one sample record an approval card shows. */
export const CARD_SAMPLE_CHARS = 300

/** Every value at a dot path, walking through arrays. */
export function valuesAt(value: unknown, segs: string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, segs))
  if (segs.length === 0) return [value]
  if (value === null || typeof value !== "object") return []
  const [head, ...rest] = segs
  return head && head in value ? valuesAt((value as Record<string, unknown>)[head], rest) : []
}

/** A value clipped for a tool result: long strings, long arrays and deep nesting cut. */
export function clipValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > STRING_CLIP
      ? `${value.slice(0, STRING_CLIP)}… (${value.length} chars)`
      : value
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= 5) return "…"
  if (Array.isArray(value)) {
    const head = value.slice(0, ARRAY_CLIP).map((v) => clipValue(v, depth + 1))
    return value.length > ARRAY_CLIP ? [...head, `… and ${value.length - ARRAY_CLIP} more`] : head
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = clipValue(v, depth + 1)
  return out
}

/** The person a call acts as: the approver for an approved call, else the caller (live). */
export async function actingPerson(ctx: ImportActorCtx): Promise<UserContext> {
  const userId = ctx.approverUserId || ctx.userId
  const actor = await liveActor(ctx.orgId, userId)
  if (!actor) throw new ImportError("forbidden", "only an active member can import")
  return actor
}

// ---------------------------------------------------------------------------
// Preview binding
// ---------------------------------------------------------------------------

export interface PreviewFacts {
  transform: { id: string; version: number; sha256: string }
  binding: string
  kinds: string[]
  sourceLabel: string
  placeholders: boolean
  counts: ImportRunRow["counts"]
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * What a run reads, as one string: its input (files, or a connection with
 * its adapter document and credentials version as they are now) and its file
 * rules.
 */
export async function sourceBindingOf(
  orgId: string,
  userId: string,
  source: TransformSource,
): Promise<string> {
  const api =
    source.input.type === "api"
      ? await apiConnectionFacts(orgId, userId, source.input.connection)
      : null
  return canonical({ input: source.input, files: source.files ?? [], ...(api ? { api } : {}) })
}

export function previewHashOf(previewId: string, f: PreviewFacts): string {
  return createHash("sha256")
    .update(canonical({ previewId, ...f, kinds: [...f.kinds].sort() }))
    .digest("hex")
}

export function errorRateOf(counts: ImportRunRow["counts"]): {
  total: number
  failed: number
  rate: number
} {
  let total = 0
  let failed = 0
  for (const c of Object.values(counts)) {
    total += c.created + c.skipped + c.failed
    failed += c.failed
  }
  return { total, failed, rate: total === 0 ? 0 : failed / total }
}

export interface LoadedPreview {
  run: ImportRunRow
  source: TransformSource
  facts: PreviewFacts
  hash: string
  rate: number
}

/**
 * A preview the requester made, still fresh, re-derived from its row and the
 * transform version it pinned (whose code must still hash the same).
 */
export async function loadPreview(
  orgId: string,
  previewId: string,
  userId: string,
): Promise<LoadedPreview> {
  if (!z.string().uuid().safeParse(previewId).success) {
    throw new ImportError("not_found", "No such preview.")
  }
  const run = await getImportRun(orgId, previewId)
  if (!run?.dryRun) throw new ImportError("not_found", "No such preview.")
  if (run.startedBy !== userId) {
    throw new ImportError("forbidden", "A preview is started by the person who made it.")
  }
  if (run.status !== "done") {
    throw new ImportError("invalid_request", `The preview is ${run.status}; preview again.`)
  }
  if (Date.now() - run.createdAt.getTime() > PREVIEW_TTL_MS) {
    throw new ImportError("invalid_request", "The preview is more than a day old; preview again.")
  }
  const source = transformSourceOfRun(run.source)
  if (!source || "inline" in source.transform) {
    throw new ImportError("invalid_request", "This preview did not run a saved transform.")
  }
  const row = await loadPinnedTransform(orgId, source.transform)
  const sha256 = sha256Of(row.source)
  if (source.transform.sha256 && source.transform.sha256 !== sha256) {
    throw new ImportError("invalid_request", "The transform's code changed since the preview.")
  }
  const facts: PreviewFacts = {
    transform: { id: row.id, version: row.version, sha256 },
    binding: await sourceBindingOf(orgId, userId, source),
    kinds: run.kindSet,
    sourceLabel: run.sourceLabel,
    placeholders: run.placeholders,
    counts: run.counts,
  }
  const hash = previewHashOf(run.id, facts)
  const stored = (run.report.preview as { hash?: unknown } | undefined)?.hash
  if (stored !== hash) {
    throw new ImportError(
      "invalid_request",
      "The preview no longer matches its record; preview again.",
    )
  }
  return { run, source, facts, hash, rate: errorRateOf(run.counts).rate }
}

export function tooManyErrors(rate: number): string | null {
  return rate > PREVIEW_MAX_ERROR_RATE
    ? `The preview refused ${(rate * 100).toFixed(1)}% of the records (at most ${PREVIEW_MAX_ERROR_RATE * 100}% may be refused): fix the transform (kernel__import_transform_save), preview again, then start.`
    : null
}

export const previewParams = z.object({
  transform: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .describe("A saved transform's name."),
  version: z.number().int().positive().optional().describe("Default: its latest version."),
  fileIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .optional()
    .describe("Upload transforms: the uploaded export files (a zip is read entry by entry)."),
  files: fileRulesSchema
    .optional()
    .describe(
      "Which files or zip entries to read, in order, and how: [{match: glob, as?, delimiter?, recordElement?}]. Default: every csv, json, jsonl, xml, xlsx and text file.",
    ),
  sourceLabel: z
    .string()
    .regex(SOURCE_LABEL_RE)
    .describe(
      "Prefix of every record's dedup key (`jira`, `freshdesk`): a rerun skips what came before.",
    ),
  placeholders: z
    .boolean()
    .optional()
    .describe("People the source names who are not members become deactivated placeholders."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PREVIEW_MAX_CALLS)
    .optional()
    .describe(
      `Transform calls to run: batches of 200 records (default ${PREVIEW_DEFAULT_BATCHES}) or API pages (default ${PREVIEW_DEFAULT_PAGES}).`,
    ),
})

/**
 * Preview a saved transform as the caller (a dry run on the first batches or
 * pages): the counts, refused records, clipped samples and the preview's
 * hash, recorded on its dry-run row. Throws `ImportError` on a refusal.
 */
export async function previewImport(params: unknown, ctx: ImportActorCtx) {
  const p = previewParams.parse(params)
  {
    const live = await actingPerson({ ...ctx, approverUserId: null })
    const actor: UserContext = { ...live, scopes: ctx.scopes?.length ? ctx.scopes : live.scopes }
    const row = await loadTransform(ctx.orgId, p.transform, p.version)
    const input =
      row.sourceType === "api"
        ? transformInputSchema.parse({ type: "api", connection: row.connectionIdentifier })
        : p.fileIds
          ? transformInputSchema.parse({ type: "files", fileIds: p.fileIds })
          : null
    if (!input) {
      throw new ImportError(
        "invalid_request",
        "An upload transform previews uploaded files: pass fileIds.",
      )
    }
    const sha256 = sha256Of(row.source)
    const source: TransformSource = {
      type: "transform",
      transform: { id: row.id, version: row.version, sha256 },
      input,
      ...(p.files ? { files: p.files } : {}),
      limit:
        row.sourceType === "api"
          ? { pages: p.limit ?? PREVIEW_DEFAULT_PAGES }
          : { batches: p.limit ?? PREVIEW_DEFAULT_BATCHES },
    }
    const samples = new Map<string, unknown[]>()
    const peopleFields = new Map<string, string[]>()
    for (const k of row.kinds) {
      const info = await getImportKind(ctx.orgId, k)
      if (info?.decl.people?.length) peopleFields.set(k, info.decl.people)
    }
    const emails = new Set<string>()
    const result = await runImport({
      orgId: ctx.orgId,
      actor,
      kinds: row.kinds,
      source,
      sourceLabel: p.sourceLabel,
      mode: "api",
      dryRun: true,
      placeholders: p.placeholders === true,
      onRecord: (e) => {
        if (e.status !== "created" || e.record === undefined) return
        for (const path of peopleFields.get(e.kind) ?? []) {
          for (const v of valuesAt(e.record, path.split("."))) {
            if (typeof v === "string" && v.includes("@")) emails.add(v.trim().toLowerCase())
          }
        }
        const list = samples.get(e.kind) ?? []
        if (list.length < SAMPLES_PER_KIND) {
          list.push(clipValue(e.record))
          samples.set(e.kind, list)
        }
      },
    })
    const facts: PreviewFacts = {
      transform: { id: row.id, version: row.version, sha256 },
      binding: await sourceBindingOf(ctx.orgId, ctx.userId, source),
      kinds: row.kinds,
      sourceLabel: p.sourceLabel,
      placeholders: p.placeholders === true,
      counts: result.counts,
    }
    const { total, failed, rate } = errorRateOf(result.counts)
    await mergeRunReport(ctx.orgId, result.runId, {
      preview: {
        hash: previewHashOf(result.runId, facts),
        total,
        failed,
        errorRate: rate,
        // What the approval card shows: one clipped sample per kind and the
        // people the records name who are members.
        samples: Object.fromEntries(
          [...samples].map(([kind, list]) => [
            kind,
            JSON.stringify(list[0]).slice(0, CARD_SAMPLE_CHARS),
          ]),
        ),
        people: emails.size,
        members: await countMembersByEmail(ctx.orgId, [...emails]),
      },
    })
    const blocked = tooManyErrors(rate)
    return {
      previewId: result.runId,
      transform: `${row.name} v${row.version}`,
      counts: result.counts,
      errorRate: Number(rate.toFixed(4)),
      errors: result.errors.slice(0, ERRORS_SHOWN).map((e) => clipValue(e)),
      ...(result.errors.length > ERRORS_SHOWN
        ? { moreErrors: result.errors.length - ERRORS_SHOWN }
        : {}),
      report: clipValue(result.report),
      samples: wrapExternalContent(JSON.stringify(Object.fromEntries(samples))),
      next:
        blocked ??
        (result.report.cutAtLimit
          ? "This preview read only the first part of the source. If the counts and samples look right, call kernel__import_start with this previewId; it imports everything."
          : "If the counts and samples look right, call kernel__import_start with this previewId."),
    }
  }
}

/**
 * Queue the run a preview showed, acting as `actor`: the kinds' write scopes
 * held, every input file readable by them, the transform version and code
 * re-checked. `requestedBy` is who asked (an agent's person), `startedBy` the
 * one it runs as. Throws `ImportError` on a refusal.
 */
export async function startFromPreview(
  ctx: ImportActorCtx,
  pv: LoadedPreview,
): Promise<{ runId: string; status: string }> {
  const blocked = tooManyErrors(pv.rate)
  if (blocked) throw new ImportError("invalid_request", blocked)
  const actor = await actingPerson(ctx)
  const kinds: ImportKindInfo[] = []
  for (const name of pv.run.kindSet) {
    const k = await getImportKind(ctx.orgId, name)
    if (!k) throw new ImportError("unknown_kind", `No import kind ${name} any more.`)
    kinds.push(k)
  }
  const missing = missingWriteScopes(actor, kinds)
  if (missing.length > 0) {
    throw new ImportError(
      "forbidden",
      `missing scope: ${missing.join(", ")} (the person approving must hold every scope this import writes with)`,
    )
  }
  // The person the run acts as must be able to read every file it reads.
  if (pv.source.input.type === "files") {
    for (const id of pv.source.input.fileIds) await resolveImportFile(actor, id)
  }
  const runSource: TransformSource = {
    type: "transform",
    transform: pv.facts.transform,
    input: pv.source.input,
    ...(pv.source.files ? { files: pv.source.files } : {}),
  }
  const prepared = await prepareTransform(ctx.orgId, runSource, pv.run.kindSet)
  const run = await createImportRun({
    orgId: ctx.orgId,
    kinds: pv.run.kindSet,
    sourceLabel: pv.run.sourceLabel,
    // Who asked (the agent's person) and who approved (`startedBy`, whom the run acts as).
    source: {
      ...transformRunSource(runSource, prepared),
      previewId: pv.run.id,
      requestedBy: ctx.userId,
    },
    mode: "api",
    dryRun: false,
    placeholders: pv.run.placeholders,
    startedBy: actor.userId,
    approvalRequestId: ctx.approvalRequestId ?? null,
  })
  try {
    await enqueueImportRun({ orgId: ctx.orgId, runId: run.id })
  } catch (err) {
    await failRun(ctx.orgId, run.id, "the import could not be queued")
    throw err
  }
  return { runId: run.id, status: run.status }
}
