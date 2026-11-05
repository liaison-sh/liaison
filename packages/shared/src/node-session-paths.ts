// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A node session's paths as every surface shows them (P2-D4; spec-charter.md,
// Sessions app): never an absolute local path. Shared so the web, the phone
// and the server's session push (P4) apply one rule.

export interface PathContext {
  /** The session's working directory, from the start `system` event's `data.cwd` (P3). */
  cwd?: string | null
  folderName?: string | null
  sessionId: string
  repo?: string | null
}

/** The sidecar's short session name (unattended.ts sessionShortName). */
function shortName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "session"
}

/** The sidecar's clone folder name for a repo URL (unattended.ts repoFolderName). */
function repoFolderName(repo: string): string {
  const last = trimTrailingSlashes(withoutQueryOrFragment(repo.trim()))
    .split(/[/:]/)
    .pop()
    ?.replace(/\.git$/, "")
  return last && /^[A-Za-z0-9._-]+$/.test(last) && !last.startsWith(".") ? last : "repo"
}

/** `s` without its trailing slashes, in one pass (a `/\/+$/` replace rescans each run of slashes). */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

/**
 * `s` cut at its first `#` or `?` on its last line, as `/[#?].*$/` cuts it,
 * in one pass (the pattern retries from every `#` and `?`).
 */
function withoutQueryOrFragment(s: string): string {
  const lineStart = Math.max(...LINE_TERMINATORS.map((t) => s.lastIndexOf(t))) + 1
  const at = s.slice(lineStart).search(/[#?]/)
  return at < 0 ? s : s.slice(0, lineStart + at)
}

const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"]

/**
 * What follows the first `/worktrees/<seg>/` that has a rest on one line, as
 * `/\/worktrees\/[^/]+\/(.+)$/` captures it, without retrying the pattern
 * from every `/worktrees/`. Null when there is none.
 */
function afterWorktree(p: string): string | null {
  const marker = "/worktrees/"
  const lastTerminator = Math.max(...LINE_TERMINATORS.map((t) => p.lastIndexOf(t)))
  for (let i = p.indexOf(marker); i !== -1; i = p.indexOf(marker, i + 1)) {
    const seg = i + marker.length
    const slash = p.indexOf("/", seg)
    if (slash <= seg) continue
    if (slash + 1 > lastTerminator && slash + 1 < p.length) return p.slice(slash + 1)
  }
  return null
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:\//.test(p)
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? ""
}

function after(p: string, marker: string): string | null {
  const i = p.lastIndexOf(marker)
  if (i < 0) return null
  const rest = p.slice(i + marker.length)
  return rest || null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A path as the Sessions app shows it: relative to the session's working
 * directory, never absolute (P2-D4). In order: the start event's cwd; the
 * sidecar's layout (after `/worktrees/<seg>/`, after `/sessions/<sessionId>/`,
 * after `/sessions/<short>/<repoName>/`); after the last `/<folderName>/`;
 * else the basename.
 */
export function displayPath(path: string, ctx: PathContext): string {
  const p = path.replace(/\\/g, "/").replace(/^file:\/\//, "")
  if (!isAbsolute(p)) return p.replace(/^\.\//, "")
  const cwd = ctx.cwd ? trimTrailingSlashes(ctx.cwd.replace(/\\/g, "/")) : ctx.cwd
  if (cwd) {
    if (p.startsWith(`${cwd}/`) && p.length > cwd.length + 1) return p.slice(cwd.length + 1)
  }
  const worktree = afterWorktree(p)
  if (worktree) return worktree
  const appSession = after(p, `/sessions/${ctx.sessionId}/`)
  if (appSession) return appSession
  const short = shortName(ctx.sessionId)
  const repoName = ctx.repo ? repoFolderName(ctx.repo) : "[^/]+"
  const clone = new RegExp(
    `/sessions/${escapeRe(short)}/${ctx.repo ? escapeRe(repoName) : repoName}/(.+)$`,
  ).exec(p)
  if (clone?.[1]) return clone[1]
  if (ctx.folderName) {
    const inFolder = after(p, `/${ctx.folderName}/`)
    if (inFolder) return inFolder
  }
  return basename(p) || ctx.folderName || ""
}

// An absolute path inside free text: an optional `file://`, then `/`, `~/` or a
// drive (`C:\\`, `d:/`), then at least two segments. A segment may hold inner
// spaces ("Liaison Node") only when another separator follows it, so the last
// segment never swallows the prose after the path. Any root counts (/opt,
// /etc, /srv…): the charter allows no absolute local path at all.
const SEG = /[^\\/\s'"`<>|()[\]{},;?]+/.source
const SEG_SP = `${SEG}(?: ${SEG}){0,4}`
const ROOT = /(?:file:\/\/)?(?:~|[A-Za-z]:)?/.source
const ABS = `${ROOT}(?:[\\\\/]${SEG_SP}(?=[\\\\/]))+[\\\\/]${SEG}`
const LEAD = /(^|[\s'"`(=[:,>|;{])/.source
const LOCAL_PATH = new RegExp(`${LEAD}(${ABS})`, "g")
// A quoted absolute path may end in a segment with spaces ('/Users/me/Liaison Node').
const QUOTED_PATH = /(['"`])((?:file:\/\/)?(?:~|[A-Za-z]:)?[\\/][^'"`\n]*[^'"`\n\s])\1/g
const TRAILING = /[.:,!]+$/

function shownPath(p: string, ctx: PathContext): { shown: string; tail: string } {
  const tail = p.match(TRAILING)?.[0] ?? ""
  const bare = tail ? p.slice(0, -tail.length) : p
  return { shown: displayPath(bare, ctx) || "…", tail }
}

/** Stands in for a shell-escaped space while paths are matched (a private-use character). */
const ESCAPED_SPACE = "\uE000"
const unescapeSpaces = (p: string) => p.replace(new RegExp(ESCAPED_SPACE, "g"), " ")
const WORKTREE_PREFIX = /(^|[\s'"`(=[:,>|;{])(?:[^\s'"`]*\/)?worktrees\/[^/\s'"`]+\/(?=[^\s'"`])/g

/**
 * Text (agent prose, a command, a tool's output) with every absolute path
 * shown as `displayPath` shows it: the charter allows no absolute local path
 * outside the folder chip's tooltip.
 */
export function relativizePaths(text: string, ctx: PathContext): string {
  if (!text) return text
  // Walk D16: a shell-escaped space ("Liaison\ Node") stays inside its path
  // segment while the path is matched, then is put back where it is kept.
  const escaped = text.includes("\\ ")
  const work = escaped ? text.replace(/\\ /g, ESCAPED_SPACE) : text
  const out = work
    .replace(QUOTED_PATH, (_m, q: string, p: string) => {
      if (!/^(?:file:\/\/)?(?:~|[A-Za-z]:)?[\\/][^\\/]/.test(p)) return `${q}${p}${q}`
      return `${q}${displayPath(unescapeSpaces(p), ctx) || "…"}${q}`
    })
    .replace(LOCAL_PATH, (_m, lead: string, p: string) => {
      const { shown, tail } = shownPath(unescapeSpaces(p), ctx)
      return `${lead}${shown}${tail}`
    })
    // A relative path through the node's worktrees ("Liaison Node/worktrees/<seg>/x") shows x.
    .replace(WORKTREE_PREFIX, "$1")
  return escaped ? out.replace(new RegExp(ESCAPED_SPACE, "g"), "\\ ") : out
}
