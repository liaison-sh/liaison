// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Imports as agent tools (deferred, kernel skill `import-transforms`). The
 * agent imports ANYTHING by writing a transform: a sandboxed script that turns
 * an export (uploaded files) or an API (a credentials connection) into the
 * records of the app-declared import kinds. There is no per-source importer
 * and no shell: the transform runs in the transform pool, the runner writes
 * through the kinds' own handlers.
 *
 *   import_kinds            the kinds this org can import and their record schemas
 *   import_reference        a shipped example transform (Jira Software, JSM, Freshdesk XML, Slack export, an invoice CSV example)
 *   import_sample           the first records of each part of uploaded files, as the
 *                           transform will receive them. Untrusted output.
 *   import_transform_save   save a new version of a named transform
 *   import_preview          run a saved version on the first batches or pages as a dry
 *                           run: counts per kind, errors with where they came from, three
 *                           clipped samples per kind. Writes no record; the preview is a
 *                           dry-run row whose hash an approval binds. Untrusted output.
 *   import_start            GATED, never auto-approved: start the import a preview showed.
 *                           The preflight pins the preview, the transform version and its
 *                           code hash, the source binding and the preview hash; the
 *                           execution re-derives each and refuses on any difference, and
 *                           refuses above 5 % preview errors. The run acts as the APPROVER
 *                           (a direct call: the caller), with their live scopes.
 *   import_status           a run's progress and report. Untrusted output.
 *   import_cancel           stop a run between batches (its starter or an admin).
 *   import_undo             GATED, never auto-approved: undo a finished run.
 *
 * Previews and starts share their core with the Imports routes: modules/imports/preview.ts.
 */
import { findRefTokens } from "@liaison/shared"
import { z } from "zod"
import type { UserContext } from "~/db/rls"
import type { ImportRunRow } from "~/db/schema/kernel"
import { wrapExternalContent } from "~/lib/external-content"
import { rootLogger } from "~/lib/logger"
import { type ApprovalSummarizer, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { listMergedCatalog } from "~/modules/apps/catalog-sources"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { assertRunAuthority, personLabel } from "~/modules/imports/authority"
import {
  catalogAppImportKinds,
  getImportKind,
  type ImportKindInfo,
  listImportKinds,
  splitKindName,
} from "~/modules/imports/kinds"
import {
  actingPerson,
  clipValue,
  ERRORS_SHOWN,
  errorText,
  type ImportActorCtx,
  loadPreview,
  previewImport,
  previewParams,
  startFromPreview,
  tooManyErrors,
} from "~/modules/imports/preview"
import {
  REFERENCE_TRANSFORMS,
  ReferenceParamError,
  type ReferenceSource,
  readReference,
  referenceConnectionAdapter,
  referenceWithParams,
} from "~/modules/imports/reference/references"
import {
  countRunLedger,
  FINAL_STATUSES,
  getImportRun,
  requestRunCancel,
} from "~/modules/imports/runs"
import {
  fileRulesSchema,
  loadPinnedTransform,
  loadTransform,
  sampleUpload,
  saveTransformVersion,
  sha256Of,
  type TransformSource,
} from "~/modules/imports/transform-run"
import { TransformSourceError } from "~/modules/imports/transforms/source"
import { TransformStoreError } from "~/modules/imports/transforms/store"
import { ImportError } from "~/modules/imports/types"
import { undoImportRun } from "~/modules/imports/undo"
import { loadToolsForNextStep } from "./tool-search"

const log = rootLogger.child({ module: "import-tools" })

/** Expected refusals become a tool error the agent can act on; anything else is logged and named. */
/**
 * A refusal the agent can act on: its code and a 4xx status flow through the
 * tool envelope (never a 500 tool_error, which reads as a fault of ours).
 */
interface Refused {
  error: {
    code: string
    message: string
    status: 400 | 403 | 404 | 409
    final?: true
    retryable?: boolean
  }
}

/** A 400 names what to change in the call, so the call is retryable once changed. */
function refused(code: string, message: string, status: Refused["error"]["status"] = 400): Refused {
  return { error: { code, message, status, ...(status === 400 ? { retryable: true } : {}) } }
}

/**
 * An approved call no re-approval can make pass (what the approval bound has
 * changed, or it bound nothing): `final`, so the approval closes instead of
 * going back to pending.
 */
function finalRefusal(code: string, message: string, status: 400 | 409 = 409): Refused {
  return { error: { code, message, status, final: true } }
}

/** A thrown error as the tool's answer: a refusal for the import errors, else a real failure. */
function refusal(err: unknown, tool: string): Refused | { error: string } {
  if (err instanceof ImportError) return refused(err.code, err.message, err.status)
  if (err instanceof TransformStoreError) {
    return refused(err.code, err.message, err.code === "transform_not_found" ? 404 : 400)
  }
  if (err instanceof TransformSourceError) return refused(err.code, err.message)
  log.error({ err, tool }, "import tool failed")
  return { error: `${tool} failed: ${errorText(err)}` }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const kindsParams = z.object({
  kind: z
    .string()
    .max(100)
    .optional()
    .describe("One kind (`tickets.ticket`) to get its full record schema; omit to list them all."),
})

function kindSummary(k: ImportKindInfo) {
  const props = (k.decl.schema.properties ?? {}) as Record<string, unknown>
  return {
    kind: k.kind,
    label: k.decl.label ?? k.kind,
    dedupKey: k.decl.dedupKey,
    fields: Object.keys(props),
    required: Array.isArray(k.decl.schema.required) ? k.decl.schema.required : [],
    ...(k.decl.parent ? { parent: `${k.app}.${k.decl.parent}` } : {}),
    ...(k.decl.files?.length ? { fileFields: k.decl.files } : {}),
    ...(k.decl.people?.length ? { peopleFields: k.decl.people } : {}),
    writeScopes: k.decl.writeScopes,
  }
}

/**
 * A kind this workspace cannot import, with what would make it importable.
 * A kind is `<app>.<name>`. The refusal says an app "provides" the kind only
 * when that app's manifest declares it (built in, installed on the server, or
 * baked in the catalog), and offers kernel__enable_app only for an app that
 * is not on. A weak model told only "no such kind" offered to import invoices
 * as tickets, and sent an admin to "ask your administrator".
 */
async function unknownKindRefusal(orgId: string, kind: string): Promise<Refused> {
  const parts = splitKindName(kind)
  const listed = "kernel__import_kinds lists the kinds this workspace has."
  const never = "Never import these records as another kind instead."
  if (!parts) return refused("unknown_kind", `No import kind ${kind}; ${listed}`, 404)
  const { app, name } = parts
  // An app on in this workspace has registered its tools for the org.
  await ensureAppsForOrg(orgId)
  const own = (await listImportKinds(orgId)).filter((k) => k.app === app).map((k) => k.kind)
  const appIsOn = own.length > 0 || toolRegistry.snapshotUnder([orgId, app]).size > 0
  if (appIsOn) {
    return refused(
      "unknown_kind",
      own.length > 0
        ? `No import kind ${kind}. The ${app} app is on in this workspace; its kinds are ${own.join(", ")}.`
        : `No import kind ${kind}. The ${app} app is on in this workspace and declares no import kinds, so these records cannot be imported into it. ${listed}`,
      404,
    )
  }
  let entry: { name: string; displayName?: string; source?: string } | undefined
  try {
    entry = (await listMergedCatalog()).apps.find((a) => a.name === app)
  } catch (err) {
    log.warn({ err, kind }, "unknown import kind: the app catalog could not be read")
  }
  const label = entry?.displayName ? `${entry.displayName} (${app})` : app
  const install = `If the person is an admin, offer to install it: kernel__enable_app with appName "${app}" (an approval card they approve), then save again.`
  // Declared by a manifest this server can read: built in, installed on the
  // server (not on here), or baked in the catalog.
  const known = await getImportKind(orgId, kind, { ensureApps: false })
  const baked = known ? null : catalogAppImportKinds(app)
  if (known || baked?.includes(name)) {
    return refused(
      "unknown_kind",
      `No import kind ${kind} yet: the ${label} app provides it, and it is not on in this workspace. ${install} ${never}`,
      404,
    )
  }
  if (baked) {
    return refused(
      "unknown_kind",
      `No import kind ${kind}: the ${label} app in the catalog declares no such kind${baked.length > 0 ? ` (its kinds: ${baked.map((k) => `${app}.${k}`).join(", ")})` : " and no import kinds at all"}. ${listed}`,
      404,
    )
  }
  if (entry) {
    return refused(
      "unknown_kind",
      `No import kind ${kind}: an app named ${label} is in the app catalog, but what it can import is known only once it is installed. Ask the person whether they want that app before offering kernel__enable_app with appName "${app}". ${never}`,
      404,
    )
  }
  return refused(
    "unknown_kind",
    `No import kind ${kind}: it would come from an app named ${app}, and no app of that name is in this workspace or the app catalog. ${listed}`,
    404,
  )
}

async function handleKinds(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const { kind } = kindsParams.parse(params)
  if (kind) {
    const k = await getImportKind(ctx.orgId, kind)
    if (!k) return await unknownKindRefusal(ctx.orgId, kind)
    return { ...kindSummary(k), schema: k.decl.schema }
  }
  const kinds = await listImportKinds(ctx.orgId)
  return {
    kinds: kinds.map(kindSummary),
    next: "Call kernel__import_kinds with one kind for its full record schema.",
  }
}

const referenceParams = z.object({
  source: z
    .string()
    .max(64)
    .optional()
    .describe(
      "A reference's name (jira-software, jira-service-management, freshdesk-xml); omit to list them.",
    ),
})

async function handleReference(params: unknown): Promise<unknown> {
  const { source } = referenceParams.parse(params)
  if (!source) {
    return {
      references: Object.entries(REFERENCE_TRANSFORMS).map(([name, r]) => ({
        source: name,
        sourceType: r.sourceType,
        kinds: r.kinds,
        about: r.about,
        ...(r.params || r.connection
          ? {
              settings: [
                ...Object.keys(r.params ?? {}),
                ...(r.connection ? [r.connection.siteParam] : []),
              ],
            }
          : {}),
        ...(r.connection ? { connection: r.connection.identifier } : {}),
      })),
      next: `When one is for the person's source (Jira, Freshdesk, Slack...), it is the transform: call kernel__import_reference with that source, then save it unchanged with kernel__import_transform_save({ name, fromReference: source }). An api reference also takes params: { SITE: "<the person's site>" } and needs a connection: the save's needsConnection names the exact call that creates it (a person approves it), then the credentials card. Otherwise read the closest one as an example.`,
    }
  }
  try {
    const ref = readReference(source)
    return {
      source: ref.name,
      sourceType: ref.sourceType,
      kinds: ref.kinds,
      about: ref.about,
      ...(ref.files ? { files: ref.files } : {}),
      ...(ref.connection
        ? { connection: { identifier: ref.connection.identifier, about: ref.connection.about } }
        : {}),
      ...(ref.params || ref.connection
        ? {
            settings: {
              ...Object.fromEntries(Object.entries(ref.params ?? {}).map(([k, p]) => [k, p.about])),
              ...(ref.connection ? { [ref.connection.siteParam]: ref.connection.siteAbout } : {}),
            },
          }
        : {}),
      code: ref.code,
      next: referenceNext(ref),
    }
  } catch (err) {
    return refused("not_found", errorText(err), 404)
  }
}

/** What to do with one reference: save it as shipped, with the site for an API one. */
function referenceNext(ref: ReferenceSource): string {
  const conn = ref.connection
  const narrowed = ref.params
    ? "; add a setting such as PROJECT_KEYS only if the person narrowed it"
    : ""
  const save = conn
    ? `kernel__import_transform_save({ name, fromReference: "${ref.name}", params: { ${conn.siteParam}: "<the person's site>" } })${narrowed}. ${conn.siteAbout} Its result names the connection to create, if it does not exist yet (needsConnection: the exact call, approved by a person), then the credentials card`
    : `kernel__import_transform_save({ name, fromReference: "${ref.name}"${ref.params ? ", params: { <a setting>: <value> }" : ""} })${narrowed}`
  return `For this source, save it as is: ${save}. Never retype or shorten the code (that drops parts such as attachments). For another tool, adapt the code and save it with code. Then preview.`
}

const sampleParams = z.object({
  fileIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .describe("The uploaded export files (a zip is read entry by entry)."),
  files: fileRulesSchema
    .optional()
    .describe("The same file rules a preview takes, to pick files or set parse options."),
})

async function handleSample(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = sampleParams.parse(params)
  try {
    // The agent's own scopes when it has narrower ones than its person (as a preview).
    const live = await actingPerson({ ...ctx, approverUserId: null })
    const actor: UserContext = { ...live, scopes: ctx.scopes?.length ? ctx.scopes : live.scopes }
    const sample = await sampleUpload({
      actor,
      fileIds: p.fileIds,
      ...(p.files ? { files: p.files } : {}),
    })
    return {
      files: sample.files.map((f) => ({
        name: f.name,
        format: f.format,
        records: wrapExternalContent(JSON.stringify(clipValue(f.records))),
        ...(f.totals ? { recordsPerPart: f.totals } : {}),
      })),
      ...(sample.unread.length > 0 ? { unread: sample.unread } : {}),
      next: "This is how your transform will receive the file: write it for these records (batch.records; batch.file and batch.path say where they come from), save it and preview it. You need nothing else from the file: do not fetch or read it another way.",
    }
  } catch (err) {
    return refusal(err, "import_sample")
  }
}

const saveParams = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .describe("The transform's name; saving the same name again adds a version."),
  fromReference: z
    .string()
    .max(64)
    .optional()
    .describe(
      "A reference's name (kernel__import_reference): saves its code, kinds and sourceType exactly as shipped. Then pass no code, kinds or sourceType.",
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'With fromReference: settings, e.g. { "SITE": "acme", "PROJECT_KEYS": ["NWA"] } (import_reference lists them). SITE is the person\'s own site, for an API reference. Everything else stays as shipped.',
    ),
  code: z
    .string()
    .min(1)
    .max(200_000)
    .optional()
    .describe(
      "Without fromReference: the transform, a plain script (see the import-transforms skill).",
    ),
  kinds: z
    .array(z.string().min(3).max(100))
    .min(1)
    .max(32)
    .optional()
    .describe("Without fromReference: every kind it emits."),
  sourceType: z
    .enum(["upload", "api"])
    .optional()
    .describe("Without fromReference: upload (uploaded files) or api (an API connection)."),
  connection: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .optional()
    .describe(
      "API transforms: the api-connector connection it pulls from (a reference names its own; config_export lists them under apiConnectors).",
    ),
})

/** What a save writes: the reference as shipped (settings applied), or the agent's own script. */
interface TransformToSave {
  code: string
  kinds: string[]
  sourceType: "upload" | "api"
  /** The reference it came from, when it did. */
  ref?: ReferenceSource
}

function transformToSave(p: z.infer<typeof saveParams>): TransformToSave | Refused {
  if (p.fromReference !== undefined) {
    if (p.code !== undefined || p.kinds !== undefined || p.sourceType !== undefined) {
      return refused(
        "invalid_request",
        "Pass fromReference alone (its code, kinds and sourceType come with it), or your own code, kinds and sourceType without it.",
      )
    }
    let ref: ReturnType<typeof readReference>
    try {
      ref = readReference(p.fromReference)
    } catch (err) {
      return refused("not_found", errorText(err), 404)
    }
    try {
      return {
        code: referenceWithParams(ref, p.params),
        kinds: ref.kinds,
        sourceType: ref.sourceType,
        ref,
      }
    } catch (err) {
      if (err instanceof ReferenceParamError) return refused("invalid_request", err.message)
      throw err
    }
  }
  if (p.params !== undefined) {
    return refused(
      "invalid_request",
      "params only goes with fromReference: put settings in your code.",
    )
  }
  if (p.code === undefined || p.kinds === undefined || p.sourceType === undefined) {
    return refused(
      "invalid_request",
      "Pass fromReference (a reference's name, saved as shipped), or code, kinds and sourceType. For a source a reference covers (kernel__import_reference lists them), use fromReference.",
    )
  }
  return { code: p.code, kinds: p.kinds, sourceType: p.sourceType }
}

/** The adapter save tool an API connection is created with (api-connector, approved by a person). */
const ADAPTER_SAVE_TOOL = "api-connector__connector_adapter_save"
const REQUEST_SECRET_TOOL = "kernel__request_secret"

/** Whether an api-connector connection exists, and whether its credentials are saved. */
async function connectionState(
  orgId: string,
  identifier: string,
): Promise<{ state: "missing" | "needs_credentials" | "ready"; baseUrl?: string }> {
  const { getAdapterRow, credentialStatuses } = await import("~/modules/apps/connections/api/store")
  const row = await getAdapterRow(orgId, identifier)
  if (!row) return { state: "missing" }
  const ready = (await credentialStatuses(orgId)).get(identifier) === "ok"
  return { state: ready ? "ready" : "needs_credentials", baseUrl: row.adapter.baseUrl }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function credentialsCall(identifier: string) {
  return {
    tool: REQUEST_SECRET_TOOL,
    params: { kind: "api_connector_credentials", target: { identifier } },
  }
}

/**
 * The connection an API transform pulls from, checked at save: a missing one
 * is named with the exact call that creates it (a reference ships its
 * adapter), a connection without credentials with the card that asks for them.
 */
async function connectionStep(
  t: TransformToSave,
  p: z.infer<typeof saveParams>,
  ctx: ImportActorCtx,
): Promise<{ identifier: string; result: Record<string, unknown> } | Refused> {
  const conn = t.ref?.connection
  const identifier = p.connection ?? conn?.identifier
  if (!identifier) {
    return refused(
      "invalid_request",
      `An API transform needs connection: the identifier of the api-connector connection it pulls from (kernel__config_export lists them under apiConnectors). None yet? Create one with ${ADAPTER_SAVE_TOOL} (a person approves it), then ask for its credentials with ${REQUEST_SECRET_TOOL}. Nothing was saved.`,
    )
  }
  const { state, baseUrl } = await connectionState(ctx.orgId, identifier)
  // A site the person named must be the one the connection already reads:
  // never import from one site while they think it is another.
  const named = conn ? p.params?.[conn.siteParam] : undefined
  if (conn && named !== undefined && baseUrl) {
    const wanted = typeof named === "string" ? conn.baseUrl(named) : null
    if (!wanted) {
      return refused(
        "invalid_request",
        `${conn.siteParam}: ${JSON.stringify(named)} is not a site this reference reads. ${conn.siteAbout}`,
      )
    }
    if (hostOf(wanted) !== hostOf(baseUrl)) {
      return refused(
        "invalid_request",
        `The connection ${identifier} reads ${hostOf(baseUrl)}, not ${hostOf(wanted)}. Ask the person which site to import from; to read ${hostOf(wanted)}, save a connection under another identifier and pass it as connection. Nothing was saved.`,
      )
    }
  }
  if (state === "ready") {
    return {
      identifier,
      result: { next: "Preview it with kernel__import_preview (it writes nothing)." },
    }
  }
  if (state === "needs_credentials") {
    return {
      identifier,
      result: {
        needsCredentials: { identifier, askWith: credentialsCall(identifier) },
        next: `The connection ${identifier} has no credentials yet: call needsCredentials.askWith (a card where the person enters them; you never see them). When it says saved, preview with kernel__import_preview.`,
      },
    }
  }
  if (!conn || !t.ref || identifier !== conn.identifier) {
    return refused(
      "invalid_request",
      `There is no API connection named ${identifier}. Create it first with ${ADAPTER_SAVE_TOOL} (read api-connector__connector_adapter_reference for the format; a person approves the save), then ask for its credentials with ${REQUEST_SECRET_TOOL}, and save this transform again. Nothing was saved.`,
    )
  }
  const site = p.params?.[conn.siteParam]
  if (site === undefined) {
    return refused(
      "invalid_request",
      `The connection ${identifier} does not exist yet, and creating it needs the person's site: call again with params: { ${conn.siteParam}: "<site>" }. ${conn.siteAbout} Nothing was saved.`,
    )
  }
  let adapter: ReturnType<typeof referenceConnectionAdapter>
  try {
    adapter = referenceConnectionAdapter(t.ref, site)
  } catch (err) {
    if (err instanceof ReferenceParamError) return refused("invalid_request", err.message)
    throw err
  }
  const loaded = await loadToolsForNextStep(ctx, [ADAPTER_SAVE_TOOL, REQUEST_SECRET_TOOL])
  return {
    identifier,
    result: {
      needsConnection: {
        identifier,
        createWith: { tool: ADAPTER_SAVE_TOOL, params: adapter },
        thenCredentials: credentialsCall(identifier),
      },
      next: `The transform is saved; its connection ${identifier} does not exist yet. 1. Call ${ADAPTER_SAVE_TOOL} with exactly needsConnection.createWith.params: it shows the person an approval card. 2. When it is approved, call needsConnection.thenCredentials (a card for the email and API token; you never see them). 3. Then preview with kernel__import_preview. Do not say the import is ready before that.${loaded ? ` ${loaded}` : ""}`,
    },
  }
}

async function handleSave(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = saveParams.parse(params)
  const t = transformToSave(p)
  if ("error" in t) return t
  try {
    for (const kind of t.kinds) {
      if (!(await getImportKind(ctx.orgId, kind))) {
        return await unknownKindRefusal(ctx.orgId, kind)
      }
    }
    if (t.sourceType === "upload" && p.connection !== undefined) {
      return refused(
        "invalid_request",
        "An upload transform takes no connection: leave connection out.",
      )
    }
    const step = t.sourceType === "api" ? await connectionStep(t, p, ctx) : null
    if (step && "error" in step) return step
    const saved = await saveTransformVersion({
      orgId: ctx.orgId,
      name: p.name,
      source: t.code,
      kinds: t.kinds,
      sourceType: t.sourceType,
      connectionIdentifier: step?.identifier ?? null,
      createdBy: ctx.userId,
    })
    return {
      ...saved,
      ...(step ? { connection: step.identifier, ...step.result } : {}),
      ...(step ? {} : { next: "Preview it with kernel__import_preview (it writes nothing)." }),
    }
  } catch (err) {
    return refusal(err, "import_transform_save")
  }
}

async function handlePreview(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  try {
    return await previewImport(params, ctx)
  } catch (err) {
    return refusal(err, "import_preview")
  }
}

const startParams = z.object({
  previewId: z.string().uuid().describe("The previewId kernel__import_preview returned."),
  boundPreviewId: z.string().optional().describe("Set by the server when the import is proposed."),
  transformId: z.string().optional().describe("Set by the server when the import is proposed."),
  transformVersion: z
    .number()
    .optional()
    .describe("Set by the server when the import is proposed."),
  transformSha256: z.string().optional().describe("Set by the server when the import is proposed."),
  sourceBinding: z.string().optional().describe("Set by the server when the import is proposed."),
  previewHash: z.string().optional().describe("Set by the server when the import is proposed."),
})

/** STAGE: the preview the call names, re-derived; its facts pinned on the approval. */
async function startPreflight(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = startParams.parse(params)
  try {
    const pv = await loadPreview(ctx.orgId, p.previewId, ctx.userId)
    const blocked = tooManyErrors(pv.rate)
    if (blocked) return refused("too_many_refused", blocked)
    return {
      ok: true,
      pinnedParams: {
        boundPreviewId: pv.run.id,
        transformId: pv.facts.transform.id,
        transformVersion: pv.facts.transform.version,
        transformSha256: pv.facts.transform.sha256,
        sourceBinding: pv.facts.binding,
        previewHash: pv.hash,
      },
    }
  } catch (err) {
    return refusal(err, "import_start")
  }
}

/** EXECUTE: every pin re-derived and compared, then the run is queued as the approver. */
async function handleStart(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = startParams.parse(params)
  if (!p.boundPreviewId || !p.previewHash) {
    return finalRefusal(
      "invalid_request",
      "import_start carries no approved preview: call it again with the previewId.",
      400,
    )
  }
  try {
    if (p.boundPreviewId !== p.previewId) {
      return finalRefusal(
        "approval_mismatch",
        "The approved preview is not the one this call names; propose again.",
      )
    }
    const pv = await loadPreview(ctx.orgId, p.previewId, ctx.userId)
    if (
      pv.hash !== p.previewHash ||
      pv.facts.transform.id !== p.transformId ||
      pv.facts.transform.version !== p.transformVersion ||
      pv.facts.transform.sha256 !== p.transformSha256 ||
      pv.facts.binding !== p.sourceBinding
    ) {
      return finalRefusal(
        "approval_mismatch",
        "The preview changed since approval; preview again and propose again.",
      )
    }
    const blocked = tooManyErrors(pv.rate)
    if (blocked) return refused("too_many_refused", blocked)
    return {
      ...(await startFromPreview(ctx, pv)),
      next: "The import runs in the background and nobody is told when it ends. Tell the person it is running and that you can check its progress whenever they ask (with kernel__import_status). Never say you are monitoring it or will report back.",
    }
  } catch (err) {
    return refusal(err, "import_start")
  }
}

const runIdParams = z.object({ runId: z.string().uuid().describe("The import run's id.") })

async function handleStatus(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const { runId } = runIdParams.parse(params)
  const run = await getImportRun(ctx.orgId, runId)
  if (!run) return refused("not_found", "No such import run.", 404)
  return {
    runId: run.id,
    status: run.status,
    preview: run.dryRun,
    kinds: run.kindSet,
    counts: run.counts,
    errors: run.errors.slice(0, ERRORS_SHOWN).map((e) => clipValue(e)),
    ...(run.errors.length > ERRORS_SHOWN ? { moreErrors: run.errors.length - ERRORS_SHOWN } : {}),
    report: clipValue(run.report),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }
}

async function handleCancel(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const { runId } = runIdParams.parse(params)
  try {
    const run = await getImportRun(ctx.orgId, runId)
    if (!run) return refused("not_found", "No such import run.", 404)
    await assertRunAuthority(ctx.orgId, ctx.userId, run)
    const after = await requestRunCancel(ctx.orgId, runId)
    return {
      runId,
      status: after?.status ?? run.status,
      next: "A running import stops after its current batch; what it wrote stays and can be undone.",
    }
  } catch (err) {
    return refusal(err, "import_cancel")
  }
}

const undoParams = z.object({
  runId: z.string().uuid().describe("The finished import run to undo."),
  boundRunId: z.string().optional().describe("Set by the server when the undo is proposed."),
  ledgerRows: z.number().optional().describe("Set by the server when the undo is proposed."),
})

async function undoPreflight(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = undoParams.parse(params)
  try {
    const run = await getImportRun(ctx.orgId, p.runId)
    if (!run || run.dryRun)
      return refused("not_found", "No such import run (a preview has nothing to undo).", 404)
    if (run.status === "undone") {
      return refused(
        "already_undone",
        "This import was already undone: nothing is left to undo.",
        409,
      )
    }
    if (!FINAL_STATUSES.has(run.status)) {
      return refused(
        "not_final",
        `This import is ${run.status}: it can be undone once it ends.`,
        409,
      )
    }
    await assertRunAuthority(ctx.orgId, ctx.userId, run)
    return {
      ok: true,
      pinnedParams: { boundRunId: run.id, ledgerRows: await countRunLedger(ctx.orgId, run.id) },
    }
  } catch (err) {
    return refusal(err, "import_undo")
  }
}

async function handleUndo(params: unknown, ctx: ImportActorCtx): Promise<unknown> {
  const p = undoParams.parse(params)
  if (!p.boundRunId || p.boundRunId !== p.runId) {
    return finalRefusal(
      "invalid_request",
      "import_undo carries no approved run: call it again with the runId.",
      400,
    )
  }
  try {
    // The rows the card counted: a run whose ledger changed since is proposed again.
    if (p.ledgerRows !== (await countRunLedger(ctx.orgId, p.runId))) {
      return finalRefusal(
        "approval_mismatch",
        "The import's ledger changed since approval; propose the undo again.",
      )
    }
    const actor = await actingPerson(ctx)
    const report = await undoImportRun(ctx.orgId, p.runId, { userId: actor.userId })
    return {
      runId: p.runId,
      deleted: report.deleted,
      kept: report.refused.slice(0, 50),
      ...(report.refused.length > 50 ? { moreKept: report.refused.length - 50 } : {}),
      ...(report.refused.length > 0
        ? {
            next: "The kept rows changed after the import or gained new children (a reply, a comment): say which, they stay.",
          }
        : {}),
    }
  } catch (err) {
    return refusal(err, "import_undo")
  }
}

// ---------------------------------------------------------------------------
// Approval cards: computed from the server's own records, never from a param
// ---------------------------------------------------------------------------

function countLines(counts: ImportRunRow["counts"]): string[] {
  return Object.entries(counts).map(
    ([kind, c]) =>
      `${kind}: ${c.created} to create${c.skipped ? `, ${c.skipped} already there` : ""}${c.failed ? `, ${c.failed} refused` : ""}`,
  )
}

function inputLine(source: TransformSource, report: Record<string, unknown>): string {
  if (source.input.type === "api") return `From the API connection ${source.input.connection}`
  const files = Array.isArray(report.filesRead) ? (report.filesRead as string[]) : []
  return `From ${source.input.type === "files" ? source.input.fileIds.length : 0} uploaded file(s)${files.length ? `: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}` : ""}`
}

/** Lines added and removed between two versions of a transform (as multisets of lines). */
export function lineChange(before: string, after: string): { added: number; removed: number } {
  const count = (text: string) => {
    const m = new Map<string, number>()
    for (const l of text.split("\n")) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  let added = 0
  let removed = 0
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0))
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0))
  return { added, removed }
}

/** The transform being approved: its author, size, hash and change since its last version. */
async function transformLine(orgId: string, pin: { id: string; version: number }): Promise<string> {
  const row = await loadPinnedTransform(orgId, pin)
  const author = (await personLabel(orgId, row.createdBy)) ?? "an unknown author"
  const size = `${(Buffer.byteLength(row.source, "utf8") / 1024).toFixed(1)} KB`
  let change = "its first version"
  if (row.version > 1) {
    const prev = await loadTransform(orgId, row.name, row.version - 1).catch(() => null)
    if (prev) {
      const d = lineChange(prev.source, row.source)
      change = `+${d.added}/-${d.removed} lines since v${prev.version}`
    }
  }
  return `Transform "${row.name}" v${row.version} by ${author}: ${size}, sha256 ${sha256Of(row.source).slice(0, 12)}; ${change}.`
}

const startSummarizer: ApprovalSummarizer = async (raw, ctx) => {
  let lines: string[]
  let title = "Start an import"
  try {
    const previewId = startParams.parse(raw).previewId
    const pv = await loadPreview(ctx.orgId, previewId, ctx.userId)
    const transform =
      typeof pv.run.report.transform === "string" ? pv.run.report.transform : "transform"
    title = `Import with ${transform} v${pv.facts.transform.version}`
    const preview = (pv.run.report.preview ?? {}) as {
      samples?: Record<string, string>
      people?: number
      members?: number
    }
    const kindLines = countLines(pv.run.counts).map((line, i) => {
      const kind = Object.keys(pv.run.counts)[i] ?? ""
      const sample = preview.samples?.[kind]
      return sample ? `${line}. E.g. ${wrapExternalContent(sample)}` : line
    })
    const people = preview.people ?? 0
    const members = preview.members ?? 0
    lines = [
      inputLine(pv.source, pv.run.report),
      ...(kindLines.length > 3
        ? [...kindLines.slice(0, 2), `and ${kindLines.length - 2} more kinds`]
        : kindLines),
      `${pv.run.report.cutAtLimit ? "Counts are from a preview of the first part; the import reads everything." : "Counts are from the preview."} ${(pv.rate * 100).toFixed(1)}% refused. Runs as the person who approves; undoable by run.`,
      await transformLine(ctx.orgId, pv.facts.transform),
      `Credits ${members} member${members === 1 ? "" : "s"} by email (${people} ${people === 1 ? "person" : "people"} named in the preview)${pv.run.placeholders ? "; unknown people become deactivated placeholders" : "; unknown people are left unattributed"}.`,
    ]
  } catch (err) {
    lines = [`The preview could not be read: ${errorText(err)}`]
  }
  return {
    kind: "import",
    title: title.slice(0, 200),
    lines: lines.slice(0, 8).map((l) => l.slice(0, 500)),
    impact: "internal",
  }
}

const undoSummarizer: ApprovalSummarizer = async (raw, ctx) => {
  let lines: string[]
  try {
    const runId = undoParams.parse(raw).runId
    const run = await getImportRun(ctx.orgId, runId)
    if (!run) throw new Error("no such run")
    const created = Object.values(run.counts).reduce((s, c) => s + c.created, 0)
    lines = [
      `Deletes what the import of ${run.createdAt.toISOString().slice(0, 10)} created: ${created} record(s), ${await countRunLedger(ctx.orgId, runId)} row(s).`,
      `Kinds: ${run.kindSet.join(", ")}.`,
      "Rows changed after the import, or with replies or comments added since, are kept and listed.",
    ]
  } catch (err) {
    lines = [`The run could not be read: ${errorText(err)}`]
  }
  return { kind: "import", title: "Undo an import", lines, impact: "internal" }
}

/** A call naming an earlier step's result (`@ref:`) has no preview to bind yet. */
function refuseReference(params: unknown): unknown | null {
  return findRefTokens(params).length > 0
    ? {
        error:
          "this tool can't take a reference to an earlier step; call it after that step completes",
      }
    : null
}

export function registerImportTools(orgId: string): void {
  // Literal names, descriptions and scopes: the reference docs read them from
  // here (scripts/docs/gen-reference.ts); import-tools.test.ts pins the
  // descriptions to 240 characters and every tool to the deferred tier.
  toolRegistry.set([orgId, "kernel", "import_kinds"], {
    appName: "kernel",
    name: "import_kinds",
    deferLoading: true,
    description:
      "List what this org can import (kinds such as tickets.ticket, projects.task, contacts.contact) and their fields; with kind, its schema. First check kernel__import_reference for a shipped transform for the source.",
    requiredScopes: ["kernel:imports:read"],
    readOnly: true,
    taintFree: true,
    params: kindsParams,
    handler: handleKinds,
  })
  toolRegistry.set([orgId, "kernel", "import_reference"], {
    appName: "kernel",
    name: "import_reference",
    deferLoading: true,
    description:
      "Step one of any import: the shipped transforms (Jira Software, Jira Service Management, Freshdesk XML, Slack export, invoice CSV example). One for the source is saved as is with import_transform_save fromReference.",
    requiredScopes: ["kernel:imports:read"],
    readOnly: true,
    taintFree: true,
    params: referenceParams,
    handler: handleReference,
  })
  toolRegistry.set([orgId, "kernel", "import_sample"], {
    appName: "kernel",
    name: "import_sample",
    deferLoading: true,
    description:
      "Show the first records of each uploaded export file exactly as a transform will receive them (CSV rows, JSON elements, XML elements, zip entries). Read it before writing a transform.",
    requiredScopes: ["kernel:imports:run"],
    readOnly: true,
    // The records are the export's own text.
    taintSource: true,
    params: sampleParams,
    handler: handleSample,
  })
  toolRegistry.set([orgId, "kernel", "import_transform_save"], {
    appName: "kernel",
    name: "import_transform_save",
    deferLoading: true,
    description:
      "Save a transform version: fromReference saves a shipped reference as is (Jira, Freshdesk, Slack...; Jira takes params.SITE and names the connection to create), else your own script. Then kernel__import_preview.",
    requiredScopes: ["kernel:imports:run"],
    writesToTable: "kernel.import_transforms",
    sinkReadScope: "kernel:imports:run",
    params: saveParams,
    handler: handleSave,
  })
  toolRegistry.set([orgId, "kernel", "import_preview"], {
    appName: "kernel",
    name: "import_preview",
    deferLoading: true,
    description:
      "Dry-run a saved transform on the first batches or pages: counts per kind, refused records with where they came from, three samples per kind. Writes no record. Returns the previewId import_start takes.",
    searchKeywords: ["importer", "aperçu", "csv"],
    requiredScopes: ["kernel:imports:run"],
    // The samples are the source's own text.
    taintSource: true,
    writesToTable: "kernel.import_runs",
    sinkReadScope: "kernel:imports:read",
    params: previewParams,
    handler: handlePreview,
  })
  toolRegistry.set([orgId, "kernel", "import_start"], {
    appName: "kernel",
    name: "import_start",
    deferLoading: true,
    description:
      "Start the import a preview showed (gated: a person approves the counts). Runs in the background as the approver; refused above 5% preview errors. Its progress and report come from the import status tool.",
    searchKeywords: ["importer", "csv", "excel", "migrer", "migration"],
    requiredScopes: ["kernel:imports:run"],
    trustBoundary: "user",
    gated: true,
    noAutoApprove: true,
    approvalImpact: "internal",
    // The approval binds the preview and what it ran; a caller's values are dropped.
    pinnedParams: [
      "boundPreviewId",
      "transformId",
      "transformVersion",
      "transformSha256",
      "sourceBinding",
      "previewHash",
    ],
    refuseBeforeGate: refuseReference,
    params: startParams,
    preflight: startPreflight,
    handler: handleStart,
  })
  registerApprovalSummarizer(orgId, "kernel", "import_start", startSummarizer)
  toolRegistry.set([orgId, "kernel", "import_status"], {
    appName: "kernel",
    name: "import_status",
    deferLoading: true,
    description:
      "An import run's status, counts per kind, refused records and report (a preview's too).",
    searchKeywords: ["importer", "statut"],
    requiredScopes: ["kernel:imports:read"],
    readOnly: true,
    // Errors and the report quote the source's own values.
    taintSource: true,
    params: runIdParams,
    handler: handleStatus,
  })
  toolRegistry.set([orgId, "kernel", "import_cancel"], {
    appName: "kernel",
    name: "import_cancel",
    deferLoading: true,
    description:
      "Stop a running import after its current batch (its starter or an admin). What it wrote stays and can be undone.",
    requiredScopes: ["kernel:imports:run"],
    writesToTable: "kernel.import_runs",
    sinkReadScope: "kernel:imports:read",
    // The run id is the whole call: it carries nothing of the turn.
    contentParams: [],
    params: runIdParams,
    handler: handleCancel,
  })
  toolRegistry.set([orgId, "kernel", "import_undo"], {
    appName: "kernel",
    name: "import_undo",
    deferLoading: true,
    description:
      "Undo a finished import (gated): deletes what it created. Rows changed after the import, or that gained replies or comments, are kept and listed.",
    searchKeywords: ["importer", "annuler"],
    requiredScopes: ["kernel:imports:undo"],
    trustBoundary: "user",
    gated: true,
    noAutoApprove: true,
    approvalImpact: "internal",
    pinnedParams: ["boundRunId", "ledgerRows"],
    refuseBeforeGate: refuseReference,
    params: undoParams,
    preflight: undoPreflight,
    handler: handleUndo,
  })
  registerApprovalSummarizer(orgId, "kernel", "import_undo", undoSummarizer)
}
