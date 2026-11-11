// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every sandboxed entry point an app manifest declares, as `<kind>:<name>`
// with the export it runs and its row of the limit table (run-limits.ts).
// Kinds follow the manifest: tools (handler, preflight, summarizer,
// pollHandler, reconcileHandler), event subscriptions, jobs, webhooks (handler
// and verifier), search, export, the attention provider, import kinds,
// connection before-disconnect hooks and PDF templates.

import type { RunEntryKind } from "~/modules/apps/run-limits"

export interface ContractEntry {
  /** `<kind>:<name>`, unique within the app. */
  entry: string
  kind: RunEntryKind
  exportName: string
  /** The wall clock the manifest declares for it, when its kind honours one. */
  declaredMs?: number
  /** A PDF template's source file (relative to the app), run as its own bundle. */
  templateSource?: string
}

type Json = Record<string, unknown>

const asObject = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null
const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)

export function contractEntries(manifest: Json): ContractEntry[] {
  const out: ContractEntry[] = []
  const add = (e: ContractEntry) => out.push(e)

  // Tools: an object by name, or (older manifests) an array of tools with a `name`.
  const tools = manifest.tools
  const toolList: Array<[string, Json]> = Array.isArray(tools)
    ? tools.flatMap((t) => {
        const o = asObject(t)
        const name = o && asString(o.name)
        return o && name ? [[name, o] as [string, Json]] : []
      })
    : Object.entries(asObject(tools) ?? {}).flatMap(([name, t]) => {
        const o = asObject(t)
        return o ? [[name, o] as [string, Json]] : []
      })
  for (const [name, tool] of toolList) {
    const declaredMs = asNumber(tool.timeoutMs)
    const handler = asString(tool.handler)
    if (handler)
      add({
        entry: `tool:${name}`,
        kind: "tool",
        exportName: handler,
        ...(declaredMs ? { declaredMs } : {}),
      })
    const preflight = asString(tool.preflight)
    if (preflight) add({ entry: `preflight:${name}`, kind: "preflight", exportName: preflight })
    const summarizer = asString(tool.summarizer)
    if (summarizer) add({ entry: `summarizer:${name}`, kind: "summarizer", exportName: summarizer })
    const poll = asString(tool.pollHandler)
    if (poll) add({ entry: `poll:${name}`, kind: "poll", exportName: poll })
    const reconcile = asString(tool.reconcileHandler)
    if (reconcile) add({ entry: `reconcile:${name}`, kind: "reconcile", exportName: reconcile })
  }

  const subscribes = asObject(asObject(manifest.events)?.subscribes) ?? {}
  for (const [topic, ref] of Object.entries(subscribes)) {
    const exportName = asString(ref) ?? asString(asObject(ref)?.handler)
    if (exportName) add({ entry: `event:${topic}`, kind: "event", exportName })
  }

  for (const [name, job] of Object.entries(asObject(manifest.jobs) ?? {})) {
    const o = asObject(job)
    const exportName = o && asString(o.handler)
    const declaredMs = o ? asNumber(o.timeoutMs) : undefined
    if (exportName)
      add({ entry: `job:${name}`, kind: "job", exportName, ...(declaredMs ? { declaredMs } : {}) })
  }

  for (const [name, hook] of Object.entries(asObject(manifest.webhooks) ?? {})) {
    const o = asObject(hook)
    if (!o) continue
    const declaredMs = asNumber(o.timeoutMs)
    const handler = asString(o.handler)
    if (handler)
      add({
        entry: `webhook:${name}`,
        kind: "webhook",
        exportName: handler,
        ...(declaredMs ? { declaredMs } : {}),
      })
    const verify = asString(o.verify)
    if (verify) add({ entry: `webhook-verify:${name}`, kind: "webhook-verify", exportName: verify })
  }

  const search = asObject(manifest.search)
  const searchHandler = search && asString(search.handler)
  if (search && searchHandler) {
    const declaredMs = asNumber(search.timeoutMs)
    add({
      entry: "search:search",
      kind: "search",
      exportName: searchHandler,
      ...(declaredMs ? { declaredMs } : {}),
    })
  }

  const exportHandler = asString(asObject(manifest.export)?.handler)
  if (exportHandler) add({ entry: "export:export", kind: "export", exportName: exportHandler })

  const attention = asString(asObject(asObject(manifest.views)?.attentionItems)?.handler)
  if (attention) add({ entry: "attention:attention", kind: "attention", exportName: attention })

  for (const [kindName, def] of Object.entries(asObject(asObject(manifest.import)?.kinds) ?? {})) {
    const exportName = asString(asObject(def)?.handler)
    if (exportName) add({ entry: `import:${kindName}`, kind: "import", exportName })
  }

  for (const [conn, def] of Object.entries(asObject(manifest.connections) ?? {})) {
    const exportName = asString(asObject(def)?.beforeDisconnect)
    if (exportName) add({ entry: `disconnect:${conn}`, kind: "disconnect", exportName })
  }

  const templates = Array.isArray(manifest.pdf_templates) ? manifest.pdf_templates : []
  for (const t of templates) {
    const o = asObject(t)
    const kind = o && asString(o.kind)
    const source = o && asString(o.source)
    if (kind && source) {
      add({
        entry: `pdf-template:${kind}`,
        kind: "pdf-template",
        exportName: "renderTemplate",
        templateSource: source,
      })
    }
  }
  return out
}
