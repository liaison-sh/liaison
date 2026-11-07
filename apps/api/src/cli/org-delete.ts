// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org delete <org slug or id>` — the operator deletes an organization
// and everything it owns (spec S2, D1, D2, D10, D11). IRREVERSIBLE.
//
// Every gate is checked BEFORE anything changes (exit 2 with the fix named):
//   - the instance's own (operator) org is refused, no flag overrides;
//   - an export of the org still running is refused;
//   - export first: a completed whole-org export (`liaison org export`) less
//     than 24 h old that has left the server, i.e. it was downloaded
//     (`downloaded_at`), or `--export-to <path>` streams it to local disk
//     first; `--without-export-i-accept-losing-the-org-data` waives it;
//   - legal archive: LEGAL_ARCHIVE_RECIPIENT must parse as an age recipient;
//     unset, the command refuses unless `--no-legal-archive` (a warning, and
//     the waiver goes on the ledger);
//   - the operator types the org slug (or `--yes <slug>`).
// `--dry-run` prints the gates and the residue scan and changes nothing.
//
// Then: the ledger row (`kernel.org_deletions`), step 1 (the org is marked
// deleting: every request gets 410, its jobs are dropped), and the `org-delete`
// job handed to the server's worker, which writes the legal archive and runs
// the purge (modules/org/delete/job.ts). The CLI never hosts jobs or registers
// org apps: it follows the ledger and prints it as JSON when it ends.
//
// Re-running the command for an org with an open deletion (by id, also once
// the org row is gone, or by slug) resumes it. `--abort` cancels a deletion
// whose purge has not started yet and restores the org.
import { createWriteStream } from "node:fs"
import { access, rename, rm } from "node:fs/promises"
import os from "node:os"
import { createInterface } from "node:readline/promises"
import { and, desc, eq, gt, isNotNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { OrgDeletionExport, OrgDeletionRow, OrgDeletionWaiver } from "~/db/schema/kernel"
import { organizations, orgExports } from "~/db/schema/kernel"
import { getObjectStream } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { resolveOperatorOrgId } from "~/modules/apps/operator-org"
import { enqueueOrgDelete, type OrgDeleteJobPayload } from "~/modules/org/delete/job"
import {
  abortOrgDeletion,
  findOpenOrgDeletion,
  findOpenOrgDeletionBySlug,
  getOrgDeletion,
  ledgerLine,
  OrgDeletionOpenError,
  PURGE_STARTED_STEP,
} from "~/modules/org/delete/ledger"
import { assertLegalArchiveRecipient, deleteLegalArchive } from "~/modules/org/delete/legal-archive"
import {
  beginOrgDeletion,
  handOrgDeletionToWorker,
  runningOrgExport,
} from "~/modules/org/delete/start"
import { announceOrgDeleting } from "~/modules/org/purge/deleting"
import { residueScan } from "~/modules/org/purge/residue"

export const ORG_DELETE_USAGE =
  "usage: liaison org delete <org slug or id> [--dry-run] [--yes <slug>] [--export-to <path>] [--no-legal-archive] [--without-export-i-accept-losing-the-org-data] [--abort] [--timeout <seconds>]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const WITHOUT_EXPORT_FLAG = "--without-export-i-accept-losing-the-org-data"
const NO_LEGAL_ARCHIVE_IGNORED = "--no-legal-archive ignored: LEGAL_ARCHIVE_RECIPIENT is set"

export interface OrgDeleteCliDeps {
  /** Hand the job to the server (default: the server's queue). */
  enqueue?: (payload: OrgDeleteJobPayload) => Promise<unknown>
  /** The legal archive recipient (default: LEGAL_ARCHIVE_RECIPIENT). */
  recipient?: string | null
  /** Ask the operator to type the slug (default: stdin when it is a terminal). */
  prompt?: (question: string) => Promise<string | null>
  /** Warnings and progress (default: stderr). */
  warn?: (line: string) => void
  pollMs?: number
  operator?: string
}

export interface OrgDeleteCliResult {
  exitCode: number
  report: Record<string, unknown> | null
  message?: string
}

interface Args {
  ref: string
  dryRun: boolean
  abort: boolean
  yes: string | null
  exportTo: string | null
  noLegalArchive: boolean
  withoutExport: boolean
  timeoutSec: number
}

function parseArgs(argv: string[]): Args | null {
  const a: Args = {
    ref: "",
    dryRun: false,
    abort: false,
    yes: null,
    exportTo: null,
    noLegalArchive: false,
    withoutExport: false,
    timeoutSec: 6 * 3600,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "--dry-run") a.dryRun = true
    else if (arg === "--abort") a.abort = true
    else if (arg === "--no-legal-archive") a.noLegalArchive = true
    else if (arg === WITHOUT_EXPORT_FLAG) a.withoutExport = true
    else if (arg === "--yes" || arg === "--export-to" || arg === "--timeout") {
      const v = argv[++i]
      if (!v || v.startsWith("--")) return null
      if (arg === "--yes") a.yes = v
      else if (arg === "--export-to") a.exportTo = v
      else {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return null
        a.timeoutSec = n
      }
    } else if (arg.startsWith("--")) return null
    else positional.push(arg)
  }
  if (positional.length !== 1) return null
  a.ref = positional[0] as string
  return a
}

function refuse(
  message: string,
  report: Record<string, unknown> | null = null,
): OrgDeleteCliResult {
  return { exitCode: 2, report, message }
}

function defaultOperator(): string {
  try {
    return `${os.userInfo().username}@${os.hostname()}`
  } catch {
    return `uid:${process.getuid?.() ?? "?"}@${os.hostname()}`
  }
}

async function defaultPrompt(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

interface OrgRow {
  id: string
  name: string
  slug: string
  deletingAt: Date | null
}

async function loadOrgToDelete(ref: string): Promise<OrgRow | null> {
  const [row] = await withSystemDb("cli-org-delete-org", (tx) =>
    tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        deletingAt: organizations.deletingAt,
      })
      .from(organizations)
      .where(UUID.test(ref) ? eq(organizations.id, ref) : eq(organizations.slug, ref)),
  )
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    deletingAt: row.deletingAt ? new Date(row.deletingAt) : null,
  }
}

interface GateState {
  ok: boolean
  detail: string
  fix?: string
}

interface Gates {
  operatorOrg: GateState
  runningExport: GateState
  export: GateState & { export?: OrgDeletionExport; exportObjectKey?: string }
  legalArchive: GateState & { recipient: string | null; waived: boolean }
}

async function checkGates(org: OrgRow, args: Args, deps: OrgDeleteCliDeps): Promise<Gates> {
  const operatorOrgId = await resolveOperatorOrgId({ fresh: true })
  const operatorOrg: GateState =
    operatorOrgId === org.id
      ? {
          ok: false,
          detail: "this is the instance's own (operator) organization",
          fix: "the operator organization cannot be deleted; no flag overrides this",
        }
      : { ok: true, detail: "not the operator organization" }

  const running = await runningOrgExport(org.id)
  const runningExport: GateState =
    running !== null
      ? {
          ok: false,
          detail: `export ${running.id} is ${running.status}`,
          fix: "wait for the running export to finish, then run the deletion again",
        }
      : { ok: true, detail: "no export running" }

  const since = new Date(Date.now() - EXPORT_MAX_AGE_MS)
  const [latest] = await withSystemDb("cli-org-delete-latest-export", (tx) =>
    tx
      .select()
      .from(orgExports)
      .where(
        and(
          eq(orgExports.orgId, org.id),
          eq(orgExports.status, "completed"),
          isNotNull(orgExports.objectKey),
          gt(orgExports.completedAt, since),
        ),
      )
      .orderBy(desc(orgExports.completedAt))
      .limit(1),
  )
  const exportFix = `run \`liaison org export ${org.slug} --wait\`, then download it (Settings › Organization › Export organization) or pass \`--export-to <path>\`; or pass ${WITHOUT_EXPORT_FLAG}`
  let exportGate: Gates["export"]
  const base: OrgDeletionExport | undefined = latest
    ? {
        exportId: latest.id,
        completedAt: latest.completedAt?.toISOString() ?? null,
        downloadedAt: latest.downloadedAt?.toISOString() ?? null,
        bytes: latest.bytes ?? null,
      }
    : undefined
  if (!latest && args.exportTo) {
    exportGate = {
      ok: false,
      detail: `--export-to ${args.exportTo}: nothing to save, no completed export in the last 24 h`,
      fix: `run \`liaison org export ${org.slug} --wait\` first, or drop --export-to (and pass ${WITHOUT_EXPORT_FLAG} to delete without an export)`,
    }
  } else if (latest && args.exportTo) {
    exportGate = {
      ok: true,
      detail: `export ${latest.id} will be saved to ${args.exportTo}`,
      export: { ...(base as OrgDeletionExport), savedTo: args.exportTo },
      exportObjectKey: latest.objectKey ?? undefined,
    }
  } else if (latest?.downloadedAt) {
    exportGate = {
      ok: true,
      detail: `export ${latest.id} was downloaded at ${latest.downloadedAt.toISOString()}`,
      export: base,
    }
  } else if (args.withoutExport) {
    exportGate = { ok: true, detail: "waived: the org's data will be lost" }
  } else {
    exportGate = {
      ok: false,
      detail: latest
        ? `export ${latest.id} completed but was never downloaded`
        : "no completed export in the last 24 h",
      fix: exportFix,
    }
  }

  const recipient =
    deps.recipient !== undefined ? deps.recipient : (env.LEGAL_ARCHIVE_RECIPIENT ?? null)
  let legalArchive: Gates["legalArchive"]
  if (recipient) {
    try {
      assertLegalArchiveRecipient(recipient)
      legalArchive = {
        ok: true,
        detail: args.noLegalArchive
          ? `the legal archive will be encrypted to LEGAL_ARCHIVE_RECIPIENT (${NO_LEGAL_ARCHIVE_IGNORED})`
          : "the legal archive will be encrypted to LEGAL_ARCHIVE_RECIPIENT",
        recipient,
        waived: false,
      }
    } catch (err) {
      legalArchive = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        fix: "set LEGAL_ARCHIVE_RECIPIENT to the age recipient (age1...) of an identity you keep off the server (`age-keygen`)",
        recipient: null,
        waived: false,
      }
    }
  } else if (args.noLegalArchive) {
    legalArchive = {
      ok: true,
      detail: "waived: no legal archive will be kept",
      recipient: null,
      waived: true,
    }
  } else {
    legalArchive = {
      ok: false,
      detail: "LEGAL_ARCHIVE_RECIPIENT is not set",
      fix: "set LEGAL_ARCHIVE_RECIPIENT to the age recipient (age1...) of an identity you keep off the server (`age-keygen`), or pass --no-legal-archive to delete the legal records without an archive",
      recipient: null,
      waived: false,
    }
  }
  return { operatorOrg, runningExport, export: exportGate, legalArchive }
}

function gatesReport(g: Gates): Record<string, unknown> {
  const one = (s: GateState) => ({ ok: s.ok, detail: s.detail, ...(s.fix ? { fix: s.fix } : {}) })
  return {
    operatorOrg: one(g.operatorOrg),
    runningExport: one(g.runningExport),
    export: one(g.export),
    legalArchive: one(g.legalArchive),
  }
}

function firstRefusal(g: Gates): GateState | null {
  for (const s of [g.operatorOrg, g.runningExport, g.export, g.legalArchive]) if (!s.ok) return s
  return null
}

/** Stream the export object to `path` (written to a temporary file, then renamed). */
async function saveExport(objectKey: string, path: string): Promise<number> {
  try {
    await access(path)
    throw new Error(`${path} already exists; choose a new file`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  const tmp = `${path}.part`
  const obj = await getObjectStream(objectKey)
  const out = createWriteStream(tmp, { mode: 0o600 })
  let bytes = 0
  try {
    for await (const chunk of obj.stream as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
    }
    await new Promise<void>((resolve, reject) =>
      out.end((e?: Error | null) => (e ? reject(e) : resolve())),
    )
    if (bytes !== obj.contentLength) {
      throw new Error(`read ${bytes} of ${obj.contentLength} bytes of the export`)
    }
    await rename(tmp, path)
    return bytes
  } catch (err) {
    out.destroy()
    await rm(tmp, { force: true })
    throw err
  }
}

async function confirm(
  slug: string,
  args: Args,
  deps: OrgDeleteCliDeps,
): Promise<OrgDeleteCliResult | null> {
  if (args.yes !== null) {
    return args.yes === slug
      ? null
      : refuse(`--yes '${args.yes}' does not match the org slug '${slug}'`)
  }
  const answer = await (deps.prompt ?? defaultPrompt)(
    `This permanently deletes the organization '${slug}' and everything it owns. Type its slug to confirm: `,
  )
  if (answer === null) {
    return refuse(`no terminal to confirm on: pass --yes ${slug} to confirm the deletion`)
  }
  return answer === slug ? null : refuse("the slug typed does not match; nothing was changed")
}

/** Follow the ledger until the deletion ends (or the timeout). */
async function follow(
  deletionId: string,
  args: Args,
  deps: OrgDeleteCliDeps,
): Promise<OrgDeleteCliResult> {
  const warn = deps.warn ?? ((l: string) => process.stderr.write(`${l}\n`))
  const deadline = Date.now() + args.timeoutSec * 1000
  const pollMs = deps.pollMs ?? 2000
  let seen = 0
  for (;;) {
    const row = await getOrgDeletion(deletionId)
    if (!row) return { exitCode: 1, report: null, message: `deletion ${deletionId} disappeared` }
    for (const step of row.stepsDone.slice(seen)) warn(`org delete: ${step} done`)
    seen = row.stepsDone.length
    if (row.status === "completed") return { exitCode: 0, report: ledgerLine(row) }
    if (row.status === "failed" || row.status === "aborted") {
      return {
        exitCode: 1,
        report: ledgerLine(row),
        message:
          row.status === "failed"
            ? `the deletion failed: ${row.error ?? "no detail"}. Run \`liaison org delete ${row.deletedOrgId}\` again to resume.`
            : "the deletion was aborted",
      }
    }
    if (Date.now() > deadline) {
      return {
        exitCode: 1,
        report: ledgerLine(row),
        message: `still ${row.status} after ${args.timeoutSec} s; it keeps running on the server. Run \`liaison org delete ${row.deletedOrgId}\` again to follow it.`,
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** Hand the job to the server (unless a live run holds the deletion) and follow it. */
async function handOff(
  row: OrgDeletionRow,
  args: Args,
  deps: OrgDeleteCliDeps,
): Promise<OrgDeleteCliResult> {
  const handed = await handOrgDeletionToWorker(
    row,
    deps.enqueue ?? ((p) => enqueueOrgDelete(p, { forServer: true })),
  )
  if (!handed.ok) {
    return {
      exitCode: 1,
      report: { deletionId: row.id, orgId: row.deletedOrgId, status: "failed" },
      message: `the deletion job could not be queued: ${handed.detail}. Run the command again to resume.`,
    }
  }
  return follow(row.id, args, deps)
}

async function runAbort(
  org: OrgRow | null,
  open: OrgDeletionRow | null,
): Promise<OrgDeleteCliResult> {
  if (!open) return refuse("no open deletion of this organization to abort")
  if (open.stepsDone.includes(PURGE_STARTED_STEP)) {
    return refuse(
      `the purge of this organization has started (${open.stepsDone.join(", ")}); it cannot be aborted. Run \`liaison org delete ${open.deletedOrgId}\` to finish it.`,
    )
  }
  const closed = await abortOrgDeletion(open.id)
  if (!closed) {
    return refuse(
      `the deletion could not be aborted (its purge started meanwhile). Run \`liaison org delete ${open.deletedOrgId}\` to finish it.`,
    )
  }
  // The ledger abort cleared the org's deleting mark in its transaction.
  if (org) await announceOrgDeleting(org.id)
  if (closed.archiveKey) await deleteLegalArchive(closed.archiveKey)
  return {
    exitCode: 0,
    report: ledgerLine(closed),
    message: "deletion aborted; the organization is restored",
  }
}

export async function runOrgDeleteCli(
  argv: string[],
  deps: OrgDeleteCliDeps = {},
): Promise<OrgDeleteCliResult> {
  const args = parseArgs(argv)
  if (!args) return refuse(ORG_DELETE_USAGE)
  const warn = deps.warn ?? ((l: string) => process.stderr.write(`${l}\n`))

  const org = await loadOrgToDelete(args.ref)
  const open = org
    ? await findOpenOrgDeletion(org.id)
    : UUID.test(args.ref)
      ? await findOpenOrgDeletion(args.ref)
      : await findOpenOrgDeletionBySlug(args.ref)
  if (!org && !open) return refuse(`org '${args.ref}' not found`)

  if (args.abort) return runAbort(org, open)

  if (open) {
    // A deletion already began: its gates passed then; resume it.
    if (args.dryRun) {
      return {
        exitCode: 0,
        report: {
          dryRun: true,
          resuming: ledgerLine(open),
          residue: org ? await residueScan(org.id) : null,
        },
      }
    }
    const refused = await confirm(open.orgSlug, args, deps)
    if (refused) return refused
    warn(
      `org delete: resuming deletion ${open.id} (${open.status}; done: ${open.stepsDone.join(", ") || "nothing"})`,
    )
    return handOff(open, args, deps)
  }

  const target = org as OrgRow
  const gates = await checkGates(target, args, deps)
  const refusal = firstRefusal(gates)
  if (args.dryRun) {
    return {
      exitCode: refusal ? 2 : 0,
      report: {
        dryRun: true,
        org: { id: target.id, slug: target.slug, name: target.name },
        gates: gatesReport(gates),
        residue: await residueScan(target.id),
      },
      ...(refusal ? { message: `would refuse: ${refusal.detail}. Fix: ${refusal.fix}` } : {}),
    }
  }
  if (refusal) {
    return refuse(`refused: ${refusal.detail}. Fix: ${refusal.fix}`, {
      orgId: target.id,
      gates: gatesReport(gates),
    })
  }
  const refused = await confirm(target.slug, args, deps)
  if (refused) return refused

  const waivers: OrgDeletionWaiver[] = []
  const at = new Date().toISOString()
  if (args.noLegalArchive && !gates.legalArchive.waived) {
    warn(`org delete: ${NO_LEGAL_ARCHIVE_IGNORED}; the legal archive is kept.`)
  }
  if (gates.legalArchive.waived) {
    warn(
      "WARNING: no legal archive will be kept (--no-legal-archive): the organization's issued invoices, e-invoicing records and audit log are deleted with it.",
    )
    waivers.push({ kind: "no-legal-archive", at })
  }
  if (!gates.export.export) {
    warn(
      `WARNING: deleting without an export (${WITHOUT_EXPORT_FLAG}): the organization's data is lost.`,
    )
    waivers.push({ kind: "without-export", at })
  }
  let exportRecord = gates.export.export ?? null
  if (exportRecord && args.exportTo && gates.export.exportObjectKey) {
    try {
      const bytes = await saveExport(gates.export.exportObjectKey, args.exportTo)
      exportRecord = { ...exportRecord, savedTo: args.exportTo, bytes }
      warn(`org delete: export ${exportRecord.exportId} saved to ${args.exportTo} (${bytes} bytes)`)
    } catch (err) {
      return refuse(
        `refused: the export could not be saved to ${args.exportTo}: ${err instanceof Error ? err.message : String(err)}. Fix: choose a writable new file path`,
      )
    }
  }

  let row: OrgDeletionRow
  try {
    // Step 1 with the ledger row: from here every request for the org gets
    // 410 and its jobs are dropped.
    row = await beginOrgDeletion({
      orgId: target.id,
      slug: target.slug,
      name: target.name,
      operator: deps.operator ?? defaultOperator(),
      waivers,
      export: exportRecord,
      legalArchiveRecipient: gates.legalArchive.recipient,
    })
  } catch (err) {
    if (err instanceof OrgDeletionOpenError) {
      return refuse(`${err.message}; run the command again to resume it`)
    }
    throw err
  }
  return handOff(row, args, deps)
}
