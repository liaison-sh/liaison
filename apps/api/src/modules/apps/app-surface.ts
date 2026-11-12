// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What an app declares for the platform to serve and run on its behalf, outside
// tools and jobs: its pages and the routes they call (app-pages.ts), and its
// org-level setup as data (app-provisioning.ts). Every app declares these the
// same way in its manifest, in-tree, bundled or installed: there is no host-code
// hook behind any of them.
//
// Registered per (org, app) at app registration (runtime.ts), with the bundle
// the handlers live in and the package directory the page scripts are read from.

import { dirname } from "node:path"
import { createTypedRegistry } from "~/modules/apps/registries"

export interface AppPageHosts {
  script?: string[]
  frame?: string[]
  connect?: string[]
  image?: string[]
  style?: string[]
}

export interface AppPageDecl {
  /** `pages/<name>.ts` in the app's source; the package carries `pages/<name>.js`. */
  source: string
  title?: string
  /** The scope a person must hold to open the page (and to call its routes). */
  scope: string
  /** The routes (manifest `pageRoutes`) the page may call. */
  routes?: string[]
  hosts?: AppPageHosts
  /**
   * The page receives the access token of one oauth2 account of this
   * connection (`liaisonPage.connectionToken`), for a provider widget that
   * runs in the person's browser with their own grant (a file picker). The
   * account is the link's `params.account`: the person's own, or the
   * organization's when they hold the connection's admin scope.
   */
  connectionToken?: { connection: string }
}

export interface AppRouteDecl {
  handler: string
  /** A scope the person must hold for this route, on top of the page's. */
  scope?: string
}

export interface AppProvisioningDecl {
  /** JSON Schema of the `apps[].provision` block. */
  schema: Record<string, unknown>
  /** Handler run with `{ config, dryRun }`, answering `{ changed: string[] }`. */
  handler: string
  /** Optional handler run by `config verify`, answering `{ ok, problems?, identity? }`. */
  verify?: string
}

export interface AppSurface {
  appName: string
  version: string
  /** The handler bundle (in-tree: its source entry; installed: `bundle.js`). */
  bundlePath: string
  /** Platform code: may run in-process. A sandboxed app (`trusted: false`) never does. */
  trusted: boolean
  /** Where `pages/<name>.js` (or its `.ts` source) is read from. */
  packageDir: string
  pages: Record<string, AppPageDecl>
  routes: Record<string, AppRouteDecl>
  provisioning: AppProvisioningDecl | null
}

/** [orgId, appName] -> what the app serves and runs through the platform. */
export const appSurfaceRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  AppSurface
>()

interface SurfaceManifest {
  name: string
  version: string
  trusted?: boolean
  pages?: Record<string, AppPageDecl>
  pageRoutes?: Record<string, AppRouteDecl>
  provisioning?: AppProvisioningDecl
}

/** The surface of a manifest-format app, or null when it declares none of it. */
export function buildAppSurface(desc: SurfaceManifest, bundlePath: string): AppSurface | null {
  const pages = desc.pages ?? {}
  const routes = desc.pageRoutes ?? {}
  const provisioning = desc.provisioning ?? null
  if (Object.keys(pages).length === 0 && Object.keys(routes).length === 0 && !provisioning) {
    return null
  }
  return {
    appName: desc.name,
    version: desc.version,
    bundlePath,
    trusted: desc.trusted !== false,
    packageDir: dirname(bundlePath),
    pages,
    routes,
    provisioning,
  }
}

/** Cross-field checks of `pages`, `pageRoutes`, `provisioning` and `connections.*.oauthClient`. */
export function appSurfaceErrors(manifest: {
  name?: unknown
  scopes?: unknown
  pages?: Record<string, AppPageDecl>
  pageRoutes?: Record<string, AppRouteDecl>
  provisioning?: AppProvisioningDecl
  connections?: Record<string, { type?: string; oauthClient?: { key?: string } }>
}): string[] {
  const errors: string[] = []
  const name = typeof manifest.name === "string" ? manifest.name : ""
  const routes = manifest.pageRoutes ?? {}
  for (const [pageName, page] of Object.entries(manifest.pages ?? {})) {
    if (page.source !== `pages/${pageName}.ts`) {
      errors.push(`pages.${pageName}.source: must be "pages/${pageName}.ts"`)
    }
    if (!page.scope.startsWith(`${name}:`)) {
      errors.push(`pages.${pageName}.scope: must be one of the app's own scopes (${name}:...)`)
    }
    const tokenConn = page.connectionToken?.connection
    if (tokenConn !== undefined && manifest.connections?.[tokenConn]?.type !== "oauth2") {
      errors.push(`pages.${pageName}.connectionToken: "${tokenConn}" is not an oauth2 connection`)
    }
    for (const route of page.routes ?? []) {
      if (!routes[route])
        errors.push(`pages.${pageName}.routes: "${route}" is not a declared pageRoute`)
    }
  }
  for (const [routeName, route] of Object.entries(routes)) {
    if (route.scope && !route.scope.startsWith(`${name}:`)) {
      errors.push(
        `pageRoutes.${routeName}.scope: must be one of the app's own scopes (${name}:...)`,
      )
    }
  }
  const schemaType = manifest.provisioning?.schema?.type
  if (manifest.provisioning && schemaType !== "object") {
    errors.push(`provisioning.schema: must describe an object ("type": "object")`)
  }
  for (const [connName, conn] of Object.entries(manifest.connections ?? {})) {
    const key = conn?.oauthClient?.key
    if (key === undefined) continue
    if (conn.type !== "oauth2") {
      errors.push(`connections.${connName}.oauthClient: only an oauth2 connection has a client`)
    }
    if (!key.startsWith(`${name}:`)) {
      errors.push(
        `connections.${connName}.oauthClient.key: must be in the app's own namespace (${name}:<name>)`,
      )
    }
  }
  return errors
}
