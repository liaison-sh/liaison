#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Crawl a company's own website into Markdown files a `liaison config apply`
// knowledge `dir` entry loads (one document per page). Used by the setup
// playbook (.claude/skills/setup-liaison/SKILL.md).
//
//   bun apps/api/src/cli/setup/crawl-site.ts --url https://acme.example --out deploy/setup/knowledge/website
//
// No Bun on the host? Run it in the Liaison image, which has everything:
//   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/deploy/setup:/setup" \
//     --entrypoint bun <liaison image> apps/api/src/cli/setup/crawl-site.ts --url ... --out /setup/knowledge/website
//
// What it does: reads robots.txt and the sitemap first (falls back to
// following links from --url), stays on the same host, skips what robots.txt
// disallows, fetches at most --max-pages HTML pages one at a time, keeps the
// page's <main>/<article> when there is one (else <body>), drops navigation,
// scripts and forms, converts to Markdown, and writes one file per page with
// `title` and `source` front matter. PDFs and other files it finds are listed,
// not downloaded. It prints a JSON summary on stdout.
//
// Safety: it only ever fetches the start URL's host (www. or not), sitemap and
// sitemap-index entries included; it follows redirects itself (at most 5) and
// re-checks each hop's host; it refuses hosts that resolve to a loopback,
// private, link-local or unique-local address unless --allow-private-network
// is given (an intranet site); and it reads at most 5 MB of any response.

import { lookup } from "node:dns/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import { join } from "node:path"
import { parseArgs } from "node:util"
import TurndownService from "turndown"
import { readStreamCapped } from "~/lib/read-capped-body"

const USER_AGENT = "LiaisonSetup/1.0 (+https://github.com/mathieufro/liaison)"
const SKIP_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|tgz|mp4|mp3|wav|woff2?|ttf|eot|dmg|exe|pkg)$/i
const DOC_EXTENSIONS = /\.(pdf|docx?|pptx?|xlsx?)$/i
const MIN_TEXT_CHARS = 80
/** The most of one response the crawler reads. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5

export interface RobotsRules {
  disallow: string[]
  allow: string[]
  sitemaps: string[]
}

/** The `User-agent: *` group of a robots.txt, plus every Sitemap line. */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] }
  let inStar = false
  let sawRuleInGroup = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim()
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = (m[1] ?? "").toLowerCase()
    const value = (m[2] ?? "").trim()
    if (key === "sitemap") {
      if (value) rules.sitemaps.push(value)
    } else if (key === "user-agent") {
      if (sawRuleInGroup) {
        inStar = false
        sawRuleInGroup = false
      }
      if (value === "*") inStar = true
    } else if (key === "disallow" || key === "allow") {
      sawRuleInGroup = true
      if (inStar && value) (key === "disallow" ? rules.disallow : rules.allow).push(value)
    }
  }
  return rules
}

/** Longest matching rule wins; Allow wins a tie. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (list: string[]) =>
    list.filter((p) => path.startsWith(p)).reduce((n, p) => Math.max(n, p.length), -1)
  const d = longest(rules.disallow)
  return d < 0 || longest(rules.allow) >= d
}

/** The host without a leading `www.`, the unit "same site" is judged on. */
function siteHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "")
}

export function sameSite(a: URL, b: URL): boolean {
  return siteHost(a) === siteHost(b)
}

/**
 * Loopback, private, link-local, unique-local, CGNAT and unspecified
 * addresses (IPv4, IPv6, and IPv4-mapped IPv6): never a public website.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "")
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped?.[1]) return isPrivateAddress(mapped[1])
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  if (isIP(ip) === 6) {
    return ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip)
  }
  return false
}

export type HostResolver = (host: string) => Promise<string[]>

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((r) => r.address)

/** Refuse a URL whose host is, or resolves to, a non-public address. */
export async function assertPublicHost(
  url: URL,
  resolver: HostResolver = resolveHost,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`refusing ${url.host}: not a public host`)
  }
  const addresses = isIP(host) ? [host] : await resolver(host)
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(
      `refusing ${url.host}: it resolves to a private or local address (pass --allow-private-network for an intranet site)`,
    )
  }
}

/** Read a response body up to `limit` bytes; null when it is larger. */
export async function readCapped(
  res: Response,
  limit: number = MAX_RESPONSE_BYTES,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel()
    return null
  }
  if (!res.body) return ""
  const bytes = await readStreamCapped(res.body, limit)
  return bytes ? new TextDecoder().decode(bytes) : null
}

export interface FetchPolicy {
  /** Only this site's pages are ever requested. */
  site: URL
  allowPrivateNetwork: boolean
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  resolver?: HostResolver
}

export interface FetchedText {
  status: number
  type: string
  body: string
  /** The URL that answered, after redirects. */
  url: string
}

/**
 * GET a page of the site: redirects followed by hand (each hop must stay on
 * the site and on a public address), body capped. Null when the request fails
 * or is refused; refusals are reported through `onRefused`.
 */
export async function fetchSitePage(
  url: string,
  policy: FetchPolicy,
  onRefused: (url: string, reason: string) => void = () => {},
): Promise<FetchedText | null> {
  const doFetch = policy.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init))
  let current: URL
  try {
    current = new URL(url)
  } catch {
    return null
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!sameSite(current, policy.site)) {
      onRefused(current.toString(), "leaves the site")
      return null
    }
    if (current.protocol !== "https:" && current.protocol !== "http:") return null
    try {
      if (!policy.allowPrivateNetwork) await assertPublicHost(current, policy.resolver)
    } catch (err) {
      onRefused(current.toString(), err instanceof Error ? err.message : String(err))
      return null
    }
    let res: Response
    try {
      res = await doFetch(current.toString(), {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xml;q=0.9,*/*;q=0.5",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location")
      await res.body?.cancel()
      if (!location) return null
      current = new URL(location, current)
      continue
    }
    const body = await readCapped(res)
    if (body === null) {
      onRefused(current.toString(), `larger than ${MAX_RESPONSE_BYTES} bytes`)
      return null
    }
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      body,
      url: current.toString(),
    }
  }
  onRefused(url, `more than ${MAX_REDIRECTS} redirects`)
  return null
}

/** Normalize a link against its page: same host only, no fragment, no query tracking. */
export function normalizeLink(href: string, base: URL): URL | null {
  if (/^(mailto|tel|javascript|data):/i.test(href)) return null
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null
  if (url.pathname.startsWith("/cdn-cgi/")) return null
  url.hash = ""
  url.pathname = url.pathname.replace(/\/index\.html?$/i, "/")
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key)
  }
  return url
}

export function extractLinks(html: string, base: URL): URL[] {
  const out: URL[] = []
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const url = normalizeLink(m[1] ?? "", base)
    if (url) out.push(url)
  }
  return out
}

export function extractSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    (m[1] ?? "").replace(/&amp;/g, "&"),
  )
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
}

/** One pass, so a decoded `&` never starts another entity (`&amp;lt;` is `&lt;`). */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? "")
}

/** Cloudflare's "email protection" obfuscation: hex, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return null
  const key = Number.parseInt(hex.slice(0, 2), 16)
  let out = ""
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key)
  }
  return out.includes("@") ? out : null
}

/** Put back the email addresses a Cloudflare-proxied site obfuscates. */
export function restoreCfEmails(html: string): string {
  return html
    .replace(
      /<a\b[^>]*href=["'][^"']*\/cdn-cgi\/l\/email-protection#([0-9a-f]+)["'][^>]*>[\s\S]*?<\/a>/gi,
      (whole, hex: string) => {
        const email = decodeCfEmail(hex)
        return email ? `<a href="mailto:${email}">${email}</a>` : whole
      },
    )
    .replace(
      /<[a-z]+\b[^>]*data-cfemail=["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/[a-z]+>/gi,
      (whole, hex: string) => decodeCfEmail(hex) ?? whole,
    )
}

/** The page's main content as HTML: <main>, else <article>, else <body>, else all. */
export function mainContent(html: string): string {
  for (const tag of ["main", "article", "body"]) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}>`, "i").exec(html)
    if (m?.[1]) return m[1]
  }
  return html
}

export function pageTitle(html: string): string | null {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  const clean = (s: string | undefined) =>
    s
      ? decodeEntities(s.replace(/<[^>]+>/g, ""))
          .replace(/\s+/g, " ")
          .trim()
      : ""
  return clean(h1) || clean(t) || null
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
turndown.remove(["script", "style", "noscript", "nav", "footer", "form", "iframe", "svg", "button"])

export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(mainContent(restoreCfEmails(html)))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** A stable file name for a URL path: `/docs/getting-started/` → `docs-getting-started.md`. */
export function fileNameFor(url: URL): string {
  const path = decodeURIComponent(url.pathname)
    .replace(/\.(html?|php|aspx?)$/i, "")
    .replace(/^\/+|\/+$/g, "")
  const query = url.search ? `-${url.search.slice(1)}` : ""
  const slug = `${path || "index"}${query}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
  return `${slug || "index"}.md`
}

function yamlString(s: string): string {
  return JSON.stringify(s)
}

/** Page URLs from the site's sitemaps (robots.txt Sitemap lines, else /sitemap.xml), same site only. */
export async function sitemapUrls(
  robots: RobotsRules,
  limit: number,
  policy: FetchPolicy,
  onRefused: (url: string, reason: string) => void = () => {},
): Promise<string[]> {
  const onSite = (u: string): boolean => {
    try {
      return sameSite(new URL(u), policy.site)
    } catch {
      return false
    }
  }
  const declared = robots.sitemaps.filter(onSite)
  const queue = declared.length > 0 ? declared : [`${policy.site.origin}/sitemap.xml`]
  const seen = new Set<string>()
  const pages: string[] = []
  while (queue.length > 0 && pages.length < limit * 2 && seen.size < 50) {
    const next = queue.shift()
    if (!next || seen.has(next)) continue
    seen.add(next)
    const res = await fetchSitePage(next, policy, onRefused)
    if (res?.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(res.body)) continue
    const locs = extractSitemapLocs(res.body).filter(onSite)
    if (/<sitemapindex\b/i.test(res.body)) queue.push(...locs)
    else pages.push(...locs)
  }
  return pages
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      out: { type: "string" },
      "max-pages": { type: "string", default: "150" },
      "delay-ms": { type: "string", default: "250" },
      "allow-private-network": { type: "boolean", default: false },
    },
  })
  if (!values.url || !values.out) {
    process.stderr.write("usage: crawl-site.ts --url <https://...> --out <dir> [--max-pages 150]\n")
    process.exit(2)
  }
  const start = new URL(values.url)
  const maxPages = Number(values["max-pages"])
  const delayMs = Number(values["delay-ms"])
  mkdirSync(values.out, { recursive: true })
  const skipped: Array<{ url: string; reason: string }> = []
  const refused = (url: string, reason: string) => skipped.push({ url, reason })
  const policy: FetchPolicy = {
    site: start,
    allowPrivateNetwork: values["allow-private-network"] === true,
  }
  if (!policy.allowPrivateNetwork) {
    try {
      await assertPublicHost(start)
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(2)
    }
  }

  const robotsRes = await fetchSitePage(`${start.origin}/robots.txt`, policy, refused)
  const robots =
    robotsRes && robotsRes.status === 200 && !/<html/i.test(robotsRes.body)
      ? parseRobots(robotsRes.body)
      : { disallow: [], allow: [], sitemaps: [] }

  const queue: URL[] = [start]
  for (const loc of await sitemapUrls(robots, maxPages, policy, refused)) {
    const url = normalizeLink(loc, start)
    if (url) queue.push(url)
  }
  const fromSitemap = queue.length - 1

  const visited = new Set<string>()
  const written: Array<{ file: string; url: string; title: string; chars: number }> = []
  const documents = new Set<string>()
  const usedNames = new Set<string>()
  const seenContent = new Set<string>()

  while (queue.length > 0 && written.length < maxPages) {
    const url = queue.shift()
    if (!url) break
    const key = url.toString()
    if (visited.has(key)) continue
    visited.add(key)
    if (DOC_EXTENSIONS.test(url.pathname)) {
      documents.add(key)
      continue
    }
    if (SKIP_EXTENSIONS.test(url.pathname)) continue
    if (!isAllowed(robots, url.pathname)) {
      skipped.push({ url: key, reason: "disallowed by robots.txt" })
      continue
    }
    const res = await fetchSitePage(key, policy, refused)
    if (delayMs > 0) await Bun.sleep(delayMs)
    if (res?.status !== 200) {
      skipped.push({ url: key, reason: res ? `HTTP ${res.status}` : "fetch failed" })
      continue
    }
    if (!/text\/html|application\/xhtml/i.test(res.type)) continue
    for (const link of extractLinks(res.body, new URL(res.url))) {
      if (!visited.has(link.toString())) queue.push(link)
    }
    const markdown = htmlToMarkdown(res.body)
    if (markdown.replace(/[#*_`>\-\s[\]()!]/g, "").length < MIN_TEXT_CHARS) {
      skipped.push({ url: key, reason: "too little text" })
      continue
    }
    const digest = new Bun.CryptoHasher("sha256").update(markdown).digest("hex")
    if (seenContent.has(digest)) {
      skipped.push({ url: key, reason: "same content as a page already written" })
      continue
    }
    seenContent.add(digest)
    const title = pageTitle(res.body) ?? url.pathname
    let name = fileNameFor(url)
    for (let i = 2; usedNames.has(name); i++) name = fileNameFor(url).replace(/\.md$/, `-${i}.md`)
    usedNames.add(name)
    const body =
      `---\ntitle: ${yamlString(title)}\nsource: ${yamlString(key)}\n` +
      `fetched: ${new Date().toISOString().slice(0, 10)}\n---\n\n${markdown}\n`
    writeFileSync(join(values.out, name), body)
    written.push({ file: name, url: key, title, chars: markdown.length })
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        site: start.origin,
        sitemapUrls: fromSitemap,
        pagesWritten: written.length,
        hitPageCap: written.length >= maxPages && queue.length > 0,
        out: values.out,
        pages: written,
        skipped,
        documentsFound: [...documents],
      },
      null,
      2,
    )}\n`,
  )
}

if (import.meta.main) await main()
