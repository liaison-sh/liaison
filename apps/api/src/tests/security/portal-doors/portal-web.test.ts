// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of the client portal's web pages and of the staff section that
// previews them (the company page's client portal section): how they render what
// clients typed. Each test is named by its door id and fails when its protection
// is removed.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const WEB_SRC = resolve(import.meta.dir, "../../../../../web/src")
const PORTAL = join(WEB_SRC, "modules/portal")
const STAFF_SECTION = join(WEB_SRC, "modules/contacts/CompanyPortalSection.tsx")

/** Ways a page could turn a string into markup or script. */
const MARKUP_SINKS = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /\binsertAdjacentHTML\b/,
  /\bDOMParser\b/,
  /\bdocument\.write\b/,
  /\bcreateContextualFragment\b/,
  /\bsrcdoc\b/,
  /\beval\s*\(/,
  /\bnew Function\b/,
  /href=\{/,
]

const CLIENT_ACTION = join(WEB_SRC, "modules/client-action")

/** Files whose import opens, or builds on, the member shell's socket and sign-in session. */
const SOCKET_MODULES = [
  "primitives/createWebSocket",
  "modules/shell/WsContext",
  "modules/shell/Shell",
  "modules/auth/createAuthManager",
  "framework/bootstrap",
  "framework/resync",
]

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("~/")
    ? join(WEB_SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(from, "..", spec)
      : null
  if (!base) return null
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return null
}

/** Every web source file a page reaches through its imports. */
function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, m[1] as string)
      if (next && !seen.has(next)) queue.push(next)
    }
  }
  return seen
}

function sources(): string[] {
  const files = readdirSync(PORTAL, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(PORTAL, f))
  return [...files, STAFF_SECTION]
}

describe("client portal web doors", () => {
  it("NT-25: the portal and the token page reach no module that opens a socket, and name none", () => {
    const entries = [PORTAL, CLIENT_ACTION].flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
        .map((f) => join(dir, f)),
    )
    expect(entries.length).toBeGreaterThan(10)
    const reached = importClosure(entries)
    const hits: string[] = []
    for (const file of reached) {
      const rel = file.slice(WEB_SRC.length + 1).replace(/\.(ts|tsx)$/, "")
      if (SOCKET_MODULES.includes(rel)) hits.push(`reaches ${rel}`)
      const text = readFileSync(file, "utf8")
      if (/\bnew WebSocket\b|ws-ticket|createWebSocket\(/.test(text))
        hits.push(`names a socket: ${rel}`)
    }
    expect(hits).toEqual([])
  })

  it("NT-55: the portal screens and the staff preview render typed names, capacities, reasons, subjects, filenames and request texts as text, never as markup", () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(5)
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      for (const re of MARKUP_SINKS)
        if (re.test(text)) hits.push(`${f.slice(WEB_SRC.length)}: ${re.source}`)
    }
    expect(hits).toEqual([])
  })
})
