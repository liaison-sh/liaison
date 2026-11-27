// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison apps ...`: an org's own app, built by the server's app builder from
// the files in a local folder.
//
// The folder holds the builder's files (app.manifest.json, handlers.ts, and
// optionally ui.tsx and README.md, 512 KiB in all), plus `.liaison/app.json`
// (which draft, on which host) and `tests/*.json` fixtures for `apps test`.
// Nothing is built or installed locally: `push` saves the files as the draft's
// next version and runs the server's build and type check, `test` runs tools
// in the server's read-only preview, `publish` asks for a person's approval.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bool, flag, type ParsedArgs } from "./args"
import { clientFor, type Io } from "./auth"
import { ApiError, CliError, type Client } from "./http"
import { confirmTyped } from "./prompt"

export const DRAFT_FILES = ["app.manifest.json", "handlers.ts", "ui.tsx", "README.md"] as const
const LINK = join(".liaison", "app.json")

interface AppLink {
  host: string
  profile: string
  draftId: string
  appName: string
  baseName: string
}

interface BuildError {
  file?: string
  line?: number
  message: string
  code?: string
}

function dirOf(args: ParsedArgs): string {
  return resolve(flag(args, "dir") ?? ".")
}

function readLink(dir: string): AppLink {
  const path = join(dir, LINK)
  if (!existsSync(path)) {
    throw new CliError(
      `${dir} is not a Liaison app folder (no ${LINK}). Run liaison apps init <name> first, or pass --dir.`,
    )
  }
  return JSON.parse(readFileSync(path, "utf8")) as AppLink
}

function writeLink(dir: string, link: AppLink): void {
  mkdirSync(join(dir, ".liaison"), { recursive: true })
  writeFileSync(join(dir, LINK), `${JSON.stringify(link, null, 2)}\n`)
}

/** The client of the folder's host: the profile it was made with unless --profile says otherwise. */
function linkedClient(args: ParsedArgs, link: AppLink): Client {
  const client = clientFor(flag(args, "profile") ? args : withProfile(args, link.profile))
  if (client.host !== link.host) {
    throw new CliError(
      `This app lives on ${link.host}, but profile ${client.profile} is ${client.host}. Pass --profile.`,
    )
  }
  return client
}

function withProfile(args: ParsedArgs, profile: string): ParsedArgs {
  const flags = new Map(args.flags)
  flags.set("profile", [profile])
  return { ...args, flags }
}

function localFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of DRAFT_FILES) {
    const path = join(dir, name)
    if (existsSync(path)) out[name] = readFileSync(path, "utf8")
  }
  if (!out["app.manifest.json"] || !out["handlers.ts"]) {
    throw new CliError(`${dir} needs app.manifest.json and handlers.ts.`)
  }
  return out
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) => {
  const h = (f: Record<string, string>) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          Object.keys(f)
            .sort()
            .map((k) => [k, f[k]]),
        ),
      )
      .digest("hex")
  return h(a) === h(b)
}

function printErrors(io: Io, errors: BuildError[]): void {
  for (const e of errors) {
    const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}: ` : ""
    io.err(`  ${where}${e.message}${e.code ? ` [${e.code}]` : ""}`)
  }
}

interface DraftRead {
  draft: { id: string; baseName: string; status: string }
  appName: string
  version: { n: number; files: Record<string, string> }
}

// ---------------------------------------------------------------------------

export async function init(args: ParsedArgs, io: Io): Promise<void> {
  const base = args.positionals[0]
  if (!base)
    throw new CliError(
      "Usage: liaison apps init <name> [--title <title>] [--template store-crud|read-only] [--dir <folder>]",
    )
  const dir = resolve(flag(args, "dir") ?? base)
  if (existsSync(join(dir, LINK)))
    throw new CliError(`${dir} is already linked to an app (${LINK}).`)
  for (const f of DRAFT_FILES) {
    if (existsSync(join(dir, f)))
      throw new CliError(`${join(dir, f)} exists: init writes a new folder. Use --dir.`)
  }
  const client = clientFor(args)
  const title = flag(args, "title") ?? base
  const created = await client.request<{
    draftId: string
    appName: string
    n: number
    files: Record<string, string>
  }>("POST", "/api/apps/builder/drafts", {
    base_name: base,
    title,
    template: flag(args, "template") ?? "store-crud",
  })
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(created.files)) writeFileSync(join(dir, name), text)
  writeLink(dir, {
    host: client.host,
    profile: client.profile,
    draftId: created.draftId,
    appName: created.appName,
    baseName: base,
  })
  mkdirSync(join(dir, "tests"), { recursive: true })
  io.out(`Created ${created.appName} (draft ${created.draftId}) in ${dir}`)
  io.out("Edit the files, then: liaison apps push, liaison apps test, liaison apps publish --wait")
}

/** Push when the local files differ from the draft's latest version; returns the version. */
async function pushIfChanged(
  client: Client,
  link: AppLink,
  dir: string,
  message: string,
  io: Io,
): Promise<number> {
  const files = localFiles(dir)
  const current = await client.request<DraftRead>("GET", `/api/apps/builder/drafts/${link.draftId}`)
  if (sameFiles(files, current.version.files)) return current.version.n
  const pushed = await client.request<{ n: number }>(
    "PUT",
    `/api/apps/builder/drafts/${link.draftId}/files`,
    {
      files,
      mode: "full",
      message,
    },
  )
  io.out(`Pushed version ${pushed.n} of ${link.appName}.`)
  return pushed.n
}

async function check(client: Client, link: AppLink, n: number, io: Io): Promise<boolean> {
  const result = await client.request<{
    ok: boolean
    errors: BuildError[]
    typecheck: { ok: boolean; errors: BuildError[] } | null
    appVersion: string
  }>("POST", `/api/apps/builder/drafts/${link.draftId}/check`, { n })
  if (result.ok) {
    io.out(`Version ${n} builds and type-checks (would publish as ${result.appVersion}).`)
    return true
  }
  io.err(`Version ${n} does not build:`)
  printErrors(io, [...result.errors, ...(result.typecheck?.errors ?? [])])
  return false
}

export async function push(args: ParsedArgs, io: Io): Promise<number> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const n = await pushIfChanged(
    client,
    link,
    dir,
    flag(args, "message") ?? "Pushed from the liaison CLI",
    io,
  )
  return (await check(client, link, n, io)) ? 0 : 1
}

export async function pull(args: ParsedArgs, io: Io): Promise<void> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const n = flag(args, "n")
  const read = await client.request<DraftRead>(
    "GET",
    `/api/apps/builder/drafts/${link.draftId}`,
    undefined,
    {
      query: { n },
    },
  )
  for (const [name, text] of Object.entries(read.version.files))
    writeFileSync(join(dir, name), text)
  io.out(`Wrote version ${read.version.n}'s files to ${dir}.`)
}

interface Fixture {
  file: string
  kind: "tool" | "job" | "webhook"
  name: string
  params: Record<string, unknown>
  expect?: unknown
  /** true: any refusal passes; a string: only a refusal with that error code. */
  expectError?: boolean | string
}

function readFixtures(dir: string): Fixture[] {
  const folder = join(dir, "tests")
  if (!existsSync(folder)) return []
  const out: Fixture[] = []
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const raw = JSON.parse(readFileSync(join(folder, file), "utf8")) as Record<string, unknown>
    const list = Array.isArray(raw) ? raw : [raw]
    for (const f of list as Record<string, unknown>[]) {
      const kind = f.job ? "job" : f.webhook ? "webhook" : "tool"
      const name = String(f.tool ?? f.job ?? f.webhook ?? "")
      if (!name) throw new CliError(`tests/${file}: each case names a "tool" (or "job", "webhook")`)
      out.push({
        file,
        kind,
        name,
        params: (f.params as Record<string, unknown>) ?? {},
        ...(f.expect !== undefined ? { expect: f.expect } : {}),
        ...(f.expectError === true || (typeof f.expectError === "string" && f.expectError !== "")
          ? { expectError: f.expectError as true | string }
          : {}),
      })
    }
  }
  return out
}

/** Every key of `want` is in `got` with the same value (deep, arrays by position). */
export function matches(got: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object") return Object.is(got, want)
  if (Array.isArray(want)) {
    return Array.isArray(got) && want.every((w, i) => matches(got[i], w))
  }
  if (got === null || typeof got !== "object") return false
  return Object.entries(want as Record<string, unknown>).every(([k, v]) =>
    matches((got as Record<string, unknown>)[k], v),
  )
}

export async function test(args: ParsedArgs, io: Io): Promise<number> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const n = bool(args, "no-push")
    ? (await client.request<DraftRead>("GET", `/api/apps/builder/drafts/${link.draftId}`)).version.n
    : await pushIfChanged(client, link, dir, "Pushed by liaison apps test", io)
  const tool = flag(args, "tool")
  const cases: Fixture[] = tool
    ? [
        {
          file: "(command line)",
          kind: "tool",
          name: tool,
          params: JSON.parse(flag(args, "params") ?? "{}"),
        },
      ]
    : readFixtures(dir)
  if (cases.length === 0) {
    io.out(
      'No test cases. Add tests/<name>.json files like {"tool": "list_items", "params": {}, "expect": {...}}, or pass --tool <name> --params <json>.',
    )
    return 1
  }
  let failed = 0
  let first = true
  for (const tc of cases) {
    const fresh = first && bool(args, "fresh")
    first = false
    const r = await client.request<{
      ok: boolean
      result?: unknown
      error?: { message?: string; code?: string }
      logs: Array<{ level: string; message: string }>
    }>("POST", `/api/apps/builder/drafts/${link.draftId}/preview`, {
      n,
      entry: { kind: tc.kind, name: tc.name },
      params: tc.params,
      ...(fresh ? { freshStore: true } : {}),
    })
    let pass = tc.expectError ? !r.ok : r.ok
    // A refusal test names its code, so it cannot pass on another refusal by accident.
    if (pass && typeof tc.expectError === "string") pass = r.error?.code === tc.expectError
    if (pass && tc.expect !== undefined) pass = matches(r.result, tc.expect)
    if (!pass) failed++
    io.out(`${pass ? "PASS" : "FAIL"} ${tc.file} ${tc.kind} ${tc.name}`)
    if (!pass || bool(args, "verbose")) {
      if (r.ok) io.out(`  result: ${JSON.stringify(r.result)}`)
      else
        io.out(
          `  error: ${r.error?.message ?? "unknown"}${r.error?.code ? ` [${r.error.code}]` : ""}`,
        )
      if (tc.expect !== undefined) io.out(`  expected: ${JSON.stringify(tc.expect)}`)
    }
    if (bool(args, "verbose")) for (const l of r.logs) io.out(`  log ${l.level}: ${l.message}`)
  }
  io.out(`${cases.length - failed} passed, ${failed} failed (version ${n}, read-only preview).`)
  return failed === 0 ? 0 : 1
}

interface PublishAnswer {
  status?: string
  approvalId?: string
  summary?: { title?: string; lines?: string[] }
  appVersion?: string
  version?: string
}

/** Follow an approval until it is decided (or `timeoutMs` passes). */
/** Approval statuses that are not a decision yet. */
const IN_FLIGHT = new Set(["pending", "approving"])

async function waitForApproval(
  client: Client,
  approvalId: string,
  io: Io,
  timeoutMs: number,
): Promise<{ status: string; result: unknown }> {
  const deadline = Date.now() + timeoutMs
  let said = false
  while (Date.now() < deadline) {
    const r = await client.request<{ status: string; result: unknown }>(
      "GET",
      `/api/approvals/${approvalId}/result`,
    )
    // "approving": a person approved and the install is running (the web app's undo window,
    // then the install itself). Only a final status ends the wait.
    if (!IN_FLIGHT.has(r.status)) return r
    if (!said) {
      io.out("Waiting for the approval (Ctrl-C stops waiting; the request stays open)...")
      said = true
    }
    await new Promise((res) => setTimeout(res, Number(process.env.LIAISON_CLI_POLL_MS ?? 5000)))
  }
  return { status: "pending", result: null }
}

async function publishVersion(
  client: Client,
  link: AppLink,
  n: number | undefined,
  args: ParsedArgs,
  io: Io,
): Promise<number> {
  let answer: { status: number; data: PublishAnswer }
  try {
    answer = await client.requestWithStatus<PublishAnswer>(
      "POST",
      `/api/apps/builder/drafts/${link.draftId}/publish`,
      n ? { n } : {},
    )
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    io.err(`Not published: ${err.message}${err.code ? ` [${err.code}]` : ""}`)
    const errors = (err.details as { errors?: BuildError[] } | undefined)?.errors
    if (Array.isArray(errors)) printErrors(io, errors)
    return 1
  }
  const { status, data } = answer
  const approvalId = data.approvalId
  if (status !== 202 || !approvalId) {
    io.out(`Published ${link.appName} ${String(data.appVersion ?? data.version ?? "")}.`)
    return 0
  }
  io.out(`Publishing ${link.appName} waits for approval ${approvalId}. The card says:`)
  for (const line of data.summary?.lines ?? []) io.out(`  ${line}`)
  io.out(
    "A person holding kernel:apps:admin approves it in Liaison (the approval card shows the version, its package sha and what access changes). It is NOT installed until then.",
  )
  if (!bool(args, "wait")) {
    io.out(`Follow it with: liaison approvals wait ${approvalId}`)
    return 0
  }
  const minutes = Number(flag(args, "timeout") ?? "30")
  const decided = await waitForApproval(client, approvalId, io, minutes * 60_000)
  if (decided.status === "approved") {
    const r = (decided.result ?? {}) as Record<string, unknown>
    io.out(`Approved: ${link.appName} ${String(r.appVersion ?? r.version ?? "")} is installed.`)
    return 0
  }
  if (decided.status === "pending") {
    io.err(
      `Still waiting after ${minutes} min. The request stays open: liaison approvals wait ${approvalId}`,
    )
    return 2
  }
  io.err(`The approval was ${decided.status}. Nothing was installed.`)
  return 1
}

export async function publish(args: ParsedArgs, io: Io): Promise<number> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const n = flag(args, "n")
  if (!n) {
    const latest = await pushIfChanged(client, link, dir, "Pushed by liaison apps publish", io)
    if (!(await check(client, link, latest, io))) return 1
    return publishVersion(client, link, latest, args, io)
  }
  return publishVersion(client, link, Number(n), args, io)
}

interface Status {
  draftId: string
  title: string
  status: string
  appName: string
  latestVersion: number
  latestBuild: { ok?: boolean } | null
  installed: {
    version: string
    sha256: string
    draftVersion: number | null
    grantedScopes: string[]
    grantedDomains: string[]
  } | null
  publishes: Array<{ version: string | null; n: number | null; at: string; draftId: string | null }>
}

async function readStatus(client: Client, link: AppLink): Promise<Status> {
  return client.request<Status>("GET", `/api/apps/builder/drafts/${link.draftId}/status`)
}

export async function status(args: ParsedArgs, io: Io): Promise<void> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const s = await readStatus(client, link)
  io.out(`${s.appName} (${s.title}) on ${client.host}`)
  io.out(
    `draft ${s.draftId}: ${s.status}, latest version ${s.latestVersion}${s.latestBuild ? (s.latestBuild.ok ? " (builds)" : " (does not build)") : " (not built yet)"}`,
  )
  if (s.installed) {
    io.out(
      `installed: ${s.installed.version} (draft version ${s.installed.draftVersion ?? "?"}, sha256 ${s.installed.sha256.slice(0, 12)})`,
    )
    if (s.installed.grantedDomains.length)
      io.out(`outbound domains: ${s.installed.grantedDomains.join(", ")}`)
  } else {
    io.out("installed: no (publish it with liaison apps publish --wait)")
  }
  for (const p of s.publishes.slice(0, 5))
    io.out(`  published ${p.version ?? "?"} from draft version ${p.n ?? "?"} at ${p.at}`)
  const pending = await client
    .request<Array<{ id: string; toolName?: string; tool_name?: string; status: string }>>(
      "GET",
      "/api/approvals",
      undefined,
      {
        query: { status: "pending", requestedByMe: "true" },
      },
    )
    .catch(() => [])
  const mine = (Array.isArray(pending) ? pending : []).filter(
    (a) =>
      a.status === "pending" &&
      String(a.toolName ?? a.tool_name ?? "").includes("apps_build_publish"),
  )
  for (const a of mine) io.out(`  waiting for approval: ${a.id}`)
}

export async function list(args: ParsedArgs, io: Io): Promise<void> {
  const client = clientFor(args)
  const drafts = await client.request<
    Array<{
      id: string
      baseName: string
      title: string
      status: string
      publishedAppName: string | null
    }>
  >("GET", "/api/apps/builder/drafts")
  if (drafts.length === 0) io.out("No app drafts yet: liaison apps init <name>")
  for (const d of drafts)
    io.out(`${d.id}  ${d.publishedAppName ?? d.baseName}  ${d.status}  ${d.title}`)
}

export async function link(args: ParsedArgs, io: Io): Promise<void> {
  const draftId = args.positionals[0]
  if (!draftId)
    throw new CliError(
      "Usage: liaison apps link <draft id> [--dir <folder>] (liaison apps list shows the ids)",
    )
  const dir = dirOf(args)
  const client = clientFor(args)
  const read = await client.request<DraftRead>("GET", `/api/apps/builder/drafts/${draftId}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(read.version.files))
    writeFileSync(join(dir, name), text)
  writeLink(dir, {
    host: client.host,
    profile: client.profile,
    draftId,
    appName: read.appName,
    baseName: read.draft.baseName,
  })
  io.out(`Linked ${dir} to ${read.appName} (version ${read.version.n}).`)
}

/** The app's own read scopes, from the folder's manifest. */
function appReadScopes(dir: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8")) as {
      scopes?: unknown
    }
    return Array.isArray(m.scopes)
      ? m.scopes.filter((x): x is string => typeof x === "string" && x.endsWith(":read"))
      : []
  } catch {
    return []
  }
}

export async function logs(args: ParsedArgs, io: Io): Promise<void> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const level = flag(args, "level")
  const limit = flag(args, "limit")
  let since = flag(args, "since")
  const seen = new Set<string>()
  const print = (lines: Array<Record<string, unknown>>) => {
    const fresh = lines.filter((l) => !seen.has(String(l.id)))
    for (const l of fresh.reverse()) {
      seen.add(String(l.id))
      const at = String(l.at ?? l.createdAt ?? "")
      const fields =
        l.fields && Object.keys(l.fields as object).length ? ` ${JSON.stringify(l.fields)}` : ""
      io.out(`${at} ${String(l.level).toUpperCase()} ${String(l.message)}${fields}`)
      if (at && (!since || at > since)) since = at
    }
  }
  const read = () =>
    client.request<Array<Record<string, unknown>>>(
      "GET",
      `/api/apps/${link.appName}/logs`,
      undefined,
      {
        query: { level, limit, since },
      },
    )
  // The server shows a line only to a reader whose scopes cover what its run
  // could read: say which of the app's read scopes this sign-in lacks.
  const missing = appReadScopes(dir).filter((sc) => !client.scopes.includes(sc))
  if (missing.length > 0) {
    io.err(
      `Lines of runs that read ${missing.join(", ")} are hidden from this sign-in. To see them: liaison login --host ${client.host}${missing.map((m) => ` --scope ${m}`).join("")}`,
    )
  }
  print(await read())
  if (!bool(args, "follow")) return
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    print(await read())
  }
}

export async function rollback(args: ParsedArgs, io: Io): Promise<number> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const s = await readStatus(client, link)
  if (!s.installed) throw new CliError(`${link.appName} is not installed: nothing to roll back.`)
  let target = flag(args, "to") ? Number(flag(args, "to")) : undefined
  if (target === undefined) {
    const running = s.installed.draftVersion
    target = s.publishes.find((p) => p.n !== null && p.n !== running)?.n ?? undefined
    if (target === undefined)
      throw new CliError("No earlier published version to roll back to. Pass --to <draft version>.")
  }
  const restored = await client.request<{ n: number }>(
    "POST",
    `/api/apps/builder/drafts/${link.draftId}/restore`,
    { n: target },
  )
  io.out(
    `Draft version ${target}'s files are now version ${restored.n}. Publishing it (a new version number, the old files):`,
  )
  const code = await publishVersion(client, link, restored.n, args, io)
  io.out("Your local files are unchanged: liaison apps pull writes the restored version.")
  return code
}

/** D2: the person approves the app's interface running with their session, here. */
export async function uiConsent(args: ParsedArgs, io: Io): Promise<number> {
  const dir = dirOf(args)
  const link = readLink(dir)
  const client = linkedClient(args, link)
  const path = `/api/apps/${link.appName}/ui-approval`
  if (bool(args, "withdraw")) {
    await client.request("POST", path, { approved: false })
    io.out(`Withdrawn: ${link.appName}'s interface runs isolated again.`)
    return 0
  }
  if (!client.scopes.includes("kernel:apps:admin")) {
    throw new CliError(
      "Approving an app's interface needs kernel:apps:admin: sign in with liaison login --admin.",
    )
  }
  const s = await readStatus(client, link)
  if (!s.installed) throw new CliError(`${link.appName} is not installed yet.`)
  io.out(
    `You are about to let the interface (ui.tsx) of ${link.appName} ${s.installed.version} run inside Liaison's own page.`,
  )
  io.out("Until then the page shows to no one. Once approved, for every person who opens it:")
  io.out(
    "  - it runs with that person's signed-in session, on your organization's Liaison address;",
  )
  io.out(
    "  - it can read everything that person can read, and call any tool or API they can, as them;",
  )
  io.out("  - it can change or send things in their name, without asking them.")
  io.out(
    `The approval holds for version ${s.installed.version} only; a new version needs a new approval. You can withdraw it with --withdraw.`,
  )
  const yes = bool(args, "yes")
  if (!yes) {
    const ok = await confirmTyped(
      `Type the app's name (${link.appName}) to approve, anything else to cancel: `,
      link.appName,
    )
    if (!ok) {
      io.out("Cancelled. Nothing changed.")
      return 1
    }
  }
  try {
    await client.request("POST", path, { approved: true, confirm: link.appName })
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new CliError(`Refused: ${err.message}`)
    }
    throw err
  }
  io.out(
    `Approved: ${link.appName} ${s.installed.version}'s interface now runs with the session of the person using it.`,
  )
  return 0
}

export async function approvalsWait(args: ParsedArgs, io: Io): Promise<number> {
  const id = args.positionals[0]
  if (!id) throw new CliError("Usage: liaison approvals wait <approval id> [--timeout <minutes>]")
  const client = clientFor(args)
  const minutes = Number(flag(args, "timeout") ?? "30")
  const r = await waitForApproval(client, id, io, minutes * 60_000)
  io.out(`Approval ${id}: ${r.status}`)
  if (r.result) io.out(JSON.stringify(r.result, null, 2))
  return r.status === "approved" ? 0 : r.status === "pending" ? 2 : 1
}
