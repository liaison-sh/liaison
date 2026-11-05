// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Declarative settings: read and write the fields an app's manifest `settings`
 * page declares (app-sdk app-settings.ts), one field per write.
 *
 *   GET   /api/apps/:app/settings/org    values of the org fields the caller may read
 *   PATCH /api/apps/:app/settings/org    { path, value } | { values: { <path>: value } }
 *   GET   /api/apps/:app/settings/user   the caller's own values
 *   PATCH /api/apps/:app/settings/user   { path, value }
 *
 * A field's `source` says where its value lives:
 *   - `settings` (default): `organizations.settings.<app>` / `users.settings.<app>`
 *     at the field's dot path, set alone (siblings kept). Org writes run on the
 *     privileged connection AFTER the section's adminScope check here; user
 *     writes run in the caller's RLS transaction (own row only).
 *   - `config`: the app's `kernel.apps.config` key (the same allowlist and type
 *     check as PUT /api/apps/:app/config/:key, but the section's adminScope
 *     decides, not the route's kernel:apps:admin).
 *   - `{ tool: { get, set } }`: the app's own tools, run AS THE CALLER (origin
 *     human-ui, so the tool's required scopes and approval policy apply). The
 *     get tool returns the section's value object; the set tool receives that
 *     object with the one path changed. A set that parks for approval answers
 *     202 `{ pending: { approvalRequestId } }`, never a saved value. Several
 *     fields of one set tool are saved together with `{ values }` (the page
 *     saves such a section as one unit: one set call, one approval), and while
 *     an approval of a set tool waits, the next write on it is refused (409
 *     approval_pending): it would be built from the old stored object.
 *
 * Access (S17): an org field is written only by a holder of its section's
 * adminScope (every org section has one: kernel:apps:admin when the manifest
 * names none). `config` and `tool` values are READ only by holders too;
 * `settings` values are not secret (members already read them through
 * GET /api/org) and are returned to every member.
 *
 * Each write leaves one audit row: `settings` and `tool` writes emit the kernel
 * event `app_setting:updated` (`data: { app, path, scope }`), which the audit
 * consumer records; a `config` write is recorded by writeAppConfigKey itself.
 *
 * Errors: 400 invalid_body, 403 forbidden, 404 no_settings | unknown_field,
 * 409 approval_pending, 422 invalid_field (with `field`), and a tool's own
 * status and code.
 */

import { fieldSourceKind } from "@liaison/app-sdk"
import { and, eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import { isRecord } from "~/lib/guards"
import { appsLogger as log } from "~/lib/logger"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import {
  readOrgAppNamespace,
  readUserAppNamespace,
  setOrgAppSettingPath,
  settingAtPath,
  setUserAppSettingPath,
  withSettingAtPath,
} from "~/lib/settings"
import { getRequestSignal } from "~/middleware/request-timeout"
import {
  checkAppConfigWriteForOrg,
  readAppConfig,
  writeAppConfigKey,
} from "~/modules/apps/app-config"
import { appSettingsRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type {
  ManifestSettingsEntry,
  RegisteredSettingsField,
} from "~/modules/apps/settings-schema-from-manifest"
import { hasScope } from "~/modules/permissions/permissions"

export const appSettingsRoutes = new Hono<AppEnv>()

type Scope = "org" | "user"
type Ctx = Context<AppEnv>

type ErrorCode =
  | "invalid_body"
  | "forbidden"
  | "no_settings"
  | "unknown_field"
  | "invalid_field"
  | (string & {})

function fail(c: Ctx, status: number, code: ErrorCode, message: string, field?: string) {
  return c.json(
    { error: { message, code, ...(field !== undefined ? { field } : {}) } },
    status as 400 | 403 | 404 | 422 | 500,
  )
}

const splitPath = (key: string) => key.split(".")

/** The stored value, else the declared default, else null. */
function valueOrDefault(stored: unknown, reg: RegisteredSettingsField): unknown {
  if (stored !== undefined) return stored
  return reg.field.default ?? null
}

async function settingsEntry(c: Ctx): Promise<ManifestSettingsEntry | null> {
  const orgId = c.get("orgId")
  await ensureAppsForOrg(orgId)
  return appSettingsRegistry.get([orgId, c.req.param("app") ?? ""])?.manifestSettings ?? null
}

function noSettings(c: Ctx) {
  return fail(c, 404, "no_settings", `App "${c.req.param("app")}" has no settings page`)
}

function canAdminister(c: Ctx, reg: RegisteredSettingsField): boolean {
  return reg.adminScope !== null && hasScope(reg.adminScope, c.get("scopes") ?? [])
}

type ToolOutcome =
  | { ok: true; data: unknown }
  | { ok: false; pending: string | null }
  | { ok: false; status: number; code: string; message: string }

/** Run one of the app's tools as the caller, from the settings page (a person's click). */
async function runAppTool(c: Ctx, tool: string, params: unknown): Promise<ToolOutcome> {
  const app = c.req.param("app") ?? ""
  try {
    const result = await executeTool({
      toolName: `${app}:${tool}`,
      orgId: c.get("orgId"),
      actor: extractRlsContext(c),
      params,
      origin: "human-ui",
      signal: getRequestSignal(c),
    })
    if (result.blocked) return { ok: false, pending: result.blocked.approvalRequestId ?? null }
    // "Not connected" comes back as data carrying an error, not as a throw.
    const data = result.data
    if (isRecord(data) && isRecord(data.error) && typeof data.error.code === "string") {
      return {
        ok: false,
        status: 409,
        code: data.error.code,
        message: typeof data.error.message === "string" ? data.error.message : data.error.code,
      }
    }
    return { ok: true, data }
  } catch (err) {
    const e = err as Error & { status?: number; code?: string }
    const status = typeof e.status === "number" ? e.status : 500
    if (status >= 500) {
      log.error({ err, app, tool }, "settings: app tool failed")
    }
    return {
      ok: false,
      status,
      code: typeof e.code === "string" ? e.code : "tool_error",
      message: `${app}:${tool}: ${e.message}`,
    }
  }
}

function toolPair(reg: RegisteredSettingsField): { get: string; set: string } | null {
  const s = reg.field.source
  return isRecord(s) && isRecord(s.tool) ? (s.tool as { get: string; set: string }) : null
}

function appSettingEvent(c: Ctx, scope: Scope, path: string): AppEvent {
  const userId = c.get("userId")
  return {
    app: "kernel",
    entity: "app_setting",
    action: "updated",
    entityId: scope === "org" ? c.get("orgId") : userId,
    orgId: c.get("orgId"),
    actorId: userId,
    actorType: "user",
    data: { app: c.req.param("app"), path, scope },
  }
}

/** Values of one scope's fields the caller may read, plus per-field read errors. */
async function readValues(c: Ctx, entry: ManifestSettingsEntry, scope: Scope) {
  const orgId = c.get("orgId")
  const app = c.req.param("app") ?? ""
  const values: Record<string, unknown> = {}
  const errors: Record<string, { code: string; message: string }> = {}
  const namespace =
    scope === "org"
      ? await withPrivilegedDb(orgId, "app-settings-read-org", (tx) =>
          readOrgAppNamespace(tx, orgId, app),
        )
      : await withRequestRls(c, (tx) => readUserAppNamespace(tx, c.get("userId"), app))
  let config: Record<string, unknown> | null = null
  const toolReads = new Map<string, ToolOutcome>()
  for (const [key, reg] of entry.fields[scope]) {
    const kind = fieldSourceKind(reg.field)
    if (kind === "settings") {
      values[key] = valueOrDefault(settingAtPath(namespace, splitPath(key)), reg)
      continue
    }
    if (scope === "org" && !canAdminister(c, reg)) continue
    if (kind === "config") {
      config ??= await withPrivilegedDb(orgId, "app-settings-read-config", (tx) =>
        readAppConfig(tx, orgId, app),
      )
      values[key] = valueOrDefault(config[key], reg)
      continue
    }
    const pair = toolPair(reg)
    if (!pair) continue
    let outcome = toolReads.get(pair.get)
    if (!outcome) {
      outcome = await runAppTool(c, pair.get, {})
      toolReads.set(pair.get, outcome)
    }
    if (outcome.ok) {
      const obj = isRecord(outcome.data) ? outcome.data : {}
      values[key] = valueOrDefault(settingAtPath(obj, splitPath(key)), reg)
    } else if ("status" in outcome) {
      errors[key] = { code: outcome.code, message: outcome.message }
    } else {
      errors[key] = { code: "pending", message: `${app}:${pair.get} is waiting for approval` }
    }
  }
  return Object.keys(errors).length > 0 ? { values, errors } : { values }
}

/** A validated value, or the 422 that names the field. */
function validated(
  reg: RegisteredSettingsField,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = reg.validator.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : ""
  return { ok: false, message: `${reg.field.label}: ${issue?.message ?? "invalid value"}${where}` }
}

/**
 * A set tool's approval that is still waiting (M1). The tool receives the WHOLE
 * object, built from the stored state; a second write staged before the first is
 * decided would carry the first one's old values, and approving both in order
 * would undo the first. So while one waits, the next write is refused.
 */
async function pendingApprovalOf(orgId: string, toolName: string): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "app-settings-pending-set", (tx) =>
    tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          eq(approvalRequests.toolName, toolName),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1),
  )
  return rows[0]?.id ?? null
}

/**
 * The body: `{ path, value }` (one field), or `{ values: { <path>: value } }` for
 * several fields of ONE tool-backed whole-object setter, saved as one unit: one
 * get, every path set, one set call (one approval when it is gated).
 */
function writesOf(body: unknown): Array<[string, unknown]> | null {
  if (!isRecord(body)) return null
  if (typeof body.path === "string" && "value" in body) return [[body.path, body.value]]
  if (isRecord(body.values) && !("path" in body)) {
    const entries = Object.entries(body.values)
    return entries.length > 0 ? entries : null
  }
  return null
}

async function writeValue(c: Ctx, entry: ManifestSettingsEntry, scope: Scope) {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const app = c.req.param("app") ?? ""
  const body = (await c.req.json().catch(() => null)) as unknown
  const writes = writesOf(body)
  if (!writes) {
    return fail(
      c,
      400,
      "invalid_body",
      "Body must be { path, value } or { values: { path: value } }",
    )
  }
  const regs: Array<{ path: string; reg: RegisteredSettingsField; raw: unknown }> = []
  for (const [path, raw] of writes) {
    const reg = entry.fields[scope].get(path)
    if (!reg) {
      return fail(c, 404, "unknown_field", `"${path}" is not a ${scope} setting of ${app}`, path)
    }
    regs.push({ path, reg, raw })
  }
  if (regs.length > 1) {
    const sets = new Set(regs.map((r) => toolPair(r.reg)?.set ?? null))
    if (sets.size !== 1 || sets.has(null)) {
      return fail(
        c,
        400,
        "invalid_body",
        "Several values are saved together only for fields of one tool-backed section",
      )
    }
  }
  for (const { reg } of regs) {
    if (scope === "org" && !canAdminister(c, reg)) {
      return fail(c, 403, "forbidden", `Missing scope: ${reg.adminScope ?? "kernel:apps:admin"}`)
    }
  }
  const values: Array<{ path: string; reg: RegisteredSettingsField; value: unknown }> = []
  for (const { path, reg, raw } of regs) {
    const v = validated(reg, raw)
    if (!v.ok) return fail(c, 422, "invalid_field", v.message, path)
    values.push({ path, reg, value: v.value })
  }
  const [first] = values
  if (!first) return fail(c, 400, "invalid_body", "Nothing to save")
  const { path, reg, value } = first
  const kind = fieldSourceKind(reg.field)

  if (kind === "settings") {
    if (scope === "org") {
      await withPrivilegedDb(orgId, "app-settings-write-org", async (tx) => {
        await setOrgAppSettingPath(tx, orgId, app, splitPath(path), value)
        await tx.queueEvent(appSettingEvent(c, scope, path))
      })
    } else {
      await withRequestRls(c, async (tx) => {
        await setUserAppSettingPath(tx, userId, app, splitPath(path), value)
        await tx.queueEvent(appSettingEvent(c, scope, path))
      })
    }
    return success(c, { path, value })
  }

  if (kind === "config") {
    const check = checkAppConfigWriteForOrg(orgId, app, path, value)
    if (!check.ok) return fail(c, 422, "invalid_field", check.message, path)
    // writeAppConfigKey records the write's audit row itself (app_config_updated), so this
    // write emits no app_setting event: one PATCH, one audit row.
    await writeAppConfigKey({
      orgId,
      appName: app,
      key: path,
      value: check.value,
      actorId: userId ?? null,
      actorType: "user",
      source: "api",
    })
    return success(c, { path, value: check.value })
  }

  const pair = toolPair(reg)
  if (!pair) return fail(c, 500, "invalid_field", `"${path}" has no tool pair`, path)
  const waiting = await pendingApprovalOf(orgId, `${app}:${pair.set}`)
  if (waiting) {
    return fail(
      c,
      409,
      "approval_pending",
      "An earlier change to these settings is still waiting for approval. " +
        "Save again once it is approved or rejected.",
      path,
    )
  }
  const current = await runAppTool(c, pair.get, {})
  if (!current.ok) {
    if ("status" in current) return fail(c, current.status, current.code, current.message, path)
    return fail(c, 409, "pending", `${app}:${pair.get} is waiting for approval`, path)
  }
  let next: Record<string, unknown> = isRecord(current.data) ? current.data : {}
  // A clear reaches the set tool as an explicit null: dropping the key would read as
  // "unchanged" to a whole-object setter and the stored value would stay.
  for (const v of values) {
    next = withSettingAtPath(next, splitPath(v.path), v.value, { onNull: "keep" })
  }
  const paths = values.map((v) => v.path)
  const written = await runAppTool(c, pair.set, next)
  if (!written.ok) {
    if ("status" in written) return fail(c, written.status, written.code, written.message, path)
    const pending = { approvalRequestId: written.pending }
    return c.json({ data: values.length > 1 ? { paths, pending } : { path, pending } }, 202)
  }
  await withPrivilegedDb(orgId, "app-settings-tool-event", (tx) =>
    tx.queueEvent(appSettingEvent(c, scope, paths.join(","))),
  )
  if (values.length > 1) {
    const saved = Object.fromEntries(values.map((v) => [v.path, v.value]))
    return success(c, { paths, values: saved, result: written.data })
  }
  return success(c, { path, value, result: written.data })
}

appSettingsRoutes
  .get("/:app/settings/org", async (c) => {
    const entry = await settingsEntry(c)
    if (!entry) return noSettings(c)
    return success(c, await readValues(c, entry, "org"))
  })
  .patch("/:app/settings/org", async (c) => {
    const entry = await settingsEntry(c)
    if (!entry) return noSettings(c)
    return writeValue(c, entry, "org")
  })
  .get("/:app/settings/user", async (c) => {
    const entry = await settingsEntry(c)
    if (!entry) return noSettings(c)
    return success(c, await readValues(c, entry, "user"))
  })
  .patch("/:app/settings/user", async (c) => {
    const entry = await settingsEntry(c)
    if (!entry) return noSettings(c)
    return writeValue(c, entry, "user")
  })
