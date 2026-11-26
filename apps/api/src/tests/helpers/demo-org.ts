// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A test org made a demo workspace after the fact. Production writes an org's
// class with its row (`ensureOrg({ class: "demo" })`, the demo pool, the demo
// seed) and Postgres refuses both a class change and a demo marker on a
// `standard` org (migration 0355). Test fixtures, though, mostly start from a
// plain org (`createTestOrg`, `ensureOrg`) and mark it: this gives such an org
// the class it would have had from its first row, then marks it through the
// real `markOrgAsDemo`.
//
// The class is written on a superuser connection with
// `session_replication_role = replica`, which skips the trigger that keeps the
// class fixed for that one statement only (no DDL, no table lock); the marker
// rule still holds, since a CHECK is not a trigger. An org holding a billing
// row is refused: a demo org can hold none. `forgeDemoMarker` writes the one
// thing Postgres refuses outright, for the tests that prove the code would
// refuse it too.

import type { DemoOrgMarker } from "@liaison/shared"
import postgres from "postgres"
import { schemaRef } from "~/db/schema-ref"

/** Postgres's refusal of a demo marker on a standard org (migration 0355). */
export const MARKER_CHECK = "organizations_demo_marker_class_check"

const orgsTable = () => `${schemaRef("kernel")}.organizations`

function superuserUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

/** Give a test org the class `demo`, as if it had been created as one. */
export async function makeTestOrgDemoClass(orgId: string): Promise<void> {
  const su = postgres(superuserUrl(), { max: 1, onnotice: () => {} })
  try {
    await su.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '10s'")
      const billed = await tx.unsafe(
        `SELECT 1 FROM ${schemaRef("kernel")}.org_billing_state WHERE org_id = $1`,
        [orgId],
      )
      if (billed.length > 0) {
        throw new Error(`makeTestOrgDemoClass: org ${orgId} has a billing row; a demo org has none`)
      }
      await tx.unsafe("SET LOCAL session_replication_role = replica")
      await tx.unsafe(
        `UPDATE ${orgsTable()} SET class = 'demo' WHERE id = $1 AND class <> 'demo'`,
        [orgId],
      )
    })
  } finally {
    await su.end()
  }
}

/** `markOrgAsDemo` on a test org of any class: it becomes a demo org first. */
export async function markDemoOrgForTest(
  orgId: string,
  marker: DemoOrgMarker,
  opts: { loadHarness?: boolean } = {},
): Promise<void> {
  await makeTestOrgDemoClass(orgId)
  // Loaded here, so a file that mocks or loads the module late still gets its own copy.
  const { markOrgAsDemo } = await import("~/modules/demo/demo-org")
  await markOrgAsDemo(orgId, marker, opts)
}

/**
 * Forge a demo marker onto a standard org, which Postgres refuses since 0355:
 * for the tests proving the code paths refuse such an org on their own. The
 * constraint is dropped and put back (`NOT VALID`, since this row breaks it) in
 * one transaction, so no other session ever sees the table without it. Call
 * `revalidateMarkerCheck` once the forged orgs are deleted.
 */
export async function forgeDemoMarker(orgId: string, marker: unknown): Promise<void> {
  const su = postgres(superuserUrl(), { max: 1, onnotice: () => {} })
  try {
    await su.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '10s'")
      await tx.unsafe(`ALTER TABLE ${orgsTable()} DROP CONSTRAINT ${MARKER_CHECK}`)
      await tx.unsafe(
        `UPDATE ${orgsTable()} SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('demo', $1::text::jsonb) WHERE id = $2`,
        [JSON.stringify(marker), orgId],
      )
      await tx.unsafe(
        `ALTER TABLE ${orgsTable()} ADD CONSTRAINT ${MARKER_CHECK} CHECK (class = 'demo' OR jsonb_typeof(settings->'demo') IS DISTINCT FROM 'object') NOT VALID`,
      )
    })
  } finally {
    await su.end()
  }
}

/**
 * Validate the marker constraint again once this file's forged orgs are gone.
 * While another file's forged org still exists it stays `NOT VALID`: that
 * file's own call validates it.
 */
export async function revalidateMarkerCheck(): Promise<void> {
  const su = postgres(superuserUrl(), { max: 1, onnotice: () => {} })
  try {
    const forged = await su.unsafe(
      `SELECT 1 FROM ${orgsTable()} WHERE class <> 'demo' AND jsonb_typeof(settings->'demo') = 'object' LIMIT 1`,
    )
    if (forged.length > 0) return
    await su.unsafe(`ALTER TABLE ${orgsTable()} VALIDATE CONSTRAINT ${MARKER_CHECK}`)
  } finally {
    await su.end()
  }
}
