// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contract resolution: which provider app serves `<contract>@<version>` for a calling app in an
// org. The authority is the KERNEL binding (`binding.ts`: org settings no app can write, set by an
// administrator through an audited kernel path, naming the caller explicitly). The caller's own
// mirror column (`contract_calls[].bindingSetting` = `<table>.<column>` in its schema, what its
// settings screen shows) must agree with it when set, so a call never reaches a provider other
// than the one the organisation sees configured. Both are read host-side on every call, so a
// switch takes effect at once and nothing is cached across orgs.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import {
  appContractCallsRegistry,
  appContractImplementationsRegistry,
} from "~/modules/apps/app-registries"
import { readKernelContractBinding } from "~/modules/apps/provider-contracts/binding"
import { BINDING_SETTING_RE } from "~/modules/apps/provider-contracts/validate"

export type ContractResolution =
  | { ok: true; provider: string; ops: Record<string, string> }
  | { ok: false; code: string; message: string }

/** Reads the caller's mirror of the binding (the provider app name it shows), or null when unset. */
export async function readContractBinding(
  orgId: string,
  callerApp: string,
  bindingSetting: string,
): Promise<string | null> {
  const m = BINDING_SETTING_RE.exec(bindingSetting)
  if (!m) return null
  const schema = schemaRef(`app_${callerApp.replace(/-/g, "_")}`)
  const rows = await withPrivilegedDb(orgId, "contract-binding-read", async (tx) =>
    extractRows<{ v: unknown }>(
      await tx.execute(
        drizzleSql`SELECT ${drizzleSql.raw(quoteIdent(m[2]!))}::text AS v
          FROM ${drizzleSql.raw(`${quoteIdent(schema)}.${quoteIdent(m[1]!)}`)}
          WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    ),
  )
  const v = rows[0]?.v
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

export async function resolveContractProvider(
  orgId: string,
  callerApp: string,
  contract: string,
): Promise<ContractResolution> {
  const declared = appContractCallsRegistry.get([orgId, callerApp])?.[contract]
  if (!declared) {
    return {
      ok: false,
      code: "contract_undeclared",
      message: `${callerApp} does not declare contract_calls for ${contract}`,
    }
  }
  const provider = await readKernelContractBinding(orgId, contract, callerApp)
  if (!provider) {
    return {
      ok: false,
      code: "contract_provider_not_configured",
      message: `No provider is bound for ${contract} and ${callerApp}: an organisation administrator binds one (config apply, or the app's settings)`,
    }
  }
  const mirrored = await readContractBinding(orgId, callerApp, declared.bindingSetting)
  if (mirrored !== null && mirrored !== provider) {
    return {
      ok: false,
      code: "contract_binding_mismatch",
      message: `${callerApp} shows "${mirrored}" as its ${contract} provider but the organisation bound "${provider}": an administrator re-applies the setting`,
    }
  }
  const impl = appContractImplementationsRegistry.get([orgId, provider])?.[contract]
  if (!impl) {
    return {
      ok: false,
      code: "contract_provider_unavailable",
      message: `The configured provider "${provider}" is not installed or does not implement ${contract}`,
    }
  }
  return { ok: true, provider, ops: impl.ops }
}

/**
 * True when a dispatch claiming to be the contract op `op` of `contract`, from `callerApp`, to
 * `providerApp:toolShortName`, matches the registries (the caller declares the contract, the
 * provider implements it, and that op maps to that tool). The bridge resolved the binding just
 * before; this re-check keeps `contractOnly` tools unreachable by any other path.
 */
export function isDeclaredContractDispatch(
  orgId: string,
  callerApp: string,
  providerApp: string,
  toolShortName: string,
  call: { contract: string; op: string },
): boolean {
  if (!appContractCallsRegistry.get([orgId, callerApp])?.[call.contract]) return false
  const impl = appContractImplementationsRegistry.get([orgId, providerApp])?.[call.contract]
  return impl?.ops[call.op] === toolShortName
}
