// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every sandboxed entry point an app manifest declares, as `<kind>:<name>`
// with the export it runs and its row of the limit table (run-limits.ts).
// Kinds follow the manifest: tools (handler, preflight, summarizer,
// pollHandler, reconcileHandler), event subscriptions, jobs, webhooks (handler
// and verifier), search, export, the attention provider, import kinds,
// knowledge source kinds (their sync handler), knowledge items (search,
// resolve), connection before-disconnect
// hooks, PDF templates, the routes app pages call, and the provisioning
// handlers.

import type { RunEntryKind } from "~/modules/apps/run-limits"

export interface ContractEntry {
  /** `<tplKind>:<keyName>`, unique within the app. */
  entry: string
  kind: RunEntryKind
  exportName: string
  /** The wall clock the manifest declares for it, when its tplKind honours one. */
  declaredMs?: number
  /** A PDF template's sourcePath file (relative to the app), run as its own bundle. */
  templateSource?: string
}

type Json = Record<string, unknown>

function manifestObject(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null
}
function manifestString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}
function manifestNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
// Fields are read by key (never `obj.handler`): a manifest field named like a
// server function (`handler`, `preflight`) must not read as that function.
function fieldObject(o: Json | null | undefined, key: string): Json | null {
  return o ? manifestObject(o[key]) : null
}
function fieldString(o: Json | null | undefined, key: string): string | null {
  return o ? manifestString(o[key]) : null
}
function fieldNumber(o: Json | null | undefined, key: string): number | undefined {
  return o ? manifestNumber(o[key]) : undefined
}

export function contractEntries(manifest: Json): ContractEntry[] {
  const out: ContractEntry[] = []

  // Tools: an object by name, or (older manifests) an array of tools with a `name`.
  const toolsDecl = manifest.tools
  const toolList: Array<[string, Json]> = Array.isArray(toolsDecl)
    ? toolsDecl.flatMap((item) => {
        const obj = manifestObject(item)
        const keyName = obj && fieldString(obj, "name")
        return obj && keyName ? [[keyName, obj] as [string, Json]] : []
      })
    : Object.entries(manifestObject(toolsDecl) ?? {}).flatMap(([keyName, item]) => {
        const obj = manifestObject(item)
        return obj ? [[keyName, obj] as [string, Json]] : []
      })
  for (const [keyName, toolDef] of toolList) {
    const declaredMs = fieldNumber(toolDef, "timeoutMs")
    const handlerExport = fieldString(toolDef, "handler")
    if (handlerExport)
      out.push({
        entry: `tool:${keyName}`,
        kind: "tool",
        exportName: handlerExport,
        ...(declaredMs ? { declaredMs } : {}),
      })
    const preflightExport = fieldString(toolDef, "preflight")
    if (preflightExport)
      out.push({ entry: `preflight:${keyName}`, kind: "preflight", exportName: preflightExport })
    const summarizerExport = fieldString(toolDef, "summarizer")
    if (summarizerExport)
      out.push({ entry: `summarizer:${keyName}`, kind: "summarizer", exportName: summarizerExport })
    const pollExport = fieldString(toolDef, "pollHandler")
    if (pollExport) out.push({ entry: `poll:${keyName}`, kind: "poll", exportName: pollExport })
    const reconcileExport = fieldString(toolDef, "reconcileHandler")
    if (reconcileExport)
      out.push({ entry: `reconcile:${keyName}`, kind: "reconcile", exportName: reconcileExport })
  }

  const subscribes = fieldObject(fieldObject(manifest, "events"), "subscribes") ?? {}
  for (const [topicName, subscriber] of Object.entries(subscribes)) {
    const exportName =
      manifestString(subscriber) ?? fieldString(manifestObject(subscriber), "handler")
    if (exportName) out.push({ entry: `event:${topicName}`, kind: "event", exportName })
  }

  for (const [keyName, jobDef] of Object.entries(fieldObject(manifest, "jobs") ?? {})) {
    const obj = manifestObject(jobDef)
    const exportName = obj && fieldString(obj, "handler")
    const declaredMs = obj ? fieldNumber(obj, "timeoutMs") : undefined
    if (exportName)
      out.push({
        entry: `job:${keyName}`,
        kind: "job",
        exportName,
        ...(declaredMs ? { declaredMs } : {}),
      })
  }

  for (const [keyName, hookDef] of Object.entries(fieldObject(manifest, "webhooks") ?? {})) {
    const obj = manifestObject(hookDef)
    if (!obj) continue
    const declaredMs = fieldNumber(obj, "timeoutMs")
    const handlerExport = fieldString(obj, "handler")
    if (handlerExport)
      out.push({
        entry: `webhook:${keyName}`,
        kind: "webhook",
        exportName: handlerExport,
        ...(declaredMs ? { declaredMs } : {}),
      })
    const verify = fieldString(obj, "verify")
    if (verify)
      out.push({ entry: `webhook-verify:${keyName}`, kind: "webhook-verify", exportName: verify })
  }

  const searchDecl = fieldObject(manifest, "search")
  const searchHandler = searchDecl && fieldString(searchDecl, "handler")
  if (searchDecl && searchHandler) {
    const declaredMs = fieldNumber(searchDecl, "timeoutMs")
    out.push({
      entry: "search:search",
      kind: "search",
      exportName: searchHandler,
      ...(declaredMs ? { declaredMs } : {}),
    })
  }

  const exportHandler = fieldString(fieldObject(manifest, "export"), "handler")
  if (exportHandler) out.push({ entry: "export:export", kind: "export", exportName: exportHandler })

  const attentionExport = fieldString(
    fieldObject(fieldObject(manifest, "views"), "attentionItems"),
    "handler",
  )
  if (attentionExport)
    out.push({ entry: "attention:attention", kind: "attention", exportName: attentionExport })

  for (const [kindName, kindDef] of Object.entries(
    fieldObject(fieldObject(manifest, "import"), "kinds") ?? {},
  )) {
    const exportName = fieldString(manifestObject(kindDef), "handler")
    if (exportName) out.push({ entry: `import:${kindName}`, kind: "import", exportName })
  }

  for (const [kindName, kindDef] of Object.entries(
    fieldObject(manifest, "knowledgeSources") ?? {},
  )) {
    const obj = manifestObject(kindDef)
    const exportName = obj && fieldString(obj, "handler")
    const declaredMs = obj ? fieldNumber(obj, "timeoutMs") : undefined
    if (exportName)
      out.push({
        entry: `knowledge-sync:${kindName}`,
        kind: "knowledge-sync",
        exportName,
        ...(declaredMs ? { declaredMs } : {}),
      })
  }

  const items = fieldObject(manifest, "knowledgeItems")
  const itemsMs = fieldNumber(items, "timeoutMs")
  for (const key of ["search", "resolve"] as const) {
    const exportName = fieldString(items, key)
    if (exportName)
      out.push({
        entry: `knowledge-items:${key}`,
        kind: "search",
        exportName,
        ...(itemsMs ? { declaredMs: itemsMs } : {}),
      })
  }

  for (const [connName, kindDef] of Object.entries(fieldObject(manifest, "connections") ?? {})) {
    const exportName = fieldString(manifestObject(kindDef), "beforeDisconnect")
    if (exportName) out.push({ entry: `disconnect:${connName}`, kind: "disconnect", exportName })
  }

  for (const [routeName, routeDef] of Object.entries(fieldObject(manifest, "pageRoutes") ?? {})) {
    const exportName = fieldString(manifestObject(routeDef), "handler")
    if (exportName) out.push({ entry: `route:${routeName}`, kind: "route", exportName })
  }

  const provisioning = fieldObject(manifest, "provisioning")
  const provisionExport = fieldString(provisioning, "handler")
  if (provisionExport) {
    out.push({ entry: "provision:handler", kind: "provision", exportName: provisionExport })
  }
  const verifyExport = fieldString(provisioning, "verify")
  if (verifyExport) {
    out.push({ entry: "provision:verify", kind: "provision", exportName: verifyExport })
  }

  const templateDecls = Array.isArray(manifest.pdf_templates) ? manifest.pdf_templates : []
  for (const item of templateDecls) {
    const obj = manifestObject(item)
    const tplKind = obj && fieldString(obj, "kind")
    const sourcePath = obj && fieldString(obj, "source")
    if (tplKind && sourcePath) {
      out.push({
        entry: `pdf-template:${tplKind}`,
        kind: "pdf-template",
        exportName: "renderTemplate",
        templateSource: sourcePath,
      })
    }
  }
  return out
}
