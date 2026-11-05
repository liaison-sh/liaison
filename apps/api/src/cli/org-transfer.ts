// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org transfer keys|export|import|estimate|purge-source`
//
// Moving one org from this instance to another (modules/org/transfer/). The
// bundle travels on stdout/stdin between the two processes, never through a
// file; the transfer keys (two one-time 64-hex values, one per key family) are
// the FIRST line of each side's stdin, never an argument, a variable or a file:
//
//   liaison org transfer keys                                  -> one keys line
//   (keys line) | liaison org transfer export <org id> --transfer <id>  -> bundle
//   (keys line + bundle) | liaison org transfer import [--dry-run]     -> JSON report
//   liaison org transfer estimate <org id>                     -> JSON report
//   liaison org transfer purge-source <org id> --transfer <id> -> JSON report
//   liaison org transfer agent --role target                   -> serves the source's commands
//   (operator line) | liaison org transfer agent --role source <org id> --transfer <id>
//       --target-cmd '<command that starts the target agent>'   -> progress lines, JSON report
//
// The agents (modules/org/transfer/agent-*.ts) run one move end to end: the
// source agent starts the target agent with `--target-cmd` (in production an
// ssh to the target over the private network whose forced command is
// `liaison org transfer agent --role target`) and speaks to it on its stdin
// and stdout. The source agent's first stdin line is the operator's
// credential for the control plane's move actions,
// `{"operator":{"control":"<webhook base>","operatorKey":"<key>"}}`, held in
// memory only.
//
// Both sides connect with MIGRATION_DATABASE_URL: the import writes with
// triggers off (`session_replication_role`), which takes a superuser or a role
// granted SET on that parameter. Each side keeps its own ENCRYPTION_KEY,
// BYOK_ENCRYPTION_KEY and JWT_SECRET. `import --dry-run` is the move's
// precheck: every refusal (skew, collision, an existing copy) without a write.
import { readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import postgres from "postgres"
import { env } from "~/lib/env"
import { estimateTransfer } from "~/modules/org/transfer/estimate"
import { exportOrg, type Fingerprint } from "~/modules/org/transfer/export"
import { MOVE_FAULT_POINTS, type MoveFaultPoint } from "~/modules/org/transfer/faults"
import { ImportRefused, importOrg } from "~/modules/org/transfer/import"
import { purgeTransferCopy } from "~/modules/org/transfer/purge"
import { generateTransferKeys, parseTransferKeys } from "~/modules/org/transfer/rekey"
import {
  assertMovedPurgeSafe,
  clearStorageProbe,
  probeVisibleHere,
  type StorageProbe,
  writeStorageProbe,
} from "~/modules/org/transfer/storage-identity"

export const ORG_TRANSFER_USAGE =
  "usage: liaison org transfer keys | export <org id> --transfer <id> [--since <file>] [--fingerprint-out <file>] | import [--dry-run] | estimate <org id> | purge-source <org id> --transfer <id> (probe line on stdin) | probe-write <org id> --transfer <id> | probe-clear (probe line on stdin) | agent --role target | agent --role source <org id> --transfer <id> --target-cmd <command> [--fail-at precopy|draining|frozen|after-cas]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type OrgTransferArgs =
  | { cmd: "keys" }
  | { cmd: "export"; orgId: string; transferId: string; since?: string; fingerprintOut?: string }
  | { cmd: "import"; dryRun: boolean }
  | { cmd: "estimate"; orgId: string }
  | { cmd: "purge-source"; orgId: string; transferId: string }
  | { cmd: "probe-write"; orgId: string; transferId: string }
  | { cmd: "probe-clear" }
  | { cmd: "agent"; role: "target" }
  | {
      cmd: "agent"
      role: "source"
      orgId: string
      transferId: string
      targetCmd: string
      failAt?: MoveFaultPoint
    }

export function parseOrgTransferArgs(argv: readonly string[]): OrgTransferArgs | string {
  const [cmd, ...rest] = argv
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === "--dry-run") switches.add(a)
    else if (
      [
        "--transfer",
        "--since",
        "--fingerprint-out",
        "--role",
        "--target-cmd",
        "--fail-at",
      ].includes(a)
    ) {
      const v = rest[++i]
      if (!v) return `${a} needs a value`
      flags.set(a, v)
    } else if (a.startsWith("--")) return `unknown argument ${a}`
    else positional.push(a)
  }
  const org = positional[0]
  const transfer = flags.get("--transfer")
  const needOrg = () => (org && UUID.test(org) ? null : "the org is named by its id (uuid)")
  const needTransfer = () =>
    transfer && UUID.test(transfer) ? null : "--transfer <id> (a uuid) names the move"
  switch (cmd) {
    case "keys":
      return { cmd }
    case "export": {
      const e = needOrg() ?? needTransfer()
      if (e) return e
      return {
        cmd,
        orgId: org as string,
        transferId: transfer as string,
        ...(flags.has("--since") ? { since: flags.get("--since") as string } : {}),
        ...(flags.has("--fingerprint-out")
          ? { fingerprintOut: flags.get("--fingerprint-out") as string }
          : {}),
      }
    }
    case "import":
      return { cmd, dryRun: switches.has("--dry-run") }
    case "estimate":
      return needOrg() ?? { cmd, orgId: org as string }
    case "purge-source":
    case "probe-write": {
      const e = needOrg() ?? needTransfer()
      return e ?? { cmd, orgId: org as string, transferId: transfer as string }
    }
    case "probe-clear":
      return { cmd }
    case "agent": {
      const role = flags.get("--role")
      if (role === "target") return { cmd, role }
      if (role !== "source") return "agent --role source|target"
      const e = needOrg() ?? needTransfer()
      if (e) return e
      const targetCmd = flags.get("--target-cmd")
      if (!targetCmd) return "agent --role source needs --target-cmd <command>"
      const failAt = flags.get("--fail-at")
      if (failAt !== undefined && !(MOVE_FAULT_POINTS as readonly string[]).includes(failAt)) {
        return `--fail-at ${failAt}: one of ${MOVE_FAULT_POINTS.join(", ")}`
      }
      if (failAt !== undefined && !env.LIAISON_TEST_CELL) {
        return "--fail-at is fault injection for test servers only: this server's env does not set LIAISON_TEST_CELL=1"
      }
      return {
        cmd,
        role,
        orgId: org as string,
        transferId: transfer as string,
        targetCmd,
        ...(failAt ? { failAt: failAt as MoveFaultPoint } : {}),
      }
    }
    default:
      return "keys, export, import, estimate, purge-source, probe-write, probe-clear or agent"
  }
}

/** A fingerprint as a file: `{ table: [[pk, xmin], ...] }`. */
export function fingerprintToJson(f: Fingerprint): string {
  return JSON.stringify(Object.fromEntries([...f].map(([t, m]) => [t, [...m]])))
}

export function fingerprintFromJson(text: string): Fingerprint {
  const o = JSON.parse(text) as Record<string, Array<[string, string]>>
  return new Map(Object.entries(o).map(([t, pairs]) => [t, new Map(pairs)]))
}

export interface OrgTransferIo {
  /** Lines of stdin. */
  input: () => AsyncIterable<string>
  /** One line to stdout; a promise when the reader is behind (await it before the next line). */
  output: (line: string) => unknown
  databaseUrl?: string
}

function processIo(): OrgTransferIo {
  return {
    input: () => createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }),
    output: (line) => {
      // Backpressure: a bundle is not buffered in this process faster than the reader takes it.
      if (process.stdout.write(`${line}\n`)) return
      return new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()))
    },
  }
}

export interface OrgTransferCliResult {
  exitCode: number
  report?: Record<string, unknown>
  message?: string
}

/** The keys line, then the rest of the input. */
async function splitKeys(lines: AsyncIterable<string>) {
  const it = lines[Symbol.asyncIterator]()
  const first = await it.next()
  if (first.done) throw new Error("org transfer: no input (the first line holds the transfer keys)")
  const keys = parseTransferKeys(first.value)
  const rest: AsyncIterable<string> = { [Symbol.asyncIterator]: () => it }
  return { keys, rest }
}

export async function runOrgTransferCli(
  argv: readonly string[],
  io: OrgTransferIo = processIo(),
): Promise<OrgTransferCliResult> {
  const args = parseOrgTransferArgs(argv)
  if (typeof args === "string") return { exitCode: 2, message: `${args}\n${ORG_TRANSFER_USAGE}` }
  if (args.cmd === "keys") {
    io.output(JSON.stringify(generateTransferKeys()))
    return { exitCode: 0 }
  }
  if (args.cmd === "purge-source") {
    // The purge deletes this cell's copy of the org's files and documents: refuse
    // if this cell now shares its storage with the cell the move went to.
    // A missing or unproven record refuses too (a Redis flush, a record past
    // its TTL): without the proof the purge could delete the live copy.
    // The move-time proof alone is old by now (the hold is days): the target, rebuilt or
    // restored meanwhile, may since point at this cell's stores. Its fresh probe (`probe-write`
    // there, the line on stdin here) must not be visible here either.
    try {
      await assertMovedPurgeSafe(args.transferId)
      const probe = parseProbeLine(await firstLine(io.input()))
      const shared = await probeVisibleHere(probe)
      if (shared.length > 0)
        throw new Error(`the target's fresh probe is visible here: ${shared.join(" and ")}`)
    } catch (err) {
      return { exitCode: 1, message: `refused: ${(err as Error).message}` }
    }
    const r = await purgeTransferCopy(args.orgId, args.transferId, "moved")
    return { exitCode: 0, report: { orgRowDeleted: r.orgRowDeleted, deleted: r.deleted } }
  }
  if (args.cmd === "probe-write") {
    // On the target: a probe for the source's purge-source to look for, then probe-clear here.
    io.output(JSON.stringify(await writeStorageProbe(args.orgId, args.transferId)))
    return { exitCode: 0 }
  }
  if (args.cmd === "probe-clear") {
    await clearStorageProbe(parseProbeLine(await firstLine(io.input())))
    return { exitCode: 0, report: { cleared: true } }
  }
  const url = io.databaseUrl ?? process.env.MIGRATION_DATABASE_URL
  if (!url) {
    return {
      exitCode: 2,
      message:
        "MIGRATION_DATABASE_URL is not set: an org transfer reads and writes as the migration role",
    }
  }
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  const ownKeys = { encryption: env.ENCRYPTION_KEY, byok: env.BYOK_ENCRYPTION_KEY }
  try {
    if (args.cmd === "agent") return await runAgent(args, sql, ownKeys, io)
    if (args.cmd === "estimate") {
      return { exitCode: 0, report: { ...(await estimateTransfer(sql as never, args.orgId)) } }
    }
    const { keys, rest } = await splitKeys(io.input())
    if (args.cmd === "export") {
      const since = args.since ? fingerprintFromJson(readFileSync(args.since, "utf8")) : undefined
      const r = await exportOrg({
        sql: sql as never,
        orgId: args.orgId,
        transferId: args.transferId,
        instanceKeys: ownKeys,
        transferKeys: keys,
        ...(since ? { since } : {}),
      })
      for (const line of r.lines) await io.output(line)
      // The fingerprint holds primary keys and xmin values only, no row content.
      if (args.fingerprintOut)
        writeFileSync(args.fingerprintOut, fingerprintToJson(r.fingerprint), { mode: 0o600 })
      return { exitCode: 0 }
    }
    const r = await importOrg({
      sql: sql as never,
      lines: rest,
      transferKeys: keys,
      ownKeys,
      dryRun: args.dryRun,
    })
    return { exitCode: 0, report: { ...r } }
  } catch (err) {
    if (err instanceof ImportRefused) {
      return { exitCode: 1, message: err.message, report: { code: err.code, detail: err.detail } }
    }
    throw err
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function runAgent(
  args: Extract<OrgTransferArgs, { cmd: "agent" }>,
  sql: postgres.Sql,
  ownKeys: { encryption: string | undefined; byok: string | undefined },
  io: OrgTransferIo,
): Promise<OrgTransferCliResult> {
  const { TargetAgent, serveTargetAgent, lineTargetChannel } = await import(
    "~/modules/org/transfer/agent-target"
  )
  const { initOrgTransferSync, stopOrgTransferSync } = await import(
    "~/modules/org/transfer-state/state"
  )
  await initOrgTransferSync()
  try {
    if (args.role === "target") {
      const agent = new TargetAgent({ sql: sql as never, ownKeys })
      await serveTargetAgent(io.input(), io.output, agent)
      return { exitCode: 0 }
    }
    const { runSourceMove } = await import("~/modules/org/transfer/agent-source")
    const { controlPlaneMoveControl } = await import("~/modules/org/transfer/control")
    const it = io.input()[Symbol.asyncIterator]()
    const first = await it.next()
    const operator = parseOperatorLine(first.done ? "" : first.value)
    const child = Bun.spawn(["sh", "-c", args.targetCmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    })
    const target = lineTargetChannel(
      (line) => {
        child.stdin.write(`${line}\n`)
      },
      createInterface({
        input: Readable.fromWeb(child.stdout as never),
        crlfDelay: Number.POSITIVE_INFINITY,
      }),
    )
    try {
      const report = await runSourceMove({
        sql: sql as never,
        orgId: args.orgId,
        transferId: args.transferId,
        target,
        control: controlPlaneMoveControl({
          orgId: args.orgId,
          transferId: args.transferId,
          operator,
        }),
        instanceKeys: ownKeys,
        progress: (e) => io.output(JSON.stringify(e)),
        ...(args.failAt ? { failAt: args.failAt } : {}),
      })
      return {
        exitCode: report.outcome === "committed" ? 0 : report.outcome === "aborted" ? 1 : 3,
        report: { ...report },
      }
    } finally {
      await target.call("bye").catch(() => {})
      child.stdin.end()
      await Promise.race([child.exited, Bun.sleep(10_000)])
    }
  } finally {
    stopOrgTransferSync()
  }
}

async function firstLine(lines: AsyncIterable<string>): Promise<string> {
  for await (const line of lines) return line
  return ""
}

/** A storage probe as `probe-write` printed it. */
export function parseProbeLine(line: string): StorageProbe {
  let v: Partial<StorageProbe>
  try {
    v = JSON.parse(line) as Partial<StorageProbe>
  } catch {
    throw new Error("no storage probe on stdin (the target's `org transfer probe-write` line)")
  }
  const ok = (x: unknown) => typeof x === "string" && x.length > 0
  if (!ok(v.objectKey) || !ok(v.searchId) || !ok(v.token)) {
    throw new Error("the storage probe line needs objectKey, searchId and token")
  }
  return {
    objectKey: v.objectKey as string,
    searchId: v.searchId as string,
    token: v.token as string,
  }
}

/** The source agent's first stdin line: the operator's credential (or `{}`: none). */
export function parseOperatorLine(line: string): { control: string; operatorKey: string } | null {
  if (!line.trim()) return null
  const v = JSON.parse(line) as { operator?: { control?: unknown; operatorKey?: unknown } }
  const o = v.operator
  if (!o) return null
  if (typeof o.control !== "string" || !/^https?:\/\//.test(o.control)) {
    throw new Error("org transfer agent: operator.control must be the control plane's webhook URL")
  }
  if (typeof o.operatorKey !== "string" || o.operatorKey.length < 16) {
    throw new Error("org transfer agent: operator.operatorKey is missing")
  }
  return { control: o.control, operatorKey: o.operatorKey }
}
