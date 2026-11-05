// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison config pull --config <path> [--out <path>] [--only <path>...]`:
 * bring changes made in the product (the UI, an agent) back into the config
 * file. Reads the server's current value of every drift-tracked path the file
 * sets (`drift.ts`) and rewrites just those values, keeping the file's layout,
 * its comments (YAML) and every `${VAR}` reference as written. Secrets are
 * never tracked, so pull never writes one into the file.
 *
 * Read only on the server: pull changes no row and no last-applied record. A
 * `config apply` of the pulled file then reports every pulled path unchanged.
 */

import { readFileSync } from "node:fs"
import { extname } from "node:path"
import { parseDocument } from "yaml"
import {
  getAt,
  hashValue,
  indexPath,
  inScope,
  normalize,
  type TrackedField,
  trackedFields,
} from "~/cli/config/drift"
import { readServerConfig } from "~/cli/config/drift-state"
import { interpolateEnvLenient } from "~/cli/config/parse"
import {
  buildProvisionContext,
  type ProvisionDbSeams,
  resolvePlanOrgId,
} from "~/cli/provisioners/types"
import { isRecord } from "~/lib/guards"

export interface RunConfigPullOptions {
  configPath: string
  only?: string[]
  log?: (msg: string) => void
  seams?: ProvisionDbSeams
  env?: Record<string, string | undefined>
}

export interface RunConfigPullResult {
  exitCode: number
  /** The updated file content (absent on an error). */
  text?: string
  /** The paths whose value was rewritten from the server. */
  updated: string[]
}

function hasEnvRef(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${")
  if (Array.isArray(value)) return value.some(hasEnvRef)
  if (isRecord(value)) return Object.values(value).some(hasEnvRef)
  return false
}

/** One edit: set `value` at `path`, or remove the key when `value` is undefined. */
interface Edit {
  path: Array<string | number>
  value: unknown
}

/** The edits that make the file hold the server's value of `field`. */
function editsFor(
  field: TrackedField,
  path: Array<string | number>,
  fileValue: unknown,
  server: unknown,
): Edit[] {
  switch (field.kind) {
    case "role": {
      if (!isRecord(server)) return []
      const edits: Edit[] = [{ path: [...path, "scopes"], value: server.scopes ?? [] }]
      if (isRecord(fileValue) && "description" in fileValue) {
        edits.push({
          path: [...path, "description"],
          value: typeof server.description === "string" ? server.description : undefined,
        })
      }
      return edits
    }
    case "appEnable":
      return [{ path, value: server === true }]
    default:
      if (server === undefined || server === null) {
        return [{ path, value: field.nullable ? null : undefined }]
      }
      return [{ path, value: server }]
  }
}

function setByIndex(root: unknown, path: Array<string | number>, value: unknown): void {
  let cur: unknown = root
  for (const step of path.slice(0, -1)) {
    if (Array.isArray(cur) && typeof step === "number") cur = cur[step]
    else if (isRecord(cur) && typeof step === "string") cur = cur[step]
    else return
  }
  const last = path[path.length - 1]
  if (isRecord(cur) && typeof last === "string") {
    if (value === undefined) delete cur[last]
    else cur[last] = value
  }
}

export async function runConfigPull(opts: RunConfigPullOptions): Promise<RunConfigPullResult> {
  const log = opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const only = opts.only ?? []
  let text: string
  try {
    text = readFileSync(opts.configPath, "utf8")
  } catch (err) {
    log(
      `config pull: cannot read '${opts.configPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
    return { exitCode: 2, updated: [] }
  }
  const isJson = extname(opts.configPath).toLowerCase() === ".json"
  const doc = isJson ? null : parseDocument(text)
  if (doc && doc.errors.length > 0) {
    log(`config pull: '${opts.configPath}' is not valid YAML: ${doc.errors[0]?.message ?? ""}`)
    return { exitCode: 2, updated: [] }
  }
  let raw: unknown
  try {
    raw = doc ? doc.toJS() : JSON.parse(text)
  } catch (err) {
    log(
      `config pull: '${opts.configPath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { exitCode: 2, updated: [] }
  }
  const resolved = interpolateEnvLenient(raw, opts.env)
  const org = isRecord(resolved) ? resolved.org : undefined
  const slug = isRecord(org) && typeof org.slug === "string" ? org.slug : ""
  if (!slug || slug.includes("${")) {
    log("config pull: org.slug is missing or names an unset variable")
    return { exitCode: 2, updated: [] }
  }

  const ctx = buildProvisionContext({ log, validateByok: false, seams: opts.seams })
  const orgId = await resolvePlanOrgId(ctx, slug, "cli-config-pull-org")
  if (!orgId) {
    log(`config pull: no org '${slug}' on this server`)
    return { exitCode: 1, updated: [] }
  }
  ctx.orgId = orgId
  const server = await readServerConfig(ctx, resolved)

  const updated: string[] = []
  for (const field of trackedFields(resolved)) {
    if (!inScope(field.path, only)) continue
    const rawValue = getAt(raw, field.loc)
    // An env reference stays a reference (and a secret is never tracked).
    if (hasEnvRef(rawValue)) continue
    if (getAt(server, field.loc.slice(0, -1)) === undefined) {
      log(`config pull: ${field.path}: not on the server, left as written`)
      continue
    }
    const fileValue = getAt(resolved, field.loc)
    const serverValue = getAt(server, field.loc)
    if (field.kind === "role" && serverValue === undefined) {
      log(`config pull: ${field.path}: role not on the server, left as written`)
      continue
    }
    if (
      hashValue(normalize(field, fileValue, fileValue)) ===
      hashValue(normalize(field, serverValue, fileValue))
    ) {
      continue
    }
    const path = indexPath(raw, field.loc)
    if (!path) continue
    for (const edit of editsFor(field, path, fileValue, serverValue)) {
      if (doc) {
        if (edit.value === undefined) doc.deleteIn(edit.path)
        else doc.setIn(edit.path, doc.createNode(edit.value))
      } else {
        setByIndex(raw, edit.path, edit.value)
      }
    }
    updated.push(field.path)
  }
  for (const path of updated) log(`pulled ${path}`)
  if (updated.length === 0) log("config pull: the file already matches the server")
  const out = doc ? doc.toString() : `${JSON.stringify(raw, null, 2)}\n`
  return { exitCode: 0, text: out, updated }
}
