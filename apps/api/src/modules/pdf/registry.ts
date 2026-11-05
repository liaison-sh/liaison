// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-memory PDF template registry. Templates are keyed by (appId, kind) →
// sandbox bundle source: every source is instance data (the active version's
// `apps_installed.pdf_templates`), so no org owns a template. The bundle is a
// self-contained module that sets `globalThis.renderTemplate`; the PDF renderer
// evaluates it INSIDE the QuickJS app sandbox (never as host code — there is no
// `new Function` host path) and replays the template's emitted draw-command
// list against pdf-lib on the host (see ./replay.ts and ./sandbox-render.ts).
//
// The registry is process-local and filled on demand: a render that misses
// loads the app's persisted templates (./registry-rehydrate.ts
// `loadAppTemplates`); an activation replaces one app's entries.

type Key = string

function key(appId: string, kind: string): Key {
  return `${appId}::${kind}`
}

const templates = new Map<Key, string>()

export function registerTemplate(appId: string, kind: string, source: string): void {
  templates.set(key(appId, kind), source)
}

export function getTemplate(appId: string, kind: string): string | undefined {
  return templates.get(key(appId, kind))
}

export function unregisterApp(appId: string): void {
  const prefix = `${appId}::`
  for (const k of templates.keys()) {
    if (k.startsWith(prefix)) templates.delete(k)
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const PdfRegistryTestAccess = {
  clear(): void {
    templates.clear()
  },
}
