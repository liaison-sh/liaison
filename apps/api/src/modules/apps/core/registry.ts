// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Core apps whose handlers are server code. A core app's handler module
// (`apps/<name>/handlers.ts`) is an ordinary TypeScript module: every handler
// its manifest names (tools, preflights, jobs, event handlers, webhooks and
// their verifiers, the export, the attention provider) is a named export
// `(params, ctx, ...extra)`, imported and called in this process (run-core.ts).
// It never goes through a sandbox, a ctx shim or a bundle transform.
//
// The module is found by the app's name AND the bundle path its descriptor
// declares (`_bundlePath`), so nothing installed under a core app's name can
// reach it. A core app not listed here still runs as a bundle; it moves by
// adding its row (docs/backend-overview.md, "Core apps (server code)").
//
// This file is a leaf (no imports): the bundle loader reads it.

/** One core app's server module: where its descriptor points, and how to import it. */
export interface CoreAppModule {
  /** The absolute path the app's descriptor declares as `_bundlePath`. */
  modulePath: string
  load: () => Promise<Record<string, unknown>>
}

const appsDir = (rel: string): string => new URL(`../../../apps/${rel}`, import.meta.url).pathname

export const CORE_APP_MODULES: Readonly<Record<string, CoreAppModule>> = {
  calendar: {
    modulePath: appsDir("calendar/handlers.ts"),
    load: () => import("~/apps/calendar/handlers"),
  },
  mail: {
    modulePath: appsDir("mail/handlers.ts"),
    load: () => import("~/apps/mail/handlers"),
  },
  projects: {
    modulePath: appsDir("projects/handlers.ts"),
    load: () => import("~/apps/projects/handlers"),
  },
  tickets: {
    modulePath: appsDir("tickets/handlers.ts"),
    load: () => import("~/apps/tickets/handlers"),
  },
  "mcp-manager": {
    modulePath: appsDir("mcp-manager/handlers.ts"),
    load: () => import("~/apps/mcp-manager/handlers"),
  },
}

/** The core module that runs `appName`'s handlers from `bundlePath`, or null (a bundle). */
export function coreModuleFor(
  appName: string,
  bundlePath: string | undefined,
): CoreAppModule | null {
  const mod = Object.hasOwn(CORE_APP_MODULES, appName) ? CORE_APP_MODULES[appName] : undefined
  return mod && bundlePath === mod.modulePath ? mod : null
}

/** Whether `bundlePath` is a core app's server module (never transpiled as a bundle). */
export function isCoreModulePath(bundlePath: string): boolean {
  for (const mod of Object.values(CORE_APP_MODULES)) {
    if (mod.modulePath === bundlePath) return true
  }
  return false
}

/**
 * What `loadBundle` answers for a core module's path. Sites that load a bundle
 * before calling `runApp` get this text instead of a transpiled bundle;
 * `runApp` runs the module and never reads it.
 */
export const CORE_MODULE_SOURCE = "/* core app module: runs as server code, not a bundle */"
