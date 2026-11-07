// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// WHY: under the desktop shell the page is served from its own origin
// (http://tauri.localhost on Windows, tauri://localhost elsewhere), so a
// `fetch("/api/...")` goes to the shell's asset protocol, which answers
// index.html with a 200. Every such call "succeeded" and did nothing: the
// upload relay confirmed an object that was never stored, the manifest apps
// never loaded, saved views and backlinks answered empty (first Windows walk).
// `apiUrl()` from ~/lib/env is absolute under a shell and relative otherwise.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = path.resolve(import.meta.dirname, "..")
const RELATIVE_API_FETCH = /fetch\(\s*[`"']\/api\b/
/** An attribute or a file route written as a bare path. */
const RELATIVE_API_SRC = /src="\/api\/|[`"']\/api\/files\//
/**
 * Files whose `/api/files/...` strings are paths handed to the plugin host's
 * api client (framework/host-services.ts), which puts them on the bound server
 * like every other `host.fetch`: the plugin contract is full kernel routes.
 * They are still held to the raw `fetch("/api` and `src="/api/` rules.
 */
const HOST_CLIENT_PATH_FILES = new Set([
  path.join("framework", "host-app-calls.ts"),
  path.join("framework", "isolated-app.tsx"),
])
const BARE_SRC = /src="\/api\//
/** In those files `host.fetch("/api/...")` is the host client; a bare `fetch(` is not. */
const BARE_RELATIVE_API_FETCH = /(?<![.\w])fetch\(\s*[`"']\/api\b/
/**
 * An avatar the server stored as "/api/avatars/<key>" fed straight into an
 * <img>. Under a shell that resolves inside the bundle: every uploaded picture
 * broke while initials kept working. It goes through serverResourceUrl().
 */
const UNRESOLVED_AVATAR_SRC = /src=\{(?![^}]*serverResourceUrl)[^}]*avatar/i
const UNRESOLVED_AVATAR_WHEN =
  /<Show\s+when=\{(?![^}]*serverResourceUrl)[^}]*avatar(?:Url|Value)[^}]*\}[\s\S]{0,400}?\(url\)\s*=>\s*(?:\(\s*)?<img/

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue
      yield* sourceFiles(full)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield full
    }
  }
}

describe("no request is built on the page's own origin", () => {
  it("every fetch of /api goes through apiUrl() or the api client", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      // Comments may quote the shape they warn about; code may not.
      const text = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n")
      const rel = path.relative(SRC, file)
      const hostClient = HOST_CLIENT_PATH_FILES.has(rel)
      const fetchRule = hostClient ? BARE_RELATIVE_API_FETCH : RELATIVE_API_FETCH
      const srcRule = hostClient ? BARE_SRC : RELATIVE_API_SRC
      if (fetchRule.test(text) || srcRule.test(text)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it("every avatar <img> is anchored on the server, not the page", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8")
      if (UNRESOLVED_AVATAR_SRC.test(text) || UNRESOLVED_AVATAR_WHEN.test(text)) {
        offenders.push(path.relative(SRC, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it("the sweep sees what it is looking for", () => {
    expect(UNRESOLVED_AVATAR_SRC.test("src={props.user.avatarUrl!}")).toBe(true)
    expect(UNRESOLVED_AVATAR_SRC.test("src={serverResourceUrl(props.user.avatarUrl)!}")).toBe(false)
    expect(
      UNRESOLVED_AVATAR_WHEN.test("<Show when={author.avatarUrl} fallback={x}>\n{(url) => <img"),
    ).toBe(true)
    expect(
      UNRESOLVED_AVATAR_WHEN.test("<Show when={serverResourceUrl(a.avatarUrl)}>\n{(url) => <img"),
    ).toBe(false)
    expect(RELATIVE_API_FETCH.test("await fetch(`/api/apps/manifests`, {")).toBe(true)
    expect(RELATIVE_API_FETCH.test('fetch("/api/saved-views", {')).toBe(true)
    expect(RELATIVE_API_FETCH.test('fetch(apiUrl("/saved-views"), {')).toBe(false)
    expect(RELATIVE_API_SRC.test('src="/api/mail/image-proxy?url="')).toBe(true)
    expect(RELATIVE_API_SRC.test("`/api/files/" + "$" + "{attachment.id}/inline`")).toBe(true)
    expect(RELATIVE_API_SRC.test("apiUrl(`/files/" + "$" + "{attachment.id}/inline`)")).toBe(false)
  })
})
