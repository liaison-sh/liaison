// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison api-connector test <identifier> <operation> [--param k=v] [--pages N | --all-pages]
 * [--dry-run] [--org <slug>]`: one page (or N, or every page the operation
 * allows) of a READ operation of a stored connection, through the same
 * service the agent tools and the Test panel use; a write operation is
 * refused before any request (exit 1). `--dry-run` sends nothing and reads no
 * credential: it prints the rendered request (method, URL, headers with the
 * auth value redacted, body) of any operation, a write included. Needs the
 * deployment's environment (database, Redis, secrets). `validate` is offline
 * and lives in validate.ts.
 */

import { MAX_PAGES_PER_CALL, type Operation } from "@liaison/api-connector-core"
import { runConnectorOperation } from "~/apps/api-connector/service"
import { getAdapterRow } from "~/apps/api-connector/store"
import {
  API_CONNECTOR_PAGES_BUDGET_MS,
  API_CONNECTOR_REQUEST_TIMEOUT_MS,
  ApiConnectorError,
  describeRequest,
} from "~/apps/api-connector/transport"
import type { CliRunResult } from "~/cli/api-connector/validate"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"

/** Parse repeated `--param name=value` flags, typed by the operation's params schema. */
export function parseParamFlags(
  argv: readonly string[],
  op: Pick<Operation, "params">,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const params: Record<string, unknown> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--param") continue
    const raw = argv[i + 1]
    const eq = raw?.indexOf("=") ?? -1
    if (!raw || eq <= 0)
      return { ok: false, message: `--param expects name=value (got '${raw ?? ""}')` }
    const name = raw.slice(0, eq)
    const value = raw.slice(eq + 1)
    const spec = op.params.properties[name]
    if (!spec) {
      params[name] = value
      continue
    }
    const coerce = (type: string, v: string): unknown =>
      type === "number" || type === "integer" ? Number(v) : type === "boolean" ? v === "true" : v
    params[name] =
      spec.type === "array"
        ? value.split(",").map((v) => coerce(spec.items.type, v))
        : coerce(spec.type, value)
  }
  return { ok: true, params }
}

export interface TestRunFlags {
  /** Pages to fetch at most (1..5), or "all" for the operation's own maximum. */
  pages: number | "all"
  dryRun: boolean
}

/** Parse `--pages N`, `--all-pages` and `--dry-run`. */
export function parseTestFlags(
  argv: readonly string[],
): { ok: true; flags: TestRunFlags } | { ok: false; message: string } {
  let pages: number | "all" = 1
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--all-pages") pages = "all"
    else if (a === "--dry-run") dryRun = true
    else if (a === "--pages") {
      const n = Number(argv[i + 1])
      if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES_PER_CALL)
        return {
          ok: false,
          message: `--pages expects a whole number from 1 to ${MAX_PAGES_PER_CALL}`,
        }
      pages = n
      i++
    }
  }
  if (argv.includes("--pages") && argv.includes("--all-pages"))
    return { ok: false, message: "pass --pages N or --all-pages, not both" }
  return { ok: true, flags: { pages, dryRun } }
}

function errorReport(err: ApiConnectorError): CliRunResult {
  return {
    exitCode: 1,
    report: {
      ok: false,
      code: err.code,
      message: err.message,
      ...(err.upstreamStatus !== undefined ? { status: err.upstreamStatus } : {}),
    },
  }
}

export async function runApiConnectorTest(input: {
  identifier: string
  operation: string
  argv: readonly string[]
  orgSlug?: string
}): Promise<CliRunResult> {
  const org = await resolveOrgId(input.orgSlug, "more than one org exists: pass --org <slug>")
  if (!org.ok) return { exitCode: 2, report: { ok: false }, message: org.message }
  const row = await getAdapterRow(org.orgId, input.identifier)
  const op = row?.adapter.operations.find((o) => o.name === input.operation)
  const parsed = op ? parseParamFlags(input.argv, op) : { ok: true as const, params: {} }
  if (!parsed.ok) return { exitCode: 2, report: { ok: false }, message: parsed.message }
  const flags = parseTestFlags(input.argv)
  if (!flags.ok) return { exitCode: 2, report: { ok: false }, message: flags.message }
  if (flags.flags.dryRun) {
    if (!row)
      return errorReport(
        new ApiConnectorError(
          "unknown_connection",
          `No API connection named "${input.identifier}".`,
        ),
      )
    if (!op)
      return errorReport(
        new ApiConnectorError(
          "unknown_operation",
          `The connection "${input.identifier}" has no operation "${input.operation}".`,
        ),
      )
    try {
      return {
        exitCode: 0,
        report: {
          ok: true,
          dryRun: true,
          kind: op.kind,
          request: describeRequest(row.adapter, op, parsed.params),
        },
      }
    } catch (err) {
      if (err instanceof ApiConnectorError) return errorReport(err)
      throw err
    }
  }
  const maxPages =
    flags.flags.pages === "all"
      ? Math.min(op?.pagination?.maxPages ?? MAX_PAGES_PER_CALL, MAX_PAGES_PER_CALL)
      : flags.flags.pages
  try {
    const r = await runConnectorOperation({
      actor: { orgId: org.orgId, userId: "system:cli-api-connector-test", actorType: "system" },
      identifier: input.identifier,
      operation: input.operation,
      params: parsed.params,
      mode: "test",
      maxPages,
      budgetMs:
        maxPages === 1 && !op?.chain
          ? API_CONNECTOR_REQUEST_TIMEOUT_MS + 2_000
          : API_CONNECTOR_PAGES_BUDGET_MS,
    })
    return {
      exitCode: 0,
      report: {
        ok: true,
        status: r.status,
        items: r.items,
        truncated: r.truncated,
        pages: r.pages,
        ms: r.ms,
      },
    }
  } catch (err) {
    if (err instanceof ApiConnectorError) return errorReport(err)
    throw err
  }
}
