// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Registration-time checks for provider contracts (manifest `implements` / `contract_calls`,
// tool flags `contractOnly` / `noAutoApprove`). Shared by the manifest and descriptor validators,
// so an app whose contract declarations are wrong is refused at registration instead of failing
// at its first dispatch.
//
// A provider declares `implements:[{contract, version, tools:{<op>:<tool>}}]`. The contract must
// be one the kernel knows, every required op must be mapped, every op tool must exist, be
// `trustBoundary:"internal"`, `agentVisible:false`, not gated and `contractOnly:true`, and declare
// at least the contract's params for that op. A caller declares
// `contract_calls:[{contract:"<name>@<version>", bindingSetting:"<own table>.<column>"}]`, the
// binding column living in its own schema (packaged apps have no org settings store).

import { KNOWN_CONTRACTS } from "@liaison/app-sdk/contracts"

export const BINDING_SETTING_RE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/

interface ToolLike {
  trustBoundary?: string
  agentVisible?: boolean
  gated?: boolean
  conditionalGate?: boolean
  contractOnly?: boolean
  noAutoApprove?: boolean
  params?: unknown
}

function declaredParamNames(params: unknown): Set<string> | null {
  if (!params || typeof params !== "object") return new Set()
  const p = params as { type?: unknown; properties?: Record<string, unknown>; safeParse?: unknown }
  if (typeof p.safeParse === "function") return null // a Zod schema (descriptor apps): not inspectable here
  if (p.type === "object" || p.properties) return new Set(Object.keys(p.properties ?? {}))
  // Descriptor field map { name: "type" }.
  return new Set(Object.keys(p as Record<string, unknown>))
}

export function contractKey(contract: string, version: number | string): string {
  return `${contract}@${version}`
}

export function validateProviderContracts(
  manifest: Record<string, unknown>,
  errors: string[],
): void {
  const tools = (manifest.tools ?? {}) as Record<string, ToolLike>
  const mappedTools = new Set<string>()

  const impls = manifest.implements
  if (impls !== undefined) {
    if (!Array.isArray(impls)) {
      errors.push("implements: must be an array")
    } else {
      impls.forEach((impl: Record<string, unknown>, i: number) => {
        const key = contractKey(String(impl?.contract ?? ""), String(impl?.version ?? ""))
        const spec = KNOWN_CONTRACTS[key]
        if (!spec) {
          errors.push(`implements[${i}]: unknown contract "${key}"`)
          return
        }
        const map = (impl.tools ?? {}) as Record<string, unknown>
        for (const op of Object.keys(map)) {
          if (!spec.ops[op]) errors.push(`implements[${i}].tools.${op}: "${key}" has no op "${op}"`)
        }
        for (const [op, opSpec] of Object.entries(spec.ops)) {
          const toolName = map[op]
          if (toolName === undefined) {
            if (opSpec.required) errors.push(`implements[${i}].tools: "${key}" requires op "${op}"`)
            continue
          }
          if (typeof toolName !== "string" || !tools[toolName]) {
            errors.push(
              `implements[${i}].tools.${op}: tool "${String(toolName)}" is not a tool of this app`,
            )
            continue
          }
          mappedTools.add(toolName)
          const t = tools[toolName]!
          if (t.trustBoundary !== "internal")
            errors.push(`tools.${toolName}: a contract op must be trustBoundary "internal"`)
          if (t.agentVisible !== false)
            errors.push(`tools.${toolName}: a contract op must be agentVisible false`)
          if (t.gated === true || t.conditionalGate === true)
            errors.push(`tools.${toolName}: a contract op must not be gated`)
          if (t.contractOnly !== true)
            errors.push(`tools.${toolName}: a contract op must be contractOnly true`)
          const declared = declaredParamNames(t.params)
          if (declared) {
            for (const p of opSpec.params) {
              if (!declared.has(p))
                errors.push(`tools.${toolName}: contract op "${op}" requires param "${p}"`)
            }
          }
        }
      })
    }
  }

  for (const [toolName, t] of Object.entries(tools)) {
    if (t?.contractOnly === true && !mappedTools.has(toolName)) {
      errors.push(
        `tools.${toolName}: contractOnly but not mapped by any implements entry (unreachable)`,
      )
    }
    if (t?.noAutoApprove === true && t.gated !== true && t.conditionalGate !== true) {
      errors.push(`tools.${toolName}: noAutoApprove is only meaningful on a gated tool`)
    }
  }

  const calls = manifest.contract_calls
  if (calls !== undefined) {
    if (!Array.isArray(calls)) {
      errors.push("contract_calls: must be an array")
    } else {
      const schema = (manifest.schema ?? {}) as Record<string, { fields?: Record<string, unknown> }>
      calls.forEach((c: Record<string, unknown>, i: number) => {
        const key = String(c?.contract ?? "")
        if (!KNOWN_CONTRACTS[key]) errors.push(`contract_calls[${i}]: unknown contract "${key}"`)
        const m = BINDING_SETTING_RE.exec(String(c?.bindingSetting ?? ""))
        if (!m) {
          errors.push(`contract_calls[${i}].bindingSetting: must be "<own table>.<column>"`)
          return
        }
        const [, table, column] = m
        if (!schema[table!]?.fields || !Object.hasOwn(schema[table!]!.fields!, column!)) {
          errors.push(
            `contract_calls[${i}].bindingSetting: "${table}.${column}" is not a column of this app's schema`,
          )
        }
      })
    }
  }
}
