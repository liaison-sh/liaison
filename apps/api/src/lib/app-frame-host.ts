// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App screens on an origin of their own (LIAISON_APP_FRAME_ORIGIN_TEMPLATE).
//
// With the template set (`https://{app}--{org}.example-usercontent.com`), a
// browser tab frames an outside app's interface from the host `<app>--<org
// slug>` on that domain, instead of the opaque sandbox: the app gets a real
// origin of its own (its own storage, one per app and org), and still no
// network, no session and no API (the frame policy keeps `connect-src 'none'`;
// every call goes through the page, which answers it for that app only).
//
// A host that matches the template is an `app-frame` host whatever the org
// template says (lib/org-host.ts resolves it first). Such a host serves the frame
// document of its app, for its org, and nothing else: no web app, no API, no
// sign-in, no socket, no cookie read or set.
//
// Naming: exactly one placeholder label `{app}--{org}`. An app name never holds
// `--` (the manifest refuses it), and the label splits on its LAST `--`. An org
// slug may hold `--`; such an org's apps keep the opaque frame (the split, and the
// edge router's `*--<slug>`, would be ambiguous), as does a label over 63
// characters, which cannot be a host. Both are logged where the URL is minted.

import { env } from "~/lib/env"

/** A DNS label. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const APP_NAME = /^[a-z][a-z0-9-]*$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_LABEL = 63

let parsedFor: string | undefined
let parsed: { re: RegExp; scheme: string; before: string; after: string } | null = null

function frameMatcher(
  template: string | undefined = env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE,
): { re: RegExp; scheme: string; before: string; after: string } | null {
  if (!template) return null
  if (parsedFor === template && parsed) return parsed
  const url = new URL(template.replace("{app}--{org}", "app--org"))
  const hostTemplate = template.slice(`${url.protocol}//`.length).toLowerCase()
  const [before, after] = hostTemplate.split("{app}--{org}") as [string, string]
  const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const result = {
    re: new RegExp(`^${quote(before)}(${LABEL})${quote(after)}$`),
    scheme: url.protocol,
    before,
    after,
  }
  if (template === env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE) {
    parsed = result
    parsedFor = template
  }
  return result
}

/** Whether app screens have origins of their own on this deployment. */
export function appFrameOriginsEnabled(): boolean {
  return Boolean(env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE)
}

/** Split a frame label on its last `--`: the app and the org slug, or null. */
export function splitFrameLabel(label: string): { app: string; slug: string } | null {
  const at = label.lastIndexOf("--")
  if (at <= 0) return null
  const app = label.slice(0, at)
  const slug = label.slice(at + 2)
  if (!APP_NAME.test(app) || app.includes("--") || !SLUG.test(slug) || slug.includes("--")) {
    return null
  }
  return { app, slug }
}

/** The app and org slug a host names under the frame template, or null when it is no frame host. */
export function appFrameHostOf(
  host: string | null,
  template?: string,
): { app: string; slug: string } | null {
  const matcher = frameMatcher(template)
  if (!matcher || !host) return null
  const m = matcher.re.exec(host.toLowerCase())
  const label = m?.[1]
  return label ? splitFrameLabel(label) : null
}

/**
 * The frame host (with port, lowercase) of `app` for the org with `slug`, or null
 * when there is no template, the names cannot form one label, or the label is
 * longer than a host label may be (the caller keeps the opaque frame then).
 */
export function appFrameHostFor(app: string, slug: string): string | null {
  const matcher = frameMatcher()
  if (!matcher) return null
  if (!APP_NAME.test(app) || app.includes("--") || !SLUG.test(slug) || slug.includes("--")) {
    return null
  }
  const label = `${app}--${slug}`
  if (label.length > MAX_LABEL) return null
  return `${matcher.before}${label}${matcher.after}`
}

/** The frame origin (`https://<app>--<slug>.<domain>`) of a frame host. */
export function appFrameOriginOf(host: string): string {
  const matcher = frameMatcher()
  return `${matcher?.scheme ?? "https:"}//${host}`
}

/**
 * The first-party apps a browser tab frames on their own origin
 * (LIAISON_FRAMED_APPS), only while the frame template is set.
 */
export function framedFirstPartyApps(): ReadonlySet<string> {
  if (!appFrameOriginsEnabled()) return new Set()
  return new Set(
    (env.LIAISON_FRAMED_APPS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => APP_NAME.test(name)),
  )
}

/** The path the frame document is served at on a frame host: `/frame/<version>`. */
export const APP_FRAME_HOST_PATH = /^\/frame\/(\d+\.\d+\.\d+(?:-[\w.]+)?)$/

/** A source the page's `frame-src` names for every frame host (`https://*.<domain>`), or null. */
export function appFrameSource(): string | null {
  const matcher = frameMatcher()
  if (!matcher) return null
  // A wildcard covers exactly one label, the frame label (`*.apps.example.com`). A
  // template whose label is not the first (`x.{app}--{org}.example.com`) cannot be
  // named by a CSP wildcard: no frame source then, and the boot check refuses it.
  if (matcher.before !== "") return null
  return `${matcher.scheme}//*${matcher.after}`
}

// ─── Boot checks ────────────────────────────────────────────────────────────

type RawEnv = Record<string, string | undefined>

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Problems with the frame template on this deployment: `refuse` stops the boot,
 * `warn` is logged. The frame origin must not share a site with the app's own
 * (cookies of the page's site would reach code that runs there) and must never
 * match a host the org template or BASE_URL names.
 */
export function appFrameTemplateProblems(
  raw: RawEnv,
  registrable: (domain: string) => string,
): { refuse: string[]; warn: string[] } {
  const refuse: string[] = []
  const warn: string[] = []
  const template = raw.LIAISON_APP_FRAME_ORIGIN_TEMPLATE?.trim()
  if (!template) return { refuse, warn }
  const managed = raw.LIAISON_EDITION === "managed"
  const orgTemplate = raw.LIAISON_ORG_HOST_TEMPLATE?.trim() || undefined
  const matcher = (() => {
    try {
      return frameMatcher(template)
    } catch {
      return null
    }
  })()
  if (!matcher) {
    refuse.push("LIAISON_APP_FRAME_ORIGIN_TEMPLATE is not an http(s) origin holding {app}--{org}")
    return { refuse, warn }
  }
  if (matcher.before !== "") {
    refuse.push(
      "LIAISON_APP_FRAME_ORIGIN_TEMPLATE must start its host with the {app}--{org} label (https://{app}--{org}.example-usercontent.com)",
    )
  }
  if (managed && !orgTemplate) {
    refuse.push(
      "LIAISON_APP_FRAME_ORIGIN_TEMPLATE needs LIAISON_ORG_HOST_TEMPLATE on a managed cell",
    )
  }
  const frameDomain = registrable(matcher.after.replace(/^\./, "").replace(/:\d+$/, ""))
  const same: string[] = []
  const baseHost = hostOf(raw.BASE_URL)
  if (baseHost && registrable(baseHost) === frameDomain) same.push("BASE_URL")
  const orgHost = hostOf(orgTemplate?.replace("{slug}", "slug"))
  if (orgHost && registrable(orgHost) === frameDomain) same.push("LIAISON_ORG_HOST_TEMPLATE")
  if (same.length > 0) {
    const message = `LIAISON_APP_FRAME_ORIGIN_TEMPLATE is on the same registrable domain (${frameDomain}) as ${same.join(" and ")}: app code would run same-site with the app's pages; use a domain of its own`
    if (managed) refuse.push(message)
    else warn.push(message)
  }
  // No host may be both: an org host shadowed by a frame host (or the reverse).
  if (orgTemplate) {
    const orgSample = orgTemplate.replace("{slug}", "aa--bb")
    const frameSample = template.replace("{app}--{org}", "aa--bb")
    const orgRe = (() => {
      const url = new URL(orgTemplate.replace("{slug}", "slug"))
      const hostTemplate = orgTemplate.slice(`${url.protocol}//`.length).toLowerCase()
      const [b, a] = hostTemplate.split("{slug}") as [string, string]
      const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      return new RegExp(`^${quote(b)}${LABEL}${quote(a)}$`)
    })()
    const frameHost = new URL(frameSample).host.toLowerCase()
    const orgSampleHost = new URL(orgSample).host.toLowerCase()
    if (orgRe.test(frameHost) || matcher.re.test(orgSampleHost)) {
      refuse.push(
        "LIAISON_APP_FRAME_ORIGIN_TEMPLATE and LIAISON_ORG_HOST_TEMPLATE can name the same host",
      )
    }
  }
  if (baseHost) {
    const base = new URL(raw.BASE_URL as string).host.toLowerCase()
    if (matcher.re.test(base)) {
      refuse.push("BASE_URL is a host LIAISON_APP_FRAME_ORIGIN_TEMPLATE names")
    }
  }
  return { refuse, warn }
}
