// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE'S FOLDERS, ASKED FOR FROM ANY CLIENT (owner-only).
//
// The owner (from the web, the phone or the desktop) and the owner's own
// approved agent tool ask the server; the server wakes the owner's node with a
// `node_folder_request` frame; the node pulls the request with its credential,
// runs it against its own settings (src-tauri/src/node_folders.rs), and puts
// the answer back. Both sides parse with these helpers.
//
// A request names folders by path only on the owner's own rows; the agent
// sees display paths (`~/Documents/x`) and opaque candidate ids.

/** What the server may ask a node about its folders. */
export type NodeFolderOp =
  | { kind: "list" }
  | { kind: "lookup"; query: string }
  /** A folder this node found (its own single-use `token`) or one of its recent folders (`path`). */
  | { kind: "share"; token: string }
  | { kind: "share"; path: string }
  | { kind: "unshare"; path: string }
  | { kind: "addSearchRoot"; path: string }
  | { kind: "removeSearchRoot"; path: string }
  | { kind: "clone"; url: string; name?: string }
  /** Every git repository inside the search roots. */
  | { kind: "scan" }
  /** Several folders a scan found, in one write (1 to 100 of the node's own tokens). */
  | { kind: "shareMany"; tokens: string[] }
  /** The repositories the computer's signed-in `gh` and `glab` list (takes no input). */
  | { kind: "remotes" }

export const NODE_FOLDER_OP_KINDS = [
  "list",
  "lookup",
  "share",
  "unshare",
  "addSearchRoot",
  "removeSearchRoot",
  "clone",
  "scan",
  "shareMany",
  "remotes",
] as const

/** At most this many tokens in one `shareMany`. */
export const NODE_SHARE_MANY_MAX = 100

/** The node's shared roots and search roots (the `list` answer, and every change's). */
export interface NodeFolderList {
  shared: {
    roots: string[]
    isDefault: boolean
    missing: string[]
    refused: string[]
    /**
     * The roots that are git repositories, with `origin`'s default branch when
     * known. Absent from a node before it said which roots are repositories.
     */
    repos?: Array<{ path: string; defaultBranch: string | null }>
  }
  search: {
    roots: string[]
    display: string[]
    missing: string[]
    /** Places the computer does not let Liaison read yet (`~/Documents`), as `~/…`. */
    denied: string[]
  }
}

/** One folder a lookup found, inside a search root. */
export interface NodeFolderCandidate {
  name: string
  path: string
  /** The node's own single-use proof that it found this folder (the only way to share it from the cloud). */
  token: string
  /** The path with the home folder as `~`. */
  display: string
  isRepo: boolean
  /** Already shared. */
  shared: boolean
  /** Could be shared (not the home folder or above it). */
  shareable: boolean
}

/** A lookup's answer: no search roots means nothing was searched. */
export interface NodeFolderLookup {
  searchRoots: number
  candidates: NodeFolderCandidate[]
  /** The node stopped searching early (time or budget): there may be more. */
  partial?: boolean
  /** Places the computer refused to let Liaison read (`~/Documents`): not searched. */
  denied?: string[]
  /**
   * The search ran on the implicit home default, which never enters the home
   * folder's protected folders (Documents, Desktop, Downloads).
   */
  skippedProtected?: boolean
}

/** Why a folder the node found cannot be shared as it is. */
export type NodeFolderRefusal = "home" | "hidden" | "outside_search"
const NODE_FOLDER_REFUSALS: readonly NodeFolderRefusal[] = ["home", "hidden", "outside_search"]

/**
 * One repository a scan found. A token only when it can be shared and is not
 * yet (else null, and `refusal` says why when it cannot).
 */
export interface NodeFolderScanCandidate {
  name: string
  path: string
  token: string | null
  display: string
  shared: boolean
  shareable: boolean
  refusal: NodeFolderRefusal | null
}

/** A scan's answer: the repositories inside the search roots (at most 500). */
export interface NodeFolderScan {
  searchRoots: number
  candidates: NodeFolderScanCandidate[]
  /** Stopped on its time or folder budget: there may be more. */
  partial?: boolean
  denied?: string[]
  skippedProtected?: boolean
}

/** A `shareMany` answer: the folders afterwards, and the tokens refused with their code. */
export type NodeFolderShareMany = NodeFolderList & {
  refused: Array<{ token: string; code: NodeFolderCode }>
}

export const NODE_REMOTE_TOOLS = ["gh", "glab"] as const
export type NodeRemoteTool = (typeof NODE_REMOTE_TOOLS)[number]
export const NODE_REMOTE_STATES = ["ok", "missing", "signed_out", "failed"] as const
export type NodeRemoteState = (typeof NODE_REMOTE_STATES)[number]

/** One repository the computer's signed-in tools list. */
export interface NodeRemoteRepo {
  source: "github" | "gitlab"
  /** `owner/name` (GitLab: the full namespace path). */
  fullName: string
  host: string
  /** Passes `nodeCloneUrlOk`; the tool's own protocol setting (https or ssh). */
  cloneUrl: string
  private: boolean
  /** Epoch milliseconds, or null when the tool did not say. */
  pushedAt: number | null
  /** A clone of it on this computer, matched by its `origin`. */
  local: { display: string; shared: boolean; token: string | null } | null
}

/** A `remotes` answer. */
export interface NodeRemotes {
  repos: NodeRemoteRepo[]
  sources: Array<{ tool: NodeRemoteTool; state: NodeRemoteState }>
  /** Repositories left out because their clone URL was refused. */
  dropped: number
}

/** What the node puts back: the answer, or the code of what refused it. */
export type NodeFolderResult = { ok: true; data: unknown } | { ok: false; code: string }

/**
 * The node's refusal codes (node_folders.rs) and the channel's own: each one
 * a sentence on screen, never shown raw.
 */
export const NODE_FOLDER_CODES = [
  "SharedRootRefused",
  "SharedRootMissing",
  "SharedRootHome",
  "SearchRootRefused",
  "SearchRootAboveHome",
  "SearchRootSystem",
  "ShareNotIssued",
  "ShareOutsideSearchRoots",
  "CloneUrlRefused",
  "CloneNameRefused",
  "CloneTargetExists",
  "CloneAuthFailed",
  "CloneHostUnreachable",
  "CloneNotFound",
  "CloneTimeout",
  "CloneTooLarge",
  "CloneFailed",
  "SharedRootsFull",
  "node_offline",
  "timeout",
  "failed",
] as const
export type NodeFolderCode = (typeof NODE_FOLDER_CODES)[number]

/** Any code the node may send, mapped onto the known ones (else `failed`). */
export function nodeFolderCode(raw: unknown): NodeFolderCode {
  return (NODE_FOLDER_CODES as readonly string[]).includes(String(raw))
    ? (String(raw) as NodeFolderCode)
    : "failed"
}

/**
 * A folder name as it may be shown anywhere (a card, an approval, the agent):
 * without control characters or bidirectional overrides, which could make
 * `app<RLO>gpj.exe` read as another name (node_folders.rs `clean_name`).
 */
export function cleanFolderName(name: string): string {
  return Array.from(name)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0
      return !(
        c < 0x20 ||
        (c >= 0x7f && c <= 0x9f) ||
        c === 0x200e ||
        c === 0x200f ||
        c === 0x061c ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)
      )
    })
    .join("")
}

/** A lookup query is a folder name (the node checks it the same way). */
export function nodeFolderQueryOk(query: string): boolean {
  const q = query.trim()
  return (
    q.length > 0 &&
    [...q].length <= 100 &&
    q !== "." &&
    q !== ".." &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    !/[/\\'"\u0000-\u001f\u007f]/.test(q)
  )
}

const MAX_PATH = 4096
/** A node's single-use proof: 16 random bytes in hex (node_folders.rs `CandidateTokens`). */
const TOKEN_RE = /^[0-9a-f]{32}$/

/**
 * A URL a node clones: `https://…`, `ssh://…` or scp-like `user@host:path`.
 * Never a local path, `file://`, a transport helper (`ext::`), whitespace, or
 * anything git would read as an option. The node checks it again
 * (node_folders.rs `clone_url_ok`).
 */
export function nodeCloneUrlOk(url: string): boolean {
  const u = url.trim()
  if (!u || u.length > 2048 || u.startsWith("-") || u.includes("::")) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[\s\u0000-\u001f\u007f]/.test(u)) return false
  // A user may name an account, never carry a password or read as an option.
  const userOk = (user: string) => user.length > 0 && !user.startsWith("-") && !user.includes(":")
  const scheme = /^(https|ssh):\/\/([^/]+)(\/.+)$/.exec(u)
  if (scheme) {
    const authority = scheme[2] as string
    const at = authority.lastIndexOf("@")
    if (at >= 0 && !userOk(authority.slice(0, at))) return false
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority
    const v6 = /^\[([^\]]+)\]/.exec(hostPort)
    const host = v6 ? (v6[1] as string) : (hostPort.split(":")[0] ?? "")
    return nodeCloneHostOk(host)
  }
  const scp = /^([A-Za-z0-9._-]+)@([^:/]+):(.+)$/.exec(u)
  if (scp) {
    const path = scp[3] as string
    return (
      userOk(scp[1] as string) &&
      nodeCloneHostOk(scp[2] as string) &&
      !path.startsWith("-") &&
      !path.startsWith("/")
    )
  }
  return false
}

/**
 * A host a node may clone from: a name or a public address. Never
 * `localhost`, a loopback, link-local, private-network or unspecified
 * address, nor a number that is an address in disguise (`2130706433`).
 */
export function nodeCloneHostOk(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (!h || h.startsWith("-") || !/^[a-z0-9.:-]+$/.test(h)) return false
  if (h === "localhost" || h.endsWith(".localhost")) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return false
    const first = Number.parseInt(h.split(":")[0] || "0", 16)
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
    return mapped ? nodeCloneHostOk(mapped[1] as string) : true
  }
  // Digits, dots and hex only, yet not an address: an address in disguise.
  const disguised = h.split(".").every((part) => /^[0-9a-fx]+$/.test(part)) && /\d/.test(h)
  return !disguised
}

/** The folder a URL clones into by default: its last path segment, `.git` off. */
export function nodeCloneDefaultName(url: string): string {
  const last = trimTrailingSlashes(url.trim()).split(/[/:]/).pop() ?? ""
  return last.replace(/\.git$/, "")
}

/** `s` without its trailing slashes, in one pass (a `/\/+$/` replace rescans each run of slashes). */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
}

/** A folder name a clone may take: a plain name, not hidden, not an option. */
export function nodeCloneNameOk(name: string): boolean {
  return nodeFolderQueryOk(name) && name.trim() === name && !/^[.-]/.test(name)
}

/** A request as the node pulls it, or null when it is not one. */
export function parseNodeFolderOp(raw: unknown): NodeFolderOp | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as { kind?: unknown; query?: unknown; path?: unknown; url?: unknown }
  switch (r.kind) {
    case "list":
      return { kind: "list" }
    case "lookup":
      return typeof r.query === "string" && nodeFolderQueryOk(r.query)
        ? { kind: "lookup", query: r.query.trim() }
        : null
    case "share": {
      const token = (raw as { token?: unknown }).token
      if (typeof token === "string") return TOKEN_RE.test(token) ? { kind: "share", token } : null
      return typeof r.path === "string" && r.path.trim().length > 0 && r.path.length <= MAX_PATH
        ? { kind: "share", path: r.path.trim() }
        : null
    }
    case "unshare":
    case "addSearchRoot":
    case "removeSearchRoot":
      return typeof r.path === "string" && r.path.trim().length > 0 && r.path.length <= MAX_PATH
        ? { kind: r.kind, path: r.path.trim() }
        : null
    case "clone": {
      if (typeof r.url !== "string" || !nodeCloneUrlOk(r.url)) return null
      const name = (raw as { name?: unknown }).name
      if (name === undefined || name === null || name === "")
        return { kind: "clone", url: r.url.trim() }
      return typeof name === "string" && nodeCloneNameOk(name)
        ? { kind: "clone", url: r.url.trim(), name }
        : null
    }
    case "scan":
      return { kind: "scan" }
    case "remotes":
      return { kind: "remotes" }
    case "shareMany": {
      const tokens = (raw as { tokens?: unknown }).tokens
      if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > NODE_SHARE_MANY_MAX)
        return null
      if (!tokens.every((t) => typeof t === "string" && TOKEN_RE.test(t))) return null
      return { kind: "shareMany", tokens: [...new Set(tokens as string[])] }
    }
    default:
      return null
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** A `list` answer, read defensively. */
export function parseNodeFolderList(raw: unknown): NodeFolderList {
  const r = (raw ?? {}) as { shared?: any; search?: any }
  const sharedRoots = strings(r.shared?.roots)
  const searchRoots = strings(r.search?.roots)
  const display = strings(r.search?.display)
  return {
    shared: {
      roots: sharedRoots,
      isDefault: r.shared?.isDefault === true,
      missing: strings(r.shared?.missing).filter((m) => sharedRoots.includes(m)),
      refused: strings(r.shared?.refused).filter((m) => sharedRoots.includes(m)),
      ...(Array.isArray(r.shared?.repos)
        ? {
            repos: (r.shared.repos as unknown[])
              .filter(
                (x): x is { path: string; defaultBranch?: unknown } =>
                  typeof (x as { path?: unknown } | null)?.path === "string" &&
                  sharedRoots.includes((x as { path: string }).path),
              )
              .map((x) => ({
                path: x.path,
                defaultBranch: typeof x.defaultBranch === "string" ? x.defaultBranch : null,
              })),
          }
        : {}),
    },
    search: {
      roots: searchRoots,
      display: searchRoots.map((root, i) => display[i] ?? root),
      missing: strings(r.search?.missing).filter((m) => searchRoots.includes(m)),
      denied: strings(r.search?.denied).slice(0, 20),
    },
  }
}

/** A `lookup` answer, read defensively. */
export function parseNodeFolderLookup(raw: unknown): NodeFolderLookup {
  const r = (raw ?? {}) as {
    searchRoots?: unknown
    candidates?: unknown
    partial?: unknown
    denied?: unknown
    skippedProtected?: unknown
  }
  const candidates = Array.isArray(r.candidates) ? r.candidates : []
  const denied = strings(r.denied).slice(0, 20)
  return {
    searchRoots: typeof r.searchRoots === "number" ? r.searchRoots : 0,
    ...(r.partial === true ? { partial: true } : {}),
    ...(denied.length > 0 ? { denied } : {}),
    ...(r.skippedProtected === true ? { skippedProtected: true } : {}),
    candidates: candidates
      .filter(
        (c: any) =>
          c &&
          typeof c.name === "string" &&
          typeof c.path === "string" &&
          c.path.length > 0 &&
          typeof c.token === "string" &&
          c.token.length > 0,
      )
      .map((c: any) => ({
        name: c.name,
        path: c.path,
        token: c.token,
        display: typeof c.display === "string" ? c.display : c.path,
        isRepo: c.isRepo === true,
        shared: c.shared === true,
        shareable: c.shareable !== false,
      })),
  }
}

const tokenOrNull = (v: unknown): string | null =>
  typeof v === "string" && TOKEN_RE.test(v) ? v : null

/** A `scan` answer, read defensively (a token is optional, unlike a lookup's). */
export function parseNodeFolderScan(raw: unknown): NodeFolderScan {
  const r = (raw ?? {}) as {
    searchRoots?: unknown
    candidates?: unknown
    partial?: unknown
    denied?: unknown
    skippedProtected?: unknown
  }
  const candidates = Array.isArray(r.candidates) ? r.candidates : []
  const denied = strings(r.denied).slice(0, 20)
  return {
    searchRoots: typeof r.searchRoots === "number" ? r.searchRoots : 0,
    ...(r.partial === true ? { partial: true } : {}),
    ...(denied.length > 0 ? { denied } : {}),
    ...(r.skippedProtected === true ? { skippedProtected: true } : {}),
    candidates: candidates
      .filter((c: any) => c && typeof c.name === "string" && typeof c.path === "string" && c.path)
      .slice(0, 500)
      .map((c: any) => {
        const shared = c.shared === true
        const token = shared ? null : tokenOrNull(c.token)
        const refusal = NODE_FOLDER_REFUSALS.includes(c.refusal)
          ? (c.refusal as NodeFolderRefusal)
          : null
        return {
          name: cleanFolderName(c.name),
          path: c.path,
          token,
          display: typeof c.display === "string" ? c.display : c.path,
          shared,
          shareable: !shared && token !== null,
          refusal: shared || token !== null ? null : (refusal ?? "outside_search"),
        }
      }),
  }
}

/** A `shareMany` answer, read defensively. */
export function parseNodeFolderShareMany(raw: unknown): NodeFolderShareMany {
  const refused = Array.isArray((raw as { refused?: unknown } | null)?.refused)
    ? ((raw as { refused: unknown[] }).refused as any[])
        .filter((x) => x && typeof x.token === "string")
        .map((x) => ({ token: x.token as string, code: nodeFolderCode(x.code) }))
    : []
  return { ...parseNodeFolderList(raw), refused }
}

/** A `remotes` answer, read defensively: a clone URL the node would refuse is dropped. */
export function parseNodeRemotes(raw: unknown): NodeRemotes {
  const r = (raw ?? {}) as { repos?: unknown; sources?: unknown; dropped?: unknown }
  let dropped = typeof r.dropped === "number" && r.dropped >= 0 ? Math.trunc(r.dropped) : 0
  const repos: NodeRemoteRepo[] = []
  for (const x of Array.isArray(r.repos) ? (r.repos as any[]) : []) {
    if (repos.length >= 1000) break
    if (!x || typeof x.fullName !== "string" || typeof x.host !== "string") continue
    if (typeof x.cloneUrl !== "string" || !nodeCloneUrlOk(x.cloneUrl)) {
      dropped++
      continue
    }
    const l = x.local
    repos.push({
      source: x.source === "gitlab" ? "gitlab" : "github",
      fullName: cleanFolderName(x.fullName).slice(0, 300),
      host: x.host,
      cloneUrl: x.cloneUrl.trim(),
      private: x.private === true,
      pushedAt: typeof x.pushedAt === "number" && Number.isFinite(x.pushedAt) ? x.pushedAt : null,
      local:
        l && typeof l === "object" && typeof l.display === "string"
          ? {
              display: l.display,
              shared: l.shared === true,
              token: l.shared === true ? null : tokenOrNull(l.token),
            }
          : null,
    })
  }
  const sources = (Array.isArray(r.sources) ? (r.sources as any[]) : [])
    .filter(
      (x) =>
        x &&
        (NODE_REMOTE_TOOLS as readonly string[]).includes(x.tool) &&
        (NODE_REMOTE_STATES as readonly string[]).includes(x.state),
    )
    .map((x) => ({ tool: x.tool as NodeRemoteTool, state: x.state as NodeRemoteState }))
  return { repos, sources, dropped }
}
