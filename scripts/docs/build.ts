// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Static renderer for the docs site (`bun run docs:build [--out <dir>]`).
 *
 * Reads `docs/nav.ts` and every page it lists (`docs/<id>.md`, YAML
 * frontmatter `title`, `description`, optional `screenshot` + `screenshotAlt`),
 * renders them with `marked` into the layout in `./template.ts`, and writes:
 *
 *   <out>/docs/index.html            landing page (docs/index.md)
 *   <out>/docs/<url>/index.html      one per nav page
 *   <out>/docs/assets/*              copied from docs/assets
 *   <out>/docs/docs.css, docs.js     copied from docs/_theme
 *   <out>/docs/search-index.json     the built-in search box's index
 *   <out>/docs/sitemap.xml           absolute https://liaison.sh/docs/... URLs
 *   <out>/llms.txt, llms-full.txt    llmstxt.org index and full text
 *
 * Relative `.md` links are rewritten to the target page's URL (relative, so
 * the output works under any host). A link to an `.md` that is not in the nav,
 * a missing `#fragment`, a missing asset, or a nav page without a file fails
 * the build with the full list. Links that leave `docs/` but stay inside the
 * repo point at the file on GitHub.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, posix, resolve } from "node:path"
import { Marked, type Token, type Tokens } from "marked"
import { LANDING, NAV, type NavPage, type NavSection } from "../../docs/nav"
import { escapeAttr, escapeHtml, renderLayout, type TemplatePage } from "./template"

export const SITE = "https://liaison.sh"
export const DOCS_BASE = `${SITE}/docs/`
const REPO = "https://github.com/mathieufro/liaison"
const EDIT_BASE = `${REPO}/edit/main/docs/`
const BLOB_BASE = `${REPO}/blob/main/`
const THEME_DIR = join(import.meta.dir, "../../docs/_theme")
const DESCRIPTION_MAX = 160

export interface BuildOptions {
  docsDir: string
  out: string
  nav: { landing: NavPage; sections: NavSection[] }
  /** Smoke renders only: a nav page without a file renders as a "Coming soon" stub. */
  allowMissing?: boolean
  /** Smoke renders only: print broken links instead of failing. */
  warnBroken?: boolean
}

export interface BrokenLink {
  /** Source file, relative to the docs dir. */
  file: string
  link: string
}

export class DocsBuildError extends Error {
  constructor(
    readonly broken: BrokenLink[],
    readonly missing: string[],
    readonly invalid: string[] = [],
  ) {
    const lines = [
      ...missing.map((m) => `missing page file (listed in docs/nav.ts): ${m}`),
      ...invalid,
      ...broken.map((b) => `broken link in ${b.file}: ${b.link}`),
    ]
    super(`docs build failed:\n${lines.map((l) => `  - ${l}`).join("\n")}`)
    this.name = "DocsBuildError"
  }
}

interface Heading {
  depth: number
  text: string
  id: string
}

type HeadingToken = Tokens.Heading & { id?: string }

interface Page {
  nav: NavPage
  section: NavSection | null
  /** Source path relative to the docs dir, e.g. `apps/mail.md`. */
  file: string
  title: string
  description: string
  /** False when the description fell back to the first paragraph (no lede then). */
  ownDescription: boolean
  screenshot?: string
  screenshotAlt?: string
  /** Markdown body without frontmatter (and without a leading `# ` title). */
  body: string
  tokens: Token[]
  headings: Heading[]
  stub: boolean
}

interface Frontmatter {
  title?: string
  description?: string
  screenshot?: string
  screenshotAlt?: string
}

export function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!m) return { data: {}, body: source }
  const parsed = Bun.YAML.parse(m[1] ?? "") as unknown
  const data: Frontmatter = {}
  if (parsed && typeof parsed === "object") {
    for (const key of ["title", "description", "screenshot", "screenshotAlt"] as const) {
      const v = (parsed as Record<string, unknown>)[key]
      if (typeof v === "string") data[key] = v.trim()
    }
  }
  return { data, body: source.slice(m[0].length) }
}

/** GitHub-compatible heading slug, so links written for GitHub keep working. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

/** Plain text of inline tokens (no markup, no escaping). */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return ""
  let s = ""
  for (const t of tokens) {
    if (t.type === "html") continue
    if ("tokens" in t && Array.isArray(t.tokens) && t.tokens.length > 0) s += plainText(t.tokens)
    else if ("text" in t && typeof t.text === "string") s += t.text
  }
  return s
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`
}

function humanize(id: string): string {
  const last = id.split("/").pop() ?? id
  const words = last.replace(/-/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const pageDir = (p: NavPage) => (p.url ? `docs/${p.url}` : "docs")
const absUrl = (p: NavPage) => (p.url ? `${DOCS_BASE}${p.url}/` : DOCS_BASE)

function relHref(fromDir: string, toPath: string, isDir: boolean): string {
  const rel = posix.relative(fromDir, toPath)
  if (!isDir) return rel
  return rel === "" ? "./" : `${rel}/`
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim()
}

export async function buildDocs(opts: BuildOptions): Promise<{ pages: number }> {
  const docsDir = resolve(opts.docsDir)
  const repoRoot = dirname(docsDir)
  const marked = new Marked({ gfm: true })
  const missing: string[] = []
  const invalid: string[] = []
  const broken: BrokenLink[] = []

  const stubPage = (nav: NavPage, section: NavSection | null, file: string): Page => ({
    nav,
    section,
    file,
    title: humanize(nav.id),
    description: "This page is being written.",
    ownDescription: false,
    body: "Coming soon.\n",
    tokens: marked.lexer("Coming soon.\n"),
    headings: [],
    stub: true,
  })

  // ---- 1. Load every page (landing first, then nav order) -------------------
  const ordered: { nav: NavPage; section: NavSection | null }[] = [
    { nav: opts.nav.landing, section: null },
    ...opts.nav.sections.flatMap((s) => s.pages.map((p) => ({ nav: p, section: s }))),
  ]
  const seenIds = new Set<string>()
  const seenUrls = new Set<string>()
  const pages: Page[] = []
  for (const { nav, section } of ordered) {
    if (seenIds.has(nav.id) || seenUrls.has(nav.url)) {
      throw new Error(`docs/nav.ts lists a page twice: ${nav.id} (${nav.url || "/"})`)
    }
    seenIds.add(nav.id)
    seenUrls.add(nav.url)
    const file = `${nav.id}.md`
    const path = join(docsDir, file)
    if (!existsSync(path)) {
      if (!opts.allowMissing) {
        missing.push(`docs/${file}`)
        continue
      }
      pages.push(stubPage(nav, section, file))
      continue
    }
    const source = readFileSync(path, "utf8")
    let parsed: ReturnType<typeof parseFrontmatter>
    try {
      parsed = parseFrontmatter(source)
    } catch (err) {
      const problem = `invalid frontmatter in ${file}: ${err instanceof Error ? err.message : err}`
      if (opts.allowMissing) {
        console.warn(`${problem} (rendered as a stub, --allow-missing)`)
        pages.push(stubPage(nav, section, file))
      } else invalid.push(problem)
      continue
    }
    const { data, body: rawBody } = parsed
    let body = rawBody
    let tokens: Token[] = marked.lexer(body)
    let title = data.title
    const firstIdx = tokens.findIndex((t) => t.type !== "space")
    const first = tokens[firstIdx]
    if (first?.type === "heading" && (first as Tokens.Heading).depth === 1) {
      const h1 = plainText((first as Tokens.Heading).tokens).trim()
      if (!title || h1 === title) {
        title = title ?? h1
        body = body.replace(first.raw, "").replace(/^\s+/, "")
        tokens = marked.lexer(body)
      }
    }
    let description = data.description
    if (!description) {
      const para = tokens.find((t) => t.type === "paragraph") as Tokens.Paragraph | undefined
      description = truncate(plainText(para?.tokens), DESCRIPTION_MAX)
    }
    // Heading ids: unique per page, assigned in document order.
    const headings: Heading[] = []
    const used = new Map<string, number>()
    marked.walkTokens(tokens, (t) => {
      if (t.type !== "heading") return
      const h = t as HeadingToken
      const text = plainText(h.tokens).trim()
      const base = slugify(text) || "section"
      const n = used.get(base) ?? 0
      used.set(base, n + 1)
      h.id = n === 0 ? base : `${base}-${n}`
      headings.push({ depth: h.depth, text, id: h.id })
    })
    pages.push({
      nav,
      section,
      file,
      title: title ?? humanize(nav.id),
      description,
      ownDescription: !!data.description,
      screenshot: data.screenshot,
      screenshotAlt: data.screenshotAlt,
      body,
      tokens,
      headings,
      stub: false,
    })
  }
  if (missing.length > 0 || invalid.length > 0) throw new DocsBuildError(broken, missing, invalid)

  const byId = new Map(pages.map((p) => [p.nav.id, p]))

  // ---- 2. Link resolution ----------------------------------------------------
  function resolveLink(page: Page, href: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("/")) {
      return href
    }
    const hashAt = href.indexOf("#")
    const pathPart = (hashAt === -1 ? href : href.slice(0, hashAt)).split("?")[0] ?? ""
    const frag = hashAt === -1 ? "" : href.slice(hashAt + 1)
    const fail = () => {
      broken.push({ file: page.file, link: href })
      return href
    }
    if (pathPart === "") {
      if (frag && !page.stub && !page.headings.some((h) => h.id === frag)) return fail()
      return href
    }
    let target: string
    try {
      target = posix.normalize(posix.join(posix.dirname(page.file), decodeURI(pathPart)))
    } catch {
      return fail()
    }
    const fromDir = pageDir(page.nav)
    if (target.startsWith("../")) {
      const repoPath = posix.normalize(posix.join("docs", target))
      if (repoPath.startsWith("../") || !existsSync(join(repoRoot, repoPath))) return fail()
      return `${BLOB_BASE}${repoPath}${frag ? `#${frag}` : ""}`
    }
    if (target.endsWith(".md")) {
      const dest = byId.get(target.slice(0, -3))
      if (!dest) return fail()
      if (frag && !dest.stub && !dest.headings.some((h) => h.id === frag)) return fail()
      return relHref(fromDir, pageDir(dest.nav), true) + (frag ? `#${frag}` : "")
    }
    if (!target.startsWith("assets/") || !existsSync(join(docsDir, target))) return fail()
    return relHref(fromDir, `docs/${target}`, false) + (frag ? `#${frag}` : "")
  }

  // ---- 3. Renderer -------------------------------------------------------------
  marked.use({
    renderer: {
      heading(token) {
        const id = (token as HeadingToken).id ?? slugify(token.text)
        const inner = this.parser.parseInline(token.tokens)
        return `<h${token.depth} id="${escapeAttr(id)}">${inner}<a class="anchor" href="#${escapeAttr(id)}" aria-label="Link to this section">#</a></h${token.depth}>\n`
      },
      code({ text, lang, escaped }) {
        const language = (lang ?? "").match(/^\S*/)?.[0] ?? ""
        const body = `${text.replace(/\n$/, "")}\n`
        const code = escaped ? body : escapeHtml(body)
        const cls = language ? ` class="language-${escapeAttr(language)}"` : ""
        return `<div class="code"><div class="code-bar"><span>${escapeHtml(language)}</span><button type="button" class="copy" hidden>Copy</button></div><pre><code${cls}>${code}</code></pre></div>\n`
      },
      link(token) {
        if (!/^https?:\/\//i.test(token.href)) return false
        const inner = this.parser.parseInline(token.tokens)
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : ""
        return `<a href="${escapeAttr(token.href)}" rel="noopener"${title}>${inner}</a>`
      },
    },
  })

  function renderBody(page: Page): string {
    marked.walkTokens(page.tokens, (t) => {
      if (t.type === "link" || t.type === "image") {
        const l = t as Tokens.Link | Tokens.Image
        l.href = resolveLink(page, l.href)
      } else if (t.type === "html") {
        const h = t as Tokens.HTML
        h.text = h.text.replace(
          /\b(href|src)="([^"]*)"/g,
          (_m, attr: string, value: string) =>
            `${attr}="${escapeAttr(resolveLink(page, decodeEntities(value)))}"`,
        )
      }
    })
    return marked
      .parser(page.tokens as Parameters<typeof marked.parser>[0])
      .replaceAll("<table>", '<div class="tbl"><table>')
      .replaceAll("</table>", "</table></div>")
  }

  const rendered = pages.map((page) => {
    let screenshot: { src: string; alt: string } | undefined
    if (page.screenshot) {
      if (!existsSync(join(docsDir, page.screenshot))) {
        broken.push({ file: page.file, link: page.screenshot })
      } else {
        screenshot = {
          src: relHref(pageDir(page.nav), `docs/${posix.normalize(page.screenshot)}`, false),
          alt: page.screenshotAlt ?? "",
        }
      }
    }
    return { page, html: renderBody(page), screenshot }
  })
  if (broken.length > 0) {
    const err = new DocsBuildError(broken, missing)
    if (!opts.warnBroken) throw err
    console.warn(err.message.replace("failed", "warnings (--warn-broken)"))
  }

  // ---- 4. Write --------------------------------------------------------------
  const out = resolve(opts.out)
  const outDocs = join(out, "docs")
  rmSync(outDocs, { recursive: true, force: true })
  mkdirSync(outDocs, { recursive: true })
  if (existsSync(join(docsDir, "assets"))) {
    cpSync(join(docsDir, "assets"), join(outDocs, "assets"), { recursive: true })
  }
  for (const f of ["docs.css", "docs.js"]) cpSync(join(THEME_DIR, f), join(outDocs, f))

  const sidebar: TemplatePage["sidebar"] = opts.nav.sections.map((s) => ({
    title: s.title,
    pages: s.pages.map((p) => ({ id: p.id, url: p.url, title: byId.get(p.id)?.title ?? p.id })),
  }))

  rendered.forEach(({ page, html, screenshot }, i) => {
    const prev = i > 0 ? pages[i - 1] : undefined
    const next = pages[i + 1]
    const dir = pageDir(page.nav)
    const link = (p: Page | undefined) =>
      p ? { title: p.title, href: relHref(dir, pageDir(p.nav), true) } : undefined
    const sectionFirst = page.section?.pages[0]
    const out: TemplatePage = {
      id: page.nav.id,
      title: page.title,
      description: page.description,
      showLede: page.ownDescription,
      canonical: absUrl(page.nav),
      root: relHref(dir, "docs", true),
      isLanding: page.nav === opts.nav.landing,
      section:
        page.section && sectionFirst
          ? {
              title: page.section.title,
              href: relHref(dir, pageDir(sectionFirst), true),
              abs: absUrl(sectionFirst),
            }
          : undefined,
      bodyHtml: html,
      toc: page.headings.filter((h) => h.depth === 2 || h.depth === 3),
      screenshot: screenshot && {
        ...screenshot,
        abs: `${DOCS_BASE}${posix.normalize(page.screenshot ?? "")}`,
      },
      prev: link(prev),
      next: link(next),
      editUrl: `${EDIT_BASE}${page.file}`,
      sidebar,
      stub: page.stub,
    }
    const target = join(out.isLanding ? outDocs : join(outDocs, page.nav.url), "index.html")
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, renderLayout(out))
  })

  // search-index.json
  const index = rendered.map(({ page, html }) => ({
    title: page.title,
    url: page.nav.url ? `${page.nav.url}/` : "",
    section: page.section?.title ?? "",
    headings: page.headings
      .filter((h) => h.depth === 2 || h.depth === 3)
      .map((h) => ({ text: h.text, id: h.id })),
    text: htmlToText(html).slice(0, 300),
  }))
  writeFileSync(join(outDocs, "search-index.json"), JSON.stringify(index))

  // sitemap.xml
  const urls = pages.map((p) => `  <url><loc>${escapeHtml(absUrl(p.nav))}</loc></url>`)
  writeFileSync(
    join(outDocs, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
  )

  // llms.txt + llms-full.txt
  const landing = pages[0]
  const llms = [`# Liaison\n\n> ${landing?.description ?? "Liaison documentation."}\n`]
  llms.push(`Documentation home: ${DOCS_BASE}\n`)
  for (const s of opts.nav.sections) {
    const items = s.pages
      .map((p) => byId.get(p.id))
      .filter((p): p is Page => !!p && !p.stub)
      .map((p) => `- [${p.title}](${absUrl(p.nav)}): ${p.description}`)
    if (items.length > 0) llms.push(`## ${s.title}\n\n${items.join("\n")}\n`)
  }
  writeFileSync(join(out, "llms.txt"), llms.join("\n"))

  const full = pages
    .filter((p) => p !== landing && !p.stub)
    .map(
      (p) => `# ${p.title}\n\nSource: ${absUrl(p.nav)}\n\n${absolutizeLinks(p, p.body).trim()}\n`,
    )
  writeFileSync(join(out, "llms-full.txt"), full.join("\n"))

  function absolutizeLinks(page: Page, md: string): string {
    return md.replace(/\]\(([^)\s]+)\)/g, (m, href: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return m
      const [path = "", frag] = href.split("#")
      if (!path.endsWith(".md")) return m
      const target = posix.normalize(posix.join(posix.dirname(page.file), path))
      const dest = byId.get(target.slice(0, -3))
      return dest ? `](${absUrl(dest.nav)}${frag ? `#${frag}` : ""})` : m
    })
  }

  return { pages: pages.length }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const outAt = args.indexOf("--out")
  const repoRoot = join(import.meta.dir, "../..")
  const out =
    outAt !== -1 && args[outAt + 1]
      ? resolve(args[outAt + 1] as string)
      : join(repoRoot, "dist/docs-site")
  try {
    const { pages } = await buildDocs({
      docsDir: join(repoRoot, "docs"),
      out,
      nav: { landing: LANDING, sections: NAV },
      allowMissing: args.includes("--allow-missing"),
      warnBroken: args.includes("--warn-broken"),
    })
    console.log(`docs: ${pages} pages written to ${out}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
