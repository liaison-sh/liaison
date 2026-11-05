// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Borrowing `kernel.files`'s SELECT policy for the length of one test file.
 *
 * A handler that resolves a file under RLS needs a policy that can see the
 * seeded rows, and production gets one from the manifest fileParent registry
 * (`rebuildFilesSelectPolicy`, from the catalog). A test that seeds files with no registered
 * parent installs an org-scoped stand-in instead, and two things about how that
 * used to be done were wrong.
 *
 * It ran `DROP POLICY ...; CREATE POLICY ...` as two statements outside any
 * transaction, so a process killed between them left `kernel.files` with NO
 * SELECT policy at all, for every later process on that database. And it
 * "restored" a hard-coded `USING (false)` placeholder, which is only the right
 * answer when the registry is empty: in a process where apps ARE registered it
 * replaced the real policy with a deny-everything one and every later file read
 * no files.
 *
 * So: both halves go through one transaction, and the restore asks the builder
 * the builder for the policy (the catalog's, by default).
 */

import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  type FilesSelectPolicyRebuildOptions,
  rebuildFilesSelectPolicy,
} from "~/infra/boot-phase10"

const PERMISSIVE_POLICY =
  `CREATE POLICY files_select ON ${schemaRef("kernel")}.files FOR SELECT TO liaison_rls ` +
  `USING (org_id = NULLIF(rls_ctx.org_id(), '')::uuid)`

/**
 * Run policy DDL as ONE transaction: either the replacement lands or the
 * previous policy is still there. Never leaves the table policy-less.
 */
export async function applyFilesSelectPolicyStatements(statements: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement)
  })
}

/** Swap in an org-scoped SELECT policy: what a real readable parent grants. */
export async function installPermissiveFilesSelectPolicy(): Promise<void> {
  await applyFilesSelectPolicyStatements([
    `DROP POLICY IF EXISTS files_select ON ${schemaRef("kernel")}.files`,
    PERMISSIVE_POLICY,
  ])
}

/**
 * Put back the built policy: the catalog's, or the one these parents describe
 * (a test with a fixture parent the catalog does not hold).
 */
export async function restoreFilesSelectPolicy(
  opts: FilesSelectPolicyRebuildOptions = {},
): Promise<void> {
  await rebuildFilesSelectPolicy(opts)
}
