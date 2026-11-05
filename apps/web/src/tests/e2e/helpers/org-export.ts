// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared E2E helpers for the data-export and entity-actions scenarios.
//
// These are small, deliberately stateless helpers reused by the data-export and
// entity-actions scenario files. They drive only the worker-schema org row JSONB — no new launch/teardown infra.

import { unzipSync } from "fflate"
import type { WorkerEnvWithDrive } from "../fixtures/test"

/**
 * Enable an app for the worker org by appending it to the org row's
 * `settings.enabledApps` (the same idempotent DISTINCT append the provisioning
 * CLI and the `enable_app` tool perform). Guarantees `<appName>` is in the org
 * enabled-app surface before scenarios assert on `data-export-app-<appName>`.
 */
export async function enableAppForOrg(
  env: WorkerEnvWithDrive,
  orgId: string,
  appName: string,
): Promise<void> {
  const schema = `${env.schemaPrefix ?? ""}kernel`
  const sql = env.db.sql
  await sql`
    UPDATE ${sql(schema)}.organizations
    SET settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{enabledApps}',
      (
        SELECT to_jsonb(coalesce(array_agg(DISTINCT e), ARRAY[]::text[]))
        FROM jsonb_array_elements_text(
          coalesce(settings -> 'enabledApps', '[]'::jsonb) || to_jsonb(${appName}::text)
        ) AS e
      ),
      true
    )
    WHERE id = ${orgId}
  `
}

export interface ZipEntry {
  name: string
  text: string
  bytes: Uint8Array
}

/** Unzip an exported download buffer in-test → entry names + contents. */
export function readZipEntries(buffer: Uint8Array): ZipEntry[] {
  const decoded = unzipSync(buffer)
  const dec = new TextDecoder()
  return Object.entries(decoded).map(([name, bytes]) => ({
    name,
    bytes,
    text: dec.decode(bytes),
  }))
}
