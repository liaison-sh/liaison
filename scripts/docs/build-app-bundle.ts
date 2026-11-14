// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Help tab's copy of the user docs (`bun run scripts/docs/build-app-bundle.ts --out <dir>`).
 *
 * Renders the same pages as the site (./build.ts, renderDocs) and writes them in the format of
 * packages/shared/src/help-docs.ts: `index.json`, `pages/<url>.json`, `assets/`. apps/web's
 * help-docs Vite plugin runs it into `apps/web/public/help-docs/`, so every web, desktop and
 * phone build carries the docs of its own version and reads them offline.
 *
 * Lenient on purpose: a broken link or a missing page prints a warning and never fails the app
 * build (`bun run check:docs` is the gate that fails on them).
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { LANDING, NAV, type NavSection } from "../../docs/nav"
import type { HelpDocsIndex, HelpDocsPage } from "../../packages/shared/src/help-docs"
import { decodeEntities, htmlToText, type RenderedPage, renderDocs } from "./build"
import { escapeAttr } from "./template"

const ORIGIN = "https://docs.invalid"

/**
 * Rewrites the site's page-relative links for the app: a page link to `/help/<url>#frag`, an
 * image to `/help-docs/assets/...`. Outside links and same-page anchors are left as they are.
 */
export function rewriteLinks(html: string, pageUrl: string): string {
  const base = new URL(`${ORIGIN}/docs/${pageUrl ? `${pageUrl}/` : ""}`)
  return html.replace(/\b(href|src)="([^"]*)"/g, (m, attr: string, raw: string) => {
    const value = decodeEntities(raw)
    if (value.startsWith("#")) return m
    let u: URL
    try {
      u = new URL(value, base)
    } catch {
      return m
    }
    if (u.origin !== ORIGIN || !u.pathname.startsWith("/docs/")) return m
    const rest = u.pathname.slice("/docs/".length)
    if (rest.startsWith("assets/")) return `${attr}="${escapeAttr(`/help-docs/${rest}`)}"`
    const url = rest.replace(/\/$/, "")
    return `${attr}="${escapeAttr(`/help${url ? `/${url}` : ""}${u.hash}`)}"`
  })
}

export function appBundle(
  rendered: RenderedPage[],
  sections: NavSection[],
): { index: HelpDocsIndex; pages: HelpDocsPage[] } {
  const byId = new Map(rendered.map((r) => [r.page.nav.id, r.page]))
  const pages = rendered.map(({ page, html }): HelpDocsPage => {
    const body = rewriteLinks(html, page.nav.url)
    return {
      url: page.nav.url,
      title: page.title,
      description: page.description,
      showLede: page.ownDescription,
      section: page.section?.title ?? "",
      html: body,
      headings: page.headings.filter((h) => h.depth === 2 || h.depth === 3),
    }
  })
  const landing = rendered[0]?.page
  const index: HelpDocsIndex = {
    landing: { url: "", title: landing?.title ?? "Documentation" },
    sections: sections.map((s) => ({
      title: s.title,
      pages: s.pages.map((p) => ({ url: p.url, title: byId.get(p.id)?.title ?? p.id })),
    })),
    entries: pages.map((p, i) => ({
      url: p.url,
      title: p.title,
      section: p.section,
      description: p.description,
      headings: p.headings,
      text: htmlToText(rendered[i]?.html ?? ""),
    })),
  }
  return { index, pages }
}

export function writeAppBundle(docsDir: string, out: string): number {
  const { rendered } = renderDocs({
    docsDir,
    nav: { landing: LANDING, sections: NAV },
    allowMissing: true,
    warnBroken: true,
  })
  const { index, pages } = appBundle(rendered, NAV)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, "pages"), { recursive: true })
  writeFileSync(join(out, "index.json"), JSON.stringify(index))
  for (const page of pages) {
    const file = join(out, "pages", `${page.url === "" ? "index" : page.url}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(page))
  }
  if (existsSync(join(docsDir, "assets"))) {
    cpSync(join(docsDir, "assets"), join(out, "assets"), { recursive: true })
  }
  return pages.length
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const outAt = args.indexOf("--out")
  const repoRoot = join(import.meta.dir, "../..")
  const out =
    outAt !== -1 && args[outAt + 1]
      ? resolve(args[outAt + 1] as string)
      : join(repoRoot, "apps/web/public/help-docs")
  try {
    const n = writeAppBundle(join(repoRoot, "docs"), out)
    console.log(`help docs: ${n} pages written to ${out}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
