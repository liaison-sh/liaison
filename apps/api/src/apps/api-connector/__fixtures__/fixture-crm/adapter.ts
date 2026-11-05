// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Loads the fixture CRM's adapter (`fixture-crm.adapter.yaml`) through the
 * core validator. `baseUrl` may be overridden (a test's ephemeral port); the
 * result is re-validated, so an override can never smuggle in a URL the
 * schema refuses.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Adapter, parseAdapterText, validateAdapter } from "@liaison/api-connector-core"

export const FIXTURE_CRM_ADAPTER_FILE = join(import.meta.dir, "fixture-crm.adapter.yaml")
export const FIXTURE_CRM_OPENAPI_FILE = join(import.meta.dir, "openapi.json")

export function fixtureCrmAdapterText(): string {
  return readFileSync(FIXTURE_CRM_ADAPTER_FILE, "utf8")
}

function issuesText(issues: { path: string; message: string }[]): string {
  return issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")
}

export function loadFixtureCrmAdapter(options: { baseUrl?: string } = {}): Adapter {
  const parsed = parseAdapterText(fixtureCrmAdapterText())
  if (!parsed.ok) throw new Error(`fixture-crm adapter is invalid: ${issuesText(parsed.issues)}`)
  if (options.baseUrl === undefined) return parsed.adapter
  const again = validateAdapter({ ...parsed.adapter, baseUrl: options.baseUrl })
  if (!again.ok)
    throw new Error(`fixture-crm adapter override is invalid: ${issuesText(again.issues)}`)
  return again.adapter
}
