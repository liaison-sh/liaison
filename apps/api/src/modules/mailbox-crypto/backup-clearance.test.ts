// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-16: the backup clearance arithmetic (blueprint Task 12.5).
//
// This is a WAITING PERIOD, never a deletion. repo2 is a GCS bucket under a
// COMPLIANCE-locked 14 day retention, so its objects cannot be removed by
// anyone, the operator included. The only honest thing the product can say is
// the date on which the last pre-purge artifact ages out, and until that date
// the zero-access claim for that mailbox is false.
//
// NON-VACUITY FIRST: a fixture that IS clear returns `clear: true` with a
// concrete date. A function that always answered "not yet clear" would
// otherwise pass every negative case below.

import { describe, expect, it } from "bun:test"
import {
  backupConfigFromEnv,
  computeBackupClearance,
  DEFAULT_PGBACKREST_STANZA,
  DEFAULT_PROD_REPO_POLICIES,
} from "~/modules/mailbox-crypto/backup-clearance"

const PROD_STANZA = DEFAULT_PGBACKREST_STANZA

const DAY_MS = 24 * 60 * 60 * 1000

function iso(date: Date): string {
  return date.toISOString()
}

/** One `pgbackrest info --output=json` stanza, in the real wire shape. */
function infoDoc(
  backups: Array<{ label: string; repoKey: number; start: Date; stop?: Date }>,
): unknown[] {
  return [
    {
      name: PROD_STANZA,
      status: { code: 0, message: "ok" },
      repo: [
        { key: 1, cipher: "aes-256-cbc", status: { code: 0, message: "ok" } },
        { key: 2, cipher: "aes-256-cbc", status: { code: 0, message: "ok" } },
      ],
      archive: [{ id: "17-1", min: "000000010000000000000001", max: "0000000100000000000000FF" }],
      backup: backups.map((b) => ({
        label: b.label,
        type: b.label.endsWith("F") ? "full" : "incr",
        "repo-key": b.repoKey,
        database: { id: 1 },
        timestamp: {
          start: Math.floor(b.start.getTime() / 1000),
          stop: Math.floor((b.stop ?? b.start).getTime() / 1000),
        },
        archive: { start: "000000010000000000000001", stop: "0000000100000000000000FF" },
      })),
    },
  ]
}

const PURGED_AT = new Date("2026-03-01T00:00:00.000Z")

describe("T-SEC-16: backup clearance is elapsed time, never a deletion", () => {
  it("non-vacuity: a fixture with only post-purge artifacts is CLEAR and names a concrete date", () => {
    const info = infoDoc([
      { label: "20260302-020000F", repoKey: 1, start: new Date(PURGED_AT.getTime() + 1 * DAY_MS) },
      { label: "20260303-020000F", repoKey: 2, start: new Date(PURGED_AT.getTime() + 2 * DAY_MS) },
    ])
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now: new Date(PURGED_AT.getTime() + 40 * DAY_MS),
    })

    expect(result.clear).toBe(true)
    expect(result.offending).toEqual([])
    expect(result.clearAfter).toBeInstanceOf(Date)
    // A concrete instant, and one that has already passed at `now`.
    expect(Number.isFinite(result.clearAfter.getTime())).toBe(true)
    expect(result.clearAfter.getTime()).toBeGreaterThan(PURGED_AT.getTime())
  })

  it("computes the clearance date from the repo retention policies, not from a guess", () => {
    const info = infoDoc([
      { label: "20260302-020000F", repoKey: 1, start: new Date(PURGED_AT.getTime() + 1 * DAY_MS) },
      { label: "20260302-020000F", repoKey: 2, start: new Date(PURGED_AT.getTime() + 1 * DAY_MS) },
    ])
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now: new Date(PURGED_AT.getTime() + 40 * DAY_MS),
    })

    // repo1 keeps 4 fulls at one full per day -> 4 days. repo2 keeps 16 days of
    // time-based retention -> 16 days, and it is the binding one.
    expect(result.clearAfter.getTime()).toBe(PURGED_AT.getTime() + 16 * DAY_MS)
    const repo2 = result.perRepo.find((r) => r.key === 2)
    expect(repo2?.clearAfter.getTime()).toBe(PURGED_AT.getTime() + 16 * DAY_MS)
    const repo1 = result.perRepo.find((r) => r.key === 1)
    expect(repo1?.clearAfter.getTime()).toBe(PURGED_AT.getTime() + 4 * DAY_MS)
  })

  it("reports NOT YET CLEAR and names the offending full when a retained full predates the purge", () => {
    const offender = new Date(PURGED_AT.getTime() - 3 * DAY_MS)
    const info = infoDoc([
      { label: "20260226-020000F", repoKey: 1, start: offender },
      { label: "20260302-020000F", repoKey: 1, start: new Date(PURGED_AT.getTime() + 1 * DAY_MS) },
    ])
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now: new Date(PURGED_AT.getTime() + 1 * DAY_MS),
    })

    expect(result.clear).toBe(false)
    expect(result.offending.map((o) => o.label)).toContain("20260226-020000F")
    expect(result.offending[0]?.repoKey).toBe(1)
    expect(result.offending[0]?.startedAt.getTime()).toBe(offender.getTime())
  })

  it("treats the WAL floor as the oldest retained backup, so pre-purge WAL blocks clearance too", () => {
    // The oldest retained artifact IS the WAL floor: pgBackRest expires WAL with
    // the oldest retained full, so a retained full that predates the purge means
    // the WAL stream from before the purge is retained with it.
    const info = infoDoc([
      { label: "20260220-020000F", repoKey: 2, start: new Date(PURGED_AT.getTime() - 9 * DAY_MS) },
    ])
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now: new Date(PURGED_AT.getTime() + 1 * DAY_MS),
    })

    expect(result.clear).toBe(false)
    expect(result.walFloor?.getTime()).toBe(PURGED_AT.getTime() - 9 * DAY_MS)
  })

  it("never reports clear while a repo2 artifact sits inside its compliance lock window", () => {
    // The artifact postdates nothing: it was written one day BEFORE the purge and
    // its 14 day compliance lock has not expired, so no operator can delete it.
    const locked = new Date(PURGED_AT.getTime() - 1 * DAY_MS)
    const info = infoDoc([{ label: "20260228-020000F", repoKey: 2, start: locked }])
    const now = new Date(PURGED_AT.getTime() + 2 * DAY_MS)
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now,
    })

    expect(result.clear).toBe(false)
    const offender = result.offending.find((o) => o.repoKey === 2)
    expect(offender).toBeDefined()
    expect(offender?.complianceLockedUntil?.getTime()).toBe(locked.getTime() + 14 * DAY_MS)
    // And the honest date is at or after the lock expiry: it cannot be deleted early.
    expect(result.clearAfter.getTime()).toBeGreaterThanOrEqual(locked.getTime() + 14 * DAY_MS)
  })

  it("refuses a stanza that is not in the document rather than answering clear", () => {
    const info = infoDoc([
      { label: "20260302-020000F", repoKey: 1, start: new Date(PURGED_AT.getTime() + 1 * DAY_MS) },
    ])
    expect(() =>
      computeBackupClearance({
        info,
        stanza: "not-the-prod-stanza",
        plaintextPurgedAt: PURGED_AT,
        repos: DEFAULT_PROD_REPO_POLICIES,
      }),
    ).toThrow(/stanza/i)
  })

  it("refuses an empty backup list rather than answering clear on no evidence", () => {
    expect(() =>
      computeBackupClearance({
        info: infoDoc([]),
        stanza: PROD_STANZA,
        plaintextPurgedAt: PURGED_AT,
        repos: DEFAULT_PROD_REPO_POLICIES,
      }),
    ).toThrow(/no retained backups/i)
  })

  it("pins the prod policies against the ansible defaults", () => {
    const repo1 = DEFAULT_PROD_REPO_POLICIES.find((r) => r.key === 1)
    const repo2 = DEFAULT_PROD_REPO_POLICIES.find((r) => r.key === 2)
    expect(repo1?.type).toBe("count")
    expect(repo1?.retentionFull).toBe(4)
    expect(repo2?.type).toBe("time")
    expect(repo2?.retentionFull).toBe(16)
    expect(repo2?.complianceLockDays).toBe(14)
  })
})

describe("backup identity is deployment configuration", () => {
  it("takes the stanza and repo labels from the environment", () => {
    const config = backupConfigFromEnv({
      LIAISON_PGBACKREST_STANZA: "acme-prod",
      LIAISON_BACKUP_REPO1_LABEL: "repo1 R2 acme-prod-pgbackrest",
      LIAISON_BACKUP_REPO2_LABEL: "repo2 GCS acme-prod-pgbackrest-worm",
    })
    expect(config.stanza).toBe("acme-prod")
    expect(config.repos.map((r) => r.label)).toEqual([
      "repo1 R2 acme-prod-pgbackrest",
      "repo2 GCS acme-prod-pgbackrest-worm",
    ])
    // Names only: the retention arithmetic stays pinned in code.
    expect(config.repos.map(({ label: _l, ...rest }) => rest)).toEqual(
      DEFAULT_PROD_REPO_POLICIES.map(({ label: _l, ...rest }) => rest),
    )
  })

  it("falls back to neutral defaults that name no deployment", () => {
    const config = backupConfigFromEnv({ LIAISON_PGBACKREST_STANZA: "  " })
    expect(config.stanza).toBe("liaison")
    const text = JSON.stringify(config)
    for (const token of ["prod", "r2", "gcs", "bucket"]) {
      expect(text.toLowerCase()).not.toContain(token)
    }
  })

  it("feeds the configured stanza into the clearance check", () => {
    const { stanza, repos } = backupConfigFromEnv({ LIAISON_PGBACKREST_STANZA: "acme-prod" })
    const info = [
      {
        ...(infoDoc([]) as Record<string, unknown>[])[0],
        name: stanza,
        backup: [
          {
            label: "f1",
            "repo-key": 1,
            timestamp: { start: Math.floor(PURGED_AT.getTime() / 1000) + 60 },
          },
        ],
      },
    ]
    expect(
      computeBackupClearance({ info, stanza, plaintextPurgedAt: PURGED_AT, repos }).clear,
    ).toBe(true)
    expect(() =>
      computeBackupClearance({
        info,
        stanza: DEFAULT_PGBACKREST_STANZA,
        plaintextPurgedAt: PURGED_AT,
        repos,
      }),
    ).toThrow(/stanza/i)
  })
})

describe("T-SEC-16: the wire shape is read, not assumed", () => {
  it("reads unix second timestamps and per-backup repo keys", () => {
    const start = new Date(PURGED_AT.getTime() + 5 * DAY_MS)
    const info = infoDoc([{ label: "20260306-020000F", repoKey: 2, start }])
    const result = computeBackupClearance({
      info,
      stanza: PROD_STANZA,
      plaintextPurgedAt: PURGED_AT,
      repos: DEFAULT_PROD_REPO_POLICIES,
      now: new Date(PURGED_AT.getTime() + 40 * DAY_MS),
    })
    const repo2 = result.perRepo.find((r) => r.key === 2)
    expect(iso(repo2?.oldestRetainedAt as Date)).toBe(iso(start))
  })
})
