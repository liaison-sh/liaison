// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stand-in's answers, in GitHub's REST shapes, for the reads the GitHub
// app makes (`bundled-apps/github/src/client.ts`, `tools.ts`,
// `provisioning.ts`): the token's user and the owner, the repositories,
// commits (with `sha`, `path`, `since`, `until` and `author`), one commit with
// its files, pull requests (with `state`, `base`, `sort` and `direction`) and
// their files, contents, search, and empty issue, milestone, label, release and
// tag lists. Lists page as GitHub does (`per_page`, `page`, `Link: rel="next"`
// on api.github.com). No `x-oauth-scopes` header is sent: the token reads as a
// fine-grained one.
//
// Another owner's repository, an unknown path and a commit the history does
// not hold answer GitHub's 404, so the app's own "could not see" path speaks.
// Anything but a read is refused in words and nothing is kept. Every link
// handed out lives on the stand-in's reserved host.
//
// History is cut at the present: a commit dated after it has not happened yet.
import { demoGithubAnchorOf } from "./connection"
import { type StandInCommit, type StandInPull, standInHistory } from "./fixture"
import {
  DEMO_GITHUB_OWNER,
  DEMO_GITHUB_READER_LOGIN,
  GITHUB_API_HOST,
  GITHUB_STANDIN_HOST,
} from "./sentinel"

const WEB = `https://${GITHUB_STANDIN_HOST}`
const DOCS = `${WEB}/docs`

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

const notFound = () => json(404, { message: "Not Found", documentation_url: DOCS })

function iso(d: Date): string {
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z")
}

/** One page of `rows`, with GitHub's `Link` header when more are left. */
function paged(url: URL, rows: unknown[], wrap?: (items: unknown[]) => unknown): Response {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page")) || 30))
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1)
  const items = rows.slice((page - 1) * perPage, page * perPage)
  const headers: Record<string, string> = {}
  if (page * perPage < rows.length) {
    const next = new URL(url.toString())
    next.searchParams.set("page", String(page + 1))
    headers.link = `<https://${GITHUB_API_HOST}${next.pathname}${next.search}>; rel="next"`
  }
  return json(200, wrap ? wrap(items) : items, headers)
}

function personShape(p: { login: string }) {
  return { login: p.login, type: "User", html_url: `${WEB}/${p.login}` }
}

function commitShape(c: StandInCommit, detail: boolean) {
  const actor = { name: c.author.name, email: c.author.email, date: iso(c.date) }
  return {
    sha: c.sha,
    html_url: `${WEB}/${DEMO_GITHUB_OWNER}/${c.repo}/commit/${c.sha}`,
    commit: { message: c.message, author: actor, committer: actor },
    author: personShape(c.author),
    committer: personShape(c.author),
    parents: c.parents.map((sha) => ({ sha })),
    ...(detail
      ? {
          stats: {
            additions: 12 * c.files.length,
            deletions: 3 * c.files.length,
            total: 15 * c.files.length,
          },
          files: c.files.map((f) => fileShape(f, c)),
        }
      : {}),
  }
}

function fileShape(path: string, c: { taskKeys: string[] }) {
  return {
    filename: path,
    status: "modified",
    additions: 12,
    deletions: 3,
    patch: `@@ -1,3 +1,12 @@\n // ${c.taskKeys.join(", ")}\n+// Stand-in change: the services world's demo history holds no real code.`,
  }
}

function pullShape(p: StandInPull, latest: Date) {
  const updated = p.mergedAt ?? latest
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.mergedAt ? "closed" : "open",
    draft: false,
    base: { ref: "main" },
    head: { ref: p.head },
    user: personShape(p.author),
    assignees: [personShape(p.author)],
    labels: [],
    milestone: null,
    created_at: iso(p.createdAt),
    updated_at: iso(updated),
    merged_at: p.mergedAt ? iso(p.mergedAt) : null,
    closed_at: p.mergedAt ? iso(p.mergedAt) : null,
    html_url: `${WEB}/${DEMO_GITHUB_OWNER}/${p.repo}/pull/${p.number}`,
  }
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

function parseDate(v: string | null): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** The stand-in's answer to one request of an org holding the services world. */
export async function answerDemoGithub(request: {
  orgId: string
  url: string
  method: string
}): Promise<Response> {
  if (String(request.method).toUpperCase() !== "GET") {
    return json(405, {
      message:
        "This GitHub is the services world's demo stand-in: it answers reads only, and nothing was written.",
      documentation_url: DOCS,
    })
  }
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return notFound()
  }
  if (url.hostname.toLowerCase() !== GITHUB_API_HOST) return notFound()
  const anchor = await demoGithubAnchorOf(request.orgId)
  if (!anchor) {
    return json(403, {
      message:
        "This organization holds no services world GitHub stand-in, so nothing was read and nothing was sent to GitHub.",
      documentation_url: DOCS,
    })
  }
  const now = Date.now()
  const history = standInHistory(anchor)
  const visible = (repo: string) =>
    (history.commits.get(repo) ?? []).filter((c) => c.date.getTime() <= now)
  /** A pull request merged after the present reads as still open. */
  const pullVisible = (p: StandInPull): StandInPull =>
    p.mergedAt && p.mergedAt.getTime() > now ? { ...p, mergedAt: null } : p
  const owner = DEMO_GITHUB_OWNER.toLowerCase()
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  const isOwner = (name: string | undefined) => (name ?? "").toLowerCase() === owner

  const repoShape = (name: string) => {
    const repo = history.repos.find((r) => r.name === name)
    if (!repo) return null
    const latest = visible(name)[0]?.date ?? repo.createdAt
    return {
      name: repo.name,
      full_name: `${DEMO_GITHUB_OWNER}/${repo.name}`,
      owner: { login: DEMO_GITHUB_OWNER, type: "Organization" },
      private: true,
      html_url: `${WEB}/${DEMO_GITHUB_OWNER}/${repo.name}`,
      description: repo.description,
      default_branch: "main",
      archived: false,
      created_at: iso(repo.createdAt),
      updated_at: iso(latest),
      pushed_at: iso(latest),
    }
  }
  const allRepos = () =>
    history.repos.filter((r) => r.createdAt.getTime() <= now).map((r) => repoShape(r.name))

  // The token's user and the owner (the connect probe, `config verify`).
  if (parts[0] === "user" && parts.length === 1) {
    return json(200, {
      login: DEMO_GITHUB_READER_LOGIN,
      type: "User",
      name: "Services world reader",
    })
  }
  if (parts[0] === "user" && parts[1] === "repos" && parts.length === 2) {
    return paged(url, allRepos())
  }
  if (parts[0] === "users" && parts.length === 2) {
    if (!isOwner(parts[1])) return notFound()
    return json(200, {
      login: DEMO_GITHUB_OWNER,
      type: "Organization",
      html_url: `${WEB}/${DEMO_GITHUB_OWNER}`,
    })
  }
  if ((parts[0] === "orgs" || parts[0] === "users") && parts[2] === "repos" && parts.length === 3) {
    return isOwner(parts[1]) ? paged(url, allRepos()) : notFound()
  }
  if (parts[0] === "search" && parts.length === 2) return search(url, parts[1] ?? "")

  if (parts[0] !== "repos" || !isOwner(parts[1])) return notFound()
  const name = parts[2] ?? ""
  const repo = repoShape(name)
  if (!repo) return notFound()
  const rest = parts.slice(3)
  if (rest.length === 0) return json(200, repo)
  const commits = visible(name)
  const pulls = (history.pulls.get(name) ?? []).filter((p) => p.createdAt.getTime() <= now)
  const latest = new Date(Math.min(now, commits[0]?.date.getTime() ?? now))
  const bySha = (sha: string) =>
    sha.length >= 4
      ? commits.find((c) => c.sha === sha || c.sha.startsWith(sha.toLowerCase()))
      : undefined

  switch (rest[0]) {
    case "commits": {
      if (rest.length === 2) {
        const c = bySha(rest[1] ?? "")
        return c
          ? json(200, commitShape(c, true))
          : json(422, { message: `No commit found for SHA: ${rest[1]}`, documentation_url: DOCS })
      }
      let list = commits
      const sha = url.searchParams.get("sha")
      if (sha && sha !== "main") {
        const pr = pulls.find((p) => p.head === sha)
        if (pr) list = list.filter((c) => pr.commitShas.includes(c.sha))
        else {
          const tip = bySha(sha)
          if (!tip) return notFound()
          list = list.filter((c) => c.date.getTime() <= tip.date.getTime())
        }
      }
      const since = parseDate(url.searchParams.get("since"))
      const until = parseDate(url.searchParams.get("until"))
      const path = url.searchParams.get("path")
      const author = url.searchParams.get("author")?.toLowerCase()
      list = list.filter(
        (c) =>
          (since === null || c.date.getTime() >= since) &&
          (until === null || c.date.getTime() <= until) &&
          (!path ||
            c.files.some((f) => f === path || f.startsWith(`${path.replace(/\/$/, "")}/`))) &&
          (!author ||
            c.author.login.toLowerCase() === author ||
            c.author.email.toLowerCase() === author),
      )
      return paged(
        url,
        list.map((c) => commitShape(c, false)),
      )
    }
    case "pulls": {
      if (rest.length >= 2) {
        const n = Number(rest[1])
        const found = pulls.find((p) => p.number === n)
        if (!found) return notFound()
        const p = pullVisible(found)
        if (rest.length === 2) return json(200, pullShape(p, latest))
        if (rest[2] === "files" && rest.length === 3) {
          const files = [
            ...new Set(commits.filter((c) => p.commitShas.includes(c.sha)).flatMap((c) => c.files)),
          ]
          return paged(
            url,
            files.map((f) => fileShape(f, p)),
          )
        }
        if (rest[2] === "commits" && rest.length === 3) {
          return paged(
            url,
            commits
              .filter((c) => p.commitShas.includes(c.sha))
              .reverse()
              .map((c) => commitShape(c, false)),
          )
        }
        return notFound()
      }
      const state = url.searchParams.get("state") ?? "open"
      const baseRef = url.searchParams.get("base")
      const sort = url.searchParams.get("sort") === "updated" ? "updated" : "created"
      const asc = url.searchParams.get("direction") === "asc"
      const rows = pulls
        .map(pullVisible)
        .filter((p) => state === "all" || (state === "open" ? !p.mergedAt : !!p.mergedAt))
        .filter(() => !baseRef || baseRef === "main")
        .map((p) => ({
          p,
          key: (sort === "updated" ? (p.mergedAt ?? latest) : p.createdAt).getTime(),
        }))
        .sort((a, b) => (asc ? a.key - b.key : b.key - a.key) || b.p.number - a.p.number)
        .map(({ p }) => pullShape(p, latest))
      return paged(url, rows)
    }
    case "issues":
    case "milestones":
    case "labels":
    case "releases":
    case "tags":
      return rest.length === 1 ? paged(url, []) : notFound()
    case "contents":
      return contents(name, rest.slice(1), commits)
    default:
      return notFound()
  }

  function contents(repoName: string, path: string[], list: StandInCommit[]): Response {
    const files = [...new Set(list.flatMap((c) => c.files))].sort()
    const entry = (p: string, type: "file" | "dir") => ({
      type,
      name: p.split("/").pop() ?? p,
      path: p,
      sha: p,
      size: type === "file" ? 120 : 0,
      html_url: `${WEB}/${DEMO_GITHUB_OWNER}/${repoName}/blob/main/${p}`,
    })
    const readme = `# ${repoName}\n\nThe services world's demo stand-in repository: its history is fictional and holds no real code.\n`
    const joined = path.join("/")
    if (joined === "") return json(200, [entry("README.md", "file"), entry("src", "dir")])
    if (joined === "src")
      return json(
        200,
        files.map((f) => entry(f, "file")),
      )
    if (joined === "README.md")
      return json(200, {
        ...entry("README.md", "file"),
        encoding: "base64",
        content: base64(readme),
      })
    if (files.includes(joined)) {
      const keys = list.filter((c) => c.files.includes(joined)).flatMap((c) => c.taskKeys)
      const text = `// ${[...new Set(keys)].join(", ")}\n// Stand-in file: the services world's demo history holds no real code.\n`
      return json(200, { ...entry(joined, "file"), encoding: "base64", content: base64(text) })
    }
    return notFound()
  }

  function search(u: URL, kind: string): Response {
    const q = u.searchParams.get("q") ?? ""
    const scoped = [...q.matchAll(/(?:^|\s)(repo|org|user|owner):(\S+)/gi)]
    for (const m of scoped) {
      const value = (m[2] ?? "").replace(/"/g, "")
      const ownerPart = m[1]?.toLowerCase() === "repo" ? value.split("/")[0] : value
      if (!isOwner(ownerPart))
        return paged(u, [], (items) => ({ total_count: 0, incomplete_results: false, items }))
    }
    const repoFilter = scoped.find((m) => m[1]?.toLowerCase() === "repo")?.[2]?.split("/")[1]
    const isPr = /(?:^|\s)is:pr\b/i.test(q)
    const words = q
      .replace(/(?:^|\s)[a-z_-]+:("[^"]*"|\S+)/gi, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w))
    const repos = history.repos.map((r) => r.name).filter((r) => !repoFilter || r === repoFilter)
    const wrap = (items: unknown[], total: number) => ({
      total_count: total,
      incomplete_results: false,
      items,
    })
    if (kind === "commits") {
      const rows = repos.flatMap((r) =>
        visible(r)
          .filter((c) => matches(c.message))
          .map((c) => ({
            ...commitShape(c, false),
            repository: { full_name: `${DEMO_GITHUB_OWNER}/${r}` },
          })),
      )
      return paged(u, rows, (items) => wrap(items, rows.length))
    }
    if (kind === "issues" && isPr) {
      const rows = repos.flatMap((r) =>
        (history.pulls.get(r) ?? [])
          .filter((p) => p.createdAt.getTime() <= now && matches(`${p.title}\n${p.body}`))
          .map((p) => ({ ...pullShape(pullVisible(p), new Date(now)), pull_request: {} })),
      )
      return paged(u, rows, (items) => wrap(items, rows.length))
    }
    return paged(u, [], (items) => wrap(items, 0))
  }
}
