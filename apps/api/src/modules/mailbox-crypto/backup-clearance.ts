// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 12.5: when do the backups stop holding this mailbox's plaintext?
//
// THIS IS A WAITING PERIOD, NOT A DELETE (spec section 15, amendment A12). The
// reference deployment's stanza writes to two repos:
//
//   repo1  an object-store bucket with COUNT based retention, 4 fulls kept,
//          one full per night. Its bucket lock is governance grade, so an
//          operator with the token could in principle remove an object; we do
//          not rely on that and we do not offer it.
//   repo2  a second bucket with TIME based retention of 16 days, sitting
//          behind a COMPLIANCE locked 14 day retention policy plus object
//          versioning. Those objects are undeletable by ANYONE, the project
//          owner included, until they age out.
//
// The stanza name and the repo labels are deployment configuration
// (`backupConfigFromEnv`); the retention arithmetic is not.
//
// So there is no "delete the plaintext from the backups" operation to write,
// and pretending otherwise would be the single most misleading thing this
// feature could say. What exists is arithmetic: the instant at which every
// retained artifact postdates the purge. Until that instant the zero-access
// claim for that mailbox is FALSE, and the security page shows the date
// (Task 8.5) rather than claiming the guarantee early.
//
// The function is pure. It takes a parsed `pgbackrest info --output=json`
// document, so verification is by ENUMERATION of what the repos actually hold,
// not by trusting the configured policy. The policy is used only to project the
// future clearance date for artifacts that are still retained.

const DAY_MS = 24 * 60 * 60 * 1000

/** pgBackRest's stanza when `LIAISON_PGBACKREST_STANZA` is unset. */
export const DEFAULT_PGBACKREST_STANZA = "liaison"

export interface RepoRetentionPolicy {
  /** `repo-key` as pgBackRest reports it: 1 is R2, 2 is the GCS WORM copy. */
  key: number
  /** Human name for the offending-artifact report and the ledger note. */
  label: string
  /** `count` keeps N fulls; `time` keeps N days of fulls. */
  type: "count" | "time"
  /** `repoN-retention-full`. */
  retentionFull: number
  /**
   * Count based repos only: how long one full-backup cycle takes. Prod runs a
   * nightly full (`pgbackrest_full_oncalendar: "*-*-* 02:30:00"`), so four
   * fulls is four days.
   */
  fullIntervalDays?: number
  /**
   * The bucket's COMPLIANCE lock, in days. Present only for repo2. An object
   * inside this window cannot be deleted by anyone, so it bounds the clearance
   * date from below independently of the retention policy.
   */
  complianceLockDays?: number
}

/**
 * The reference pair of retention policies, mirrored from the deployment's
 * pgBackRest role defaults. Pinned by a test, so a retention change that is not
 * mirrored here fails rather than quietly shortening the date shown to a user.
 */
export const DEFAULT_PROD_REPO_POLICIES: readonly RepoRetentionPolicy[] = [
  {
    key: 1,
    label: "repo1 (count retention)",
    type: "count",
    retentionFull: 4,
    fullIntervalDays: 1,
  },
  {
    key: 2,
    label: "repo2 (time retention, compliance locked)",
    type: "time",
    retentionFull: 16,
    complianceLockDays: 14,
  },
]

export interface BackupConfig {
  stanza: string
  repos: readonly RepoRetentionPolicy[]
}

/**
 * The deployment's backup identity, from the environment:
 *   LIAISON_PGBACKREST_STANZA    the pgBackRest stanza the cluster writes
 *   LIAISON_BACKUP_REPO1_LABEL   report label for repo1 (e.g. its bucket)
 *   LIAISON_BACKUP_REPO2_LABEL   report label for repo2
 * Unset or blank falls back to the neutral defaults above. Only names come from
 * here; the retention numbers stay pinned in code.
 */
export function backupConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BackupConfig {
  const pick = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : fallback
  }
  const labels: Record<number, string | undefined> = {
    1: env.LIAISON_BACKUP_REPO1_LABEL,
    2: env.LIAISON_BACKUP_REPO2_LABEL,
  }
  return {
    stanza: pick(env.LIAISON_PGBACKREST_STANZA, DEFAULT_PGBACKREST_STANZA),
    repos: DEFAULT_PROD_REPO_POLICIES.map((p) => ({ ...p, label: pick(labels[p.key], p.label) })),
  }
}

export interface OffendingArtifact {
  repoKey: number
  repoLabel: string
  label: string
  startedAt: Date
  /**
   * For a compliance-locked repo, the instant the object becomes deletable at
   * all. Undefined on repos without a lock: the absence is meaningful, so it is
   * not defaulted to the retention horizon.
   */
  complianceLockedUntil?: Date
}

export interface RepoClearance {
  key: number
  label: string
  /** The oldest artifact this repo still retains, from the info document. */
  oldestRetainedAt: Date
  /** When every pre-purge artifact in this repo has aged out. */
  clearAfter: Date
  clear: boolean
}

export interface BackupClearance {
  /** The date to store in `kernel.mailbox_migration_state.backups_clear_after`. */
  clearAfter: Date
  /** True only when the enumeration found nothing retained from before the purge. */
  clear: boolean
  /** Empty iff `clear`. Every retained artifact that predates the purge. */
  offending: OffendingArtifact[]
  perRepo: RepoClearance[]
  /**
   * The oldest retained artifact across every repo. pgBackRest expires WAL with
   * the oldest retained full, so this instant is also the floor of the retained
   * WAL stream: a value before the purge means pre-purge WAL is still on file.
   */
  walFloor: Date | null
}

export interface BackupClearanceInput {
  /** The parsed output of `pgbackrest info --output=json`. */
  info: unknown
  stanza: string
  plaintextPurgedAt: Date
  repos: readonly RepoRetentionPolicy[]
  /** Defaults to the wall clock. Injected in tests, never guessed elsewhere. */
  now?: Date
}

interface RawBackup {
  label: string
  repoKey: number
  startedAt: Date
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Read the backups of one stanza out of the info document.
 *
 * `timestamp.start` is unix SECONDS in pgBackRest's JSON, and `repo-key` is the
 * per-backup repo the entry belongs to on a multi-repo stanza. Both are read
 * rather than assumed, because getting either wrong would silently produce a
 * clearance date that is too early, which is the failure mode that matters.
 */
function readBackups(info: unknown, stanza: string): RawBackup[] {
  const stanzas = Array.isArray(info) ? info : []
  const found = stanzas.find((s) => asRecord(s)?.name === stanza)
  if (!found) {
    throw new Error(
      `pgbackrest info holds no stanza "${stanza}": refusing to answer on a document that is not this cluster`,
    )
  }
  const backups = asRecord(found)?.backup
  const list = Array.isArray(backups) ? backups : []
  const out: RawBackup[] = []
  for (const entry of list) {
    const row = asRecord(entry)
    if (!row) continue
    const timestamp = asRecord(row.timestamp)
    const startSeconds = Number(timestamp?.start)
    if (!Number.isFinite(startSeconds)) continue
    out.push({
      label: String(row.label ?? "unlabelled"),
      repoKey: Number(row["repo-key"] ?? row.repoKey ?? 1),
      startedAt: new Date(startSeconds * 1000),
    })
  }
  if (out.length === 0) {
    throw new Error(
      `pgbackrest info reports no retained backups for stanza "${stanza}": that is not evidence of clearance, it is absence of evidence`,
    )
  }
  return out
}

/**
 * The instant at which a repo holding a pre-purge artifact stops holding one.
 *
 * Count based: pre-purge artifacts leave once `retentionFull` fulls taken AFTER
 * the purge have accumulated, one per `fullIntervalDays`.
 * Time based: pre-purge artifacts leave `retentionFull` days after the purge,
 * because WAL is archived continuously right up to the purge instant, so the
 * newest pre-purge artifact is the purge itself.
 */
function projectRepoClearance(policy: RepoRetentionPolicy, plaintextPurgedAt: Date): Date {
  if (policy.type === "count") {
    const intervalDays = policy.fullIntervalDays ?? 1
    return new Date(plaintextPurgedAt.getTime() + policy.retentionFull * intervalDays * DAY_MS)
  }
  return new Date(plaintextPurgedAt.getTime() + policy.retentionFull * DAY_MS)
}

export function computeBackupClearance(input: BackupClearanceInput): BackupClearance {
  const backups = readBackups(input.info, input.stanza)
  const purgedMs = input.plaintextPurgedAt.getTime()

  const offending: OffendingArtifact[] = []
  const perRepo: RepoClearance[] = []
  let clearAfterMs = purgedMs
  let walFloor: Date | null = null

  for (const policy of input.repos) {
    const mine = backups.filter((b) => b.repoKey === policy.key)
    if (mine.length === 0) continue
    const oldest = mine.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))
    if (walFloor === null || oldest.startedAt < walFloor) walFloor = oldest.startedAt

    const stale = mine.filter((b) => b.startedAt.getTime() < purgedMs)
    let repoClearAfter = projectRepoClearance(policy, input.plaintextPurgedAt)

    for (const artifact of stale) {
      const lockedUntil =
        policy.complianceLockDays === undefined
          ? undefined
          : new Date(artifact.startedAt.getTime() + policy.complianceLockDays * DAY_MS)
      // The compliance lock is a hard floor: no operator, no support ticket and
      // no incident response can remove that object before it expires.
      if (lockedUntil && lockedUntil.getTime() > repoClearAfter.getTime()) {
        repoClearAfter = lockedUntil
      }
      offending.push({
        repoKey: policy.key,
        repoLabel: policy.label,
        label: artifact.label,
        startedAt: artifact.startedAt,
        complianceLockedUntil: lockedUntil,
      })
    }

    perRepo.push({
      key: policy.key,
      label: policy.label,
      oldestRetainedAt: oldest.startedAt,
      clearAfter: repoClearAfter,
      clear: stale.length === 0,
    })
    if (repoClearAfter.getTime() > clearAfterMs) clearAfterMs = repoClearAfter.getTime()
  }

  return {
    clearAfter: new Date(clearAfterMs),
    clear: offending.length === 0,
    offending,
    perRepo,
    walFloor,
  }
}
