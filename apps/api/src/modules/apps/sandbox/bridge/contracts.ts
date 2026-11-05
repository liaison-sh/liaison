// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.contracts.call(contract, op, params)`: the kernel provider-contract dispatch. The calling
// app names a contract it declares in `contract_calls` and an op; the kernel reads the caller's
// own admin-set binding, checks the bound provider is registered and implements that contract
// version, and dispatches the op's tool through `executeToolCore` as a declared internal
// cross-app call (`internalCall.contractCall`), which is the only way into a `contractOnly` tool.
// The provider's handler runs with its own data scopes only; the caller's files an op names (a
// legal original) are granted to it one by one, after checking the caller can read them.
//
// The answer is the K4 envelope: `{status:"completed", result}` or `{status:"error", error}`.
//
// Authorization (who may make the provider act):
//   - the provider is the KERNEL binding for this caller (`provider-contracts/binding.ts`), which
//     only an organisation administrator sets (`contracts_setBinding` below, or config apply);
//   - an op the contract marks `outbound` (deposit, transmission, booking) also needs a dispatch
//     grant (`provider-contracts/grant.ts`), which `contracts_grant` mints only inside a person's
//     approval of one of the caller's own gated `noAutoApprove` tools, or on that approver's own
//     click. The kernel re-checks the grant against the call's params at the dispatch choke point
//     (execute-tool.ts), so it cannot be widened to another document or op.

import { contractFileParams, isOutboundOp } from "@liaison/app-sdk/contracts"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { UUID_RE } from "~/lib/uuid"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { hasScope } from "~/modules/permissions/permissions"

function errorJson(code: string, message: string, retryable = false): string {
  return JSON.stringify({ status: "error", error: { code, message, retryable } })
}

export function createContractsMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    approvalContext,
    bridgeActingAgentId,
    bridgeOptions,
    bridgeReadOnlyRun,
    bridgeTaintOriginStore,
    bridgeTurnTaintScopes,
    inheritedActor,
    orgId,
    txDb,
  } = ctx
  return {
    // The apps registered in this org that implement `contract` (for a settings screen choosing
    // the binding, and for checking a binding before it is written). Names only.
    contracts_providers: async (contract: string): Promise<string> => {
      const { appContractImplementationsRegistry } = await import("~/modules/apps/app-registries")
      const out: string[] = []
      for (const [[, app], impls] of appContractImplementationsRegistry.entriesOf(orgId)) {
        if (impls[String(contract)]) out.push(app)
      }
      return JSON.stringify(out.sort())
    },
    // The provider the organisation's administrator bound for THIS app and contract.
    contracts_binding: async (contract: string): Promise<string> => {
      const { readKernelContractBinding } = await import(
        "~/modules/apps/provider-contracts/binding"
      )
      return JSON.stringify({
        provider: await readKernelContractBinding(orgId, String(contract), appName).catch(
          () => null,
        ),
      })
    },

    // Bind (or clear) the provider of `contract` for THIS app. Only a person holding
    // `kernel:org:admin`, acting through their own UI click or an approval they requested; never
    // a job, an event handler or an agent. The binding must name an app implementing the contract.
    contracts_setBinding: async (contract: string, provider: string | null): Promise<string> => {
      const key = String(contract)
      const { appContractCallsRegistry, appContractImplementationsRegistry } = await import(
        "~/modules/apps/app-registries"
      )
      if (!appContractCallsRegistry.get([orgId, appName])?.[key]) {
        return errorJson(
          "contract_undeclared",
          `${appName} does not declare contract_calls for ${key}`,
        )
      }
      const actor = inheritedActor
      const personActing = bridgeOptions?.origin === "human-ui" || approvalContext != null
      if (
        actor.actorType !== "user" ||
        !personActing ||
        !hasScope("kernel:org:admin", actor.scopes ?? [])
      ) {
        return errorJson(
          "contract_binding_forbidden",
          "Only an organisation administrator, acting in person, can choose the provider of a contract",
        )
      }
      const next =
        provider === null || provider === undefined || provider === "" ? null : String(provider)
      if (next !== null && !appContractImplementationsRegistry.get([orgId, next])?.[key]) {
        return errorJson(
          "provider_not_available",
          `${next} is not an installed app implementing ${key}`,
        )
      }
      const { writeKernelContractBinding } = await import(
        "~/modules/apps/provider-contracts/binding"
      )
      const { withPrivilegedDb } = await import("~/db/privileged")
      const out = await withPrivilegedDb(orgId, "contract-binding-write", (tx) =>
        writeKernelContractBinding(tx as never, {
          orgId,
          contract: key,
          callerApp: appName,
          provider: next,
          actorId: actor.actorType === "user" ? actor.userId : null,
          actorType: "user",
          source: approvalContext ? `approval:${approvalContext.approvalRequestId}` : "ui",
        }),
      )
      return JSON.stringify({ status: "ok", provider: next, previous: out.previous })
    },

    // Mint the dispatch grant for outbound `ops` binding `subject`. Only inside a person's decision
    // on one of THIS app's gated, noAutoApprove tools: its approved re-entry, or its direct run on
    // the click of a holder of its approve scope.
    contracts_grant: async (
      contract: string,
      opsJson: string,
      subjectJson: string,
    ): Promise<string> => {
      const key = String(contract)
      const { appContractCallsRegistry, toolRegistry } = await import(
        "~/modules/apps/app-registries"
      )
      if (!appContractCallsRegistry.get([orgId, appName])?.[key]) {
        return errorJson(
          "contract_undeclared",
          `${appName} does not declare contract_calls for ${key}`,
        )
      }
      let ops: unknown
      let subject: unknown
      try {
        ops = typeof opsJson === "string" ? JSON.parse(opsJson) : opsJson
        subject = typeof subjectJson === "string" ? JSON.parse(subjectJson) : subjectJson
      } catch {
        return errorJson(
          "invalid_input",
          "contracts.grant takes a list of ops and a subject object",
        )
      }
      const { grantRequestProblem, mintContractGrant } = await import(
        "~/modules/apps/provider-contracts/grant"
      )
      const problem = grantRequestProblem(key, ops, subject)
      if (problem) return errorJson("invalid_input", problem)
      const ownHumanOnlyGated = (full: string | undefined): boolean => {
        if (!full || !full.startsWith(`${appName}:`)) return false
        const t = toolRegistry.get([orgId, appName, full.slice(appName.length + 1)])
        return t?.gated === true && t.noAutoApprove === true
      }
      let via: string | null = null
      if (approvalContext && ownHumanOnlyGated(approvalContext.toolName)) {
        via = approvalContext.approvalRequestId
      } else if (
        bridgeOptions?.humanAuthorized === true &&
        bridgeOptions.origin === "human-ui" &&
        ownHumanOnlyGated(bridgeOptions.callChain?.[bridgeOptions.callChain.length - 1])
      ) {
        via = "direct_click"
      }
      if (!via) {
        return errorJson(
          "contract_grant_refused",
          "A dispatch grant is minted only inside a person's approval of a gated, never-auto-approved tool of this app",
        )
      }
      const { readKernelContractBinding } = await import(
        "~/modules/apps/provider-contracts/binding"
      )
      const bound = await readKernelContractBinding(orgId, key, appName)
      if (!bound)
        return errorJson("contract_provider_not_configured", `No provider is bound for ${key}`)
      const grant = mintContractGrant({
        org: orgId,
        caller: appName,
        contract: key,
        ops: ops as string[],
        subject: subject as Record<string, string>,
        via,
        provider: bound,
      })
      return JSON.stringify({ grant })
    },

    contracts_call: async (
      contract: string,
      op: string,
      paramsJson?: string,
      optsJson?: string,
    ): Promise<string> => {
      const { resolveContractProvider } = await import("~/modules/apps/provider-contracts/resolve")
      const resolution = await resolveContractProvider(orgId, appName, String(contract))
      if (!resolution.ok) return errorJson(resolution.code, resolution.message)
      let params: unknown
      let opts: { grant?: unknown; provider?: unknown } = {}
      try {
        params = JSON.parse(paramsJson || "{}")
        const o = optsJson ? JSON.parse(optsJson) : {}
        if (o && typeof o === "object" && !Array.isArray(o))
          opts = o as { grant?: unknown; provider?: unknown }
      } catch {
        return errorJson("invalid_input", "contracts.call params must be a JSON object")
      }
      // Work pinned to a provider (a transmission row records which PA it went through) goes
      // through that provider only. After a switch of binding: an outbound op is refused (the
      // person approved it through the other PA); a read goes to the pinned provider, provided it
      // was bound to this caller before and still implements the contract.
      let target = resolution.provider
      let targetOps = resolution.ops
      const pinned =
        typeof opts.provider === "string" && opts.provider !== "" ? opts.provider : null
      if (pinned && pinned !== resolution.provider) {
        if (isOutboundOp(String(contract), String(op))) {
          return errorJson(
            "contract_provider_changed",
            `This work was approved for ${pinned}; the organisation now binds ${resolution.provider}: ask for it again`,
          )
        }
        const { readKernelContractBindingHistory } = await import(
          "~/modules/apps/provider-contracts/binding"
        )
        const { appContractImplementationsRegistry } = await import("~/modules/apps/app-registries")
        const impl = appContractImplementationsRegistry.get([orgId, pinned])?.[String(contract)]
        if (
          !impl ||
          !(await readKernelContractBindingHistory(orgId, String(contract), appName)).includes(
            pinned,
          )
        ) {
          return errorJson(
            "contract_provider_unavailable",
            `${pinned} is not a provider this app was bound to that still implements ${contract}`,
          )
        }
        target = pinned
        targetOps = impl.ops
      }
      const toolShort = targetOps[String(op)]
      if (!toolShort) {
        return errorJson(
          "contract_op_unsupported",
          `${target} does not implement op "${op}" of ${contract}`,
        )
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return errorJson("invalid_input", "contracts.call params must be an object")
      }
      const grant = typeof opts.grant === "string" ? opts.grant : undefined
      if (isOutboundOp(String(contract), String(op))) {
        const { verifyContractGrant } = await import("~/modules/apps/provider-contracts/grant")
        const check = verifyContractGrant(grant, {
          orgId,
          callerApp: appName,
          contract: String(contract),
          op: String(op),
          params,
          provider: target,
        })
        if (!check.ok) return errorJson(check.code, check.message)
      }
      // The provider runs with its own data scopes only (execute-tool.ts): the caller's files it
      // needs for this op (the params the contract names, e.g. the legal original) are granted
      // one by one, and only when the CALLER can read them under its own RLS context right now.
      const files: string[] = []
      for (const fp of contractFileParams(String(contract), String(op))) {
        const fileId = (params as Record<string, unknown>)[fp]
        if (fileId === undefined || fileId === null) continue
        if (typeof fileId !== "string" || !UUID_RE.test(fileId)) {
          return errorJson("invalid_input", `${fp} must be a kernel file id`)
        }
        const KS = drizzleSql.raw(schemaRef("kernel"))
        const q = drizzleSql`SELECT id FROM ${KS}.files WHERE id = ${fileId} AND org_id = ${orgId} LIMIT 1`
        const withShortTx = bridgeOptions?.withShortTx
        const res = withShortTx ? await withShortTx((tx) => tx.execute(q)) : await txDb.execute(q)
        if (extractRows(res).length === 0) {
          return errorJson("file_not_readable", `${fp}: the file is not readable by ${appName}`)
        }
        files.push(fileId)
      }
      const { executeToolCore } = await import("~/modules/apps/execute-tool")
      const actor = inheritedActor
      const env = await executeToolCore({
        toolName: `${target}:${toolShort}`,
        orgId,
        actor,
        params,
        readOnlyRun: bridgeReadOnlyRun,
        turnTaintScopes: bridgeTurnTaintScopes,
        ...(bridgeTaintOriginStore !== undefined
          ? { turnTaintOrigins: bridgeTaintOriginStore }
          : {}),
        actingAgentId: bridgeActingAgentId,
        threadId: bridgeOptions?.threadId,
        callChain: bridgeOptions?.callChain ?? [],
        parentExecutionToken: bridgeOptions?.parentExecutionToken,
        taintState: bridgeOptions?.taintState ?? { taintedSources: [] },
        priority: bridgeOptions?.priority,
        // Same provenance rule as ctx.executeTool: a human click never crosses an app boundary.
        origin:
          bridgeOptions?.origin === "mcp"
            ? "mcp"
            : bridgeOptions?.origin === "in-app-agent" || bridgeOptions?.origin === "human-ui"
              ? "in-app-agent"
              : "system",
        internalCall: {
          callerApp: appName,
          contractCall: {
            contract: String(contract),
            op: String(op),
            ...(grant ? { grant } : {}),
            ...(files.length > 0 ? { files } : {}),
          },
          humanAuthorized: bridgeOptions?.humanAuthorized === true || approvalContext != null,
          humanAuthorizedVia: approvalContext != null ? "approval" : "human-ui",
          ...(approvalContext ? { outerApprovalRequestId: approvalContext.approvalRequestId } : {}),
        },
      })
      if ("data" in env)
        return JSON.stringify({
          status: "completed",
          result: env.data,
          provider: target,
        })
      if ("blocked" in env) {
        // A contract op is never gated (registration refuses it); a block here is a policy
        // tightening on the provider tool, surfaced as an error the caller can report.
        return errorJson("contract_op_blocked", `${target}:${toolShort} was held for approval`)
      }
      if ("error" in env) {
        return JSON.stringify({
          status: "error",
          error: {
            code: env.error.code,
            message: env.error.message,
            retryable: env.error.retryable,
          },
        })
      }
      return errorJson("internal_error", "contracts.call: unknown envelope variant")
    },
  }
}
