// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Manifest `settings` JSON → zod. The declarative settings page (app-sdk
 * `app-settings.ts`) names typed fields; the kernel validates every write
 * against the field's type and `validation` with the schema built here, so a
 * bundled or installed app gets the same checks as an in-tree one.
 *
 * Built-in composite types reuse the shared schemas: `schedule` is the weekly
 * hours of `businessHoursSchema`, `dates` its holiday list, `duration` a
 * positive whole number of seconds.
 */

import {
  type AppSettingsSchema,
  DEFAULT_SETTINGS_ADMIN_SCOPE,
  fieldSourceKind,
  type SettingsField,
  type SettingsListCreateField,
  type SettingsSection,
} from "@liaison/app-sdk"
import { businessHoursSchema } from "@liaison/shared"
import { z } from "zod"
import { manifestRegExp } from "~/lib/manifest-regex"
import { isUnsafePathSegment } from "~/lib/safe-path"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day written `YYYY-MM-DD` (rejects 2026-02-30). */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

const calendarDate = z.string().refine(isCalendarDate, "must be a date written YYYY-MM-DD")

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function boundedString(field: SettingsListCreateField): z.ZodType<string> {
  let s = z.string()
  const v = field.validation
  if (v?.min !== undefined) s = s.min(v.min)
  if (v?.max !== undefined) s = s.max(v.max)
  if (v?.pattern !== undefined) s = s.regex(manifestRegExp(v.pattern), `must match ${v.pattern}`)
  if (v?.required) s = s.min(Math.max(1, v.min ?? 1), "is required")
  return s
}

function boundedNumber(base: z.ZodNumber, field: SettingsListCreateField): z.ZodNumber {
  let n = base
  const v = field.validation
  if (v?.min !== undefined) n = n.min(v.min)
  if (v?.max !== undefined) n = n.max(v.max)
  return n
}

/**
 * The schema one value of `field` must satisfy. `null` clears the value and is
 * accepted unless the field is `validation.required`.
 */
export function fieldValueSchema(field: SettingsListCreateField): z.ZodType<unknown> {
  let schema: z.ZodType<unknown>
  const optionValues = field.options?.map((o) => o.value)
  const optionValue: z.ZodType<string | number> =
    optionValues && optionValues.length > 0
      ? z.union([z.string(), z.number()]).refine((v) => optionValues.includes(v), {
          message: `must be one of ${optionValues.map((v) => JSON.stringify(v)).join(", ")}`,
        })
      : z.union([z.string(), z.number()])
  switch (field.type) {
    case "text":
    case "textarea":
      schema = boundedString(field)
      break
    case "url":
      schema = boundedString(field).refine(isHttpUrl, "must be an http or https URL")
      break
    case "email":
      schema = boundedString(field).refine(
        (v) => z.email().safeParse(v).success,
        "must be an email address",
      )
      break
    case "number":
      schema = boundedNumber(z.number(), field)
      break
    case "duration":
      schema = boundedNumber(z.number().int().positive(), field)
      break
    case "toggle":
      schema = z.boolean()
      break
    case "select":
      schema = optionValue
      break
    case "multiselect":
      // A multiselect holds each option at most once.
      schema = z
        .array(optionValue)
        .max(optionValues && optionValues.length > 0 ? optionValues.length : 1000)
      break
    case "date":
      schema = calendarDate
      break
    case "dates":
      schema = businessHoursSchema.shape.holidays.refine(
        (days) => days.every((d) => isCalendarDate(d.date)),
        "every date must be written YYYY-MM-DD",
      )
      break
    case "schedule":
      schema = businessHoursSchema.shape.weekly
      break
  }
  return field.validation?.required ? schema : schema.nullable()
}

/** Problems with a field's declared `default` (empty when it fits the type). */
export function fieldDefaultErrors(at: string, field: SettingsListCreateField): string[] {
  if (field.default === undefined) return []
  const r = fieldValueSchema(field).safeParse(field.default)
  if (r.success) return []
  return [`${at}.default: ${r.error.issues[0]?.message ?? "does not fit the field type"}`]
}

/** One field of the page, with the section that declares it. */
export interface RegisteredSettingsField {
  field: SettingsField
  section: SettingsSection
  /** The scope that guards it: the section's adminScope (org), or null (user). */
  adminScope: string | null
  validator: z.ZodType<unknown>
}

/** What the runtime keeps per app from its manifest `settings`. */
export interface ManifestSettingsEntry {
  /** Sections with `adminScope` materialised (org sections default to kernel:apps:admin). */
  sections: SettingsSection[]
  /** Fields by scope and key. */
  fields: { org: Map<string, RegisteredSettingsField>; user: Map<string, RegisteredSettingsField> }
}

/** The app's manifest `connections`, for their admin scopes. */
export interface ManifestConnectionsInfo {
  app: string
  connections?: Record<string, { adminScope?: string } | undefined>
}

/**
 * The scope that administers one manifest connection for the org: its own
 * `adminScope`, else `<app>:accounts:admin`. The one derivation, shared by the
 * connections routes (connections/admin-scope.ts), the settings sections below
 * and the offline scope registry (permissions/scope-registry.ts).
 */
export function connectionAdminScopeOf(
  appName: string,
  connection: { adminScope?: string } | undefined,
): string {
  return connection?.adminScope ?? `${appName}:accounts:admin`
}

/**
 * The scope the server enforces on the connections an org section shows, when
 * the section holds nothing but connections blocks and those connections share
 * one (connections/admin-scope.ts: the manifest's, else `<app>:accounts:admin`).
 * Null otherwise.
 */
function connectionsSectionScope(
  section: SettingsSection,
  info: ManifestConnectionsInfo | undefined,
): string | null {
  if (!info?.connections || section.blocks.length === 0) return null
  const all = Object.keys(info.connections)
  const names = new Set<string>()
  for (const b of section.blocks) {
    if (b.block !== "connections") return null
    for (const n of b.names ?? all) names.add(n)
  }
  const scopes = new Set(
    [...names].map((n) => connectionAdminScopeOf(info.app, info.connections?.[n])),
  )
  const [only] = scopes
  return scopes.size === 1 && only ? only : null
}

/**
 * Sections with an admin scope on every org section that names none: the scope
 * of its connections for a section that only shows connections (the one the
 * connections routes enforce, so whoever may act on them sees the card), else
 * kernel:apps:admin.
 */
export function materialiseSections(
  settings: AppSettingsSchema,
  connections?: ManifestConnectionsInfo,
): SettingsSection[] {
  return settings.sections.map((s) =>
    s.scope === "org" && s.adminScope === undefined
      ? {
          ...s,
          adminScope: connectionsSectionScope(s, connections) ?? DEFAULT_SETTINGS_ADMIN_SCOPE,
        }
      : s,
  )
}

export function buildManifestSettingsEntry(
  settings: AppSettingsSchema,
  connections?: ManifestConnectionsInfo,
): ManifestSettingsEntry {
  const sections = materialiseSections(settings, connections)
  const fields = {
    org: new Map<string, RegisteredSettingsField>(),
    user: new Map<string, RegisteredSettingsField>(),
  }
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.block !== "field") continue
      fields[section.scope].set(block.key, {
        field: block,
        section,
        adminScope: section.scope === "org" ? (section.adminScope ?? null) : null,
        validator: fieldValueSchema(block),
      })
    }
  }
  return { sections, fields }
}

/**
 * A field key split on dots. Refuses segments that reach the object machinery
 * (`constructor.prototype.x`): the trees below are built along these paths.
 */
function settingsKeyPath(key: string): string[] {
  const path = key.split(".")
  if (path.some(isUnsafePathSegment)) throw new Error(`unsafe settings field key '${key}'`)
  return path
}

type ObjectTree = { [key: string]: ObjectTree | z.ZodType<unknown> }

function treeToZod(tree: ObjectTree): z.ZodType<unknown> {
  const shape: Record<string, z.ZodType<unknown>> = {}
  for (const [k, v] of Object.entries(tree)) {
    shape[k] = (v instanceof z.ZodType ? v : treeToZod(v)).optional()
  }
  // Loose: values the page does not declare (older keys, keys a tool owns)
  // survive a read, so the sandbox bridge never loses data it does not model.
  return z.looseObject(shape)
}

/**
 * The namespace schema for the sandbox bridge (`getOrgSettings` /
 * `getUserSettings`), derived from the page's `settings`-source fields of one
 * scope: nested objects along each dot path, every key optional. Undefined
 * when the scope has no such field.
 */
export function namespaceSchemaFor(
  entry: ManifestSettingsEntry,
  scope: "org" | "user",
): z.ZodType<unknown> | undefined {
  const tree = Object.create(null) as ObjectTree
  let any = false
  for (const [key, reg] of entry.fields[scope]) {
    if (fieldSourceKind(reg.field) !== "settings") continue
    any = true
    const path = settingsKeyPath(key)
    let cur = tree
    for (let i = 0; i < path.length - 1; i++) {
      const next = Object.hasOwn(cur, path[i]) ? cur[path[i]] : undefined
      if (!next || next instanceof z.ZodType) cur[path[i]] = Object.create(null) as ObjectTree
      cur = cur[path[i]] as ObjectTree
    }
    cur[path[path.length - 1]] = reg.validator
  }
  return any ? treeToZod(tree) : undefined
}

/** Defaults the page declares for one scope's `settings` fields, as a nested object. */
export function namespaceDefaultsFor(
  entry: ManifestSettingsEntry,
  scope: "org" | "user",
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, reg] of entry.fields[scope]) {
    if (fieldSourceKind(reg.field) !== "settings" || reg.field.default === undefined) continue
    const path = settingsKeyPath(key)
    let cur = out
    for (let i = 0; i < path.length - 1; i++) {
      const next = Object.hasOwn(cur, path[i]) ? cur[path[i]] : undefined
      if (!next || typeof next !== "object" || Array.isArray(next)) cur[path[i]] = {}
      cur = cur[path[i]] as Record<string, unknown>
    }
    cur[path[path.length - 1]] = reg.field.default
  }
  return out
}
