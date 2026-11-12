// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.accounts.*`: the calling app's own connected accounts, for app code on
 * every executor. What an app needed a privileged database handle for (its
 * accounts with their metadata, saving a choice into one) as two narrow,
 * scope-checked methods:
 *
 *  - `accounts_list(connection, opts?)`: the accounts of one connection the
 *    calling app's manifest declares: the organization's, plus the acting
 *    person's own. Never another member's personal account, never another
 *    app's, never another org's, never a token or a credential. Each says
 *    whether the caller may manage it (`canManage`).
 *  - `accounts_setMetadata(accountId, patch)`: merge keys into the metadata of
 *    one of those accounts (a `null` value removes the key). A personal account
 *    is its owner's to change; an organization's needs the connection's admin
 *    scope (`connections.<name>.adminScope`, default `<app>:accounts:admin`),
 *    or the app's own system run. Audited with the keys changed. The keys the
 *    kernel owns (connections/kernel-account-metadata.ts) are refused.
 *
 * The org-owned rows are invisible to RLS (only the kernel's own are), so both
 * read through a privileged transaction whose predicate pins org, app and
 * connection: the narrowing is in the query, not in the caller's hands.
 * `accounts` is a structured-return group (ctx-shim.ts SHIM_RULES).
 */
import { and, eq, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { isUuid } from "~/lib/uuid"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { isKernelAccountMetadataKey } from "~/modules/apps/connections/kernel-account-metadata"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import { hasScope } from "~/modules/permissions/permissions"

const METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const MAX_METADATA_BYTES = 32 * 1024

export interface AppAccountView {
  id: string
  identifier: string
  ownerType: "org" | "user"
  ownerId: string | null
  displayName: string | null
  status: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  canManage: boolean
}

function jsonArg(raw: unknown, what: string): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw typedError(400, "invalid_request", `ctx.accounts: ${what} is not JSON`)
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "")
}

export function createAccountsMethods(
  ctx: Pick<
    BridgeContext,
    "appName" | "orgId" | "userId" | "actorType" | "manifest" | "callerScopes"
  >,
): {
  accounts_list: (connection: string, optsJson?: unknown) => Promise<string>
  accounts_setMetadata: (accountId: string, patchJson: unknown) => Promise<string>
} {
  const { appName, orgId, userId, actorType, manifest } = ctx
  const person = actorType === "user" && isUuid(userId) ? userId : null

  function assertDeclared(connection: unknown): string {
    if (typeof connection !== "string" || !manifest.connections?.[connection]) {
      throw typedError(
        404,
        "unknown_connection",
        `ctx.accounts: connection "${String(connection)}" is not declared in the app manifest`,
      )
    }
    return connection
  }

  function mayManage(row: { ownerType: string; ownerId: string | null; connectionName: string }) {
    if (row.ownerType === "user") return person !== null && row.ownerId === person
    if (actorType === "system") return true
    return hasScope(
      connectionAdminScope(orgId, appName, row.connectionName),
      ctx.callerScopes ?? [],
    )
  }

  /** The org's accounts and the acting person's own, of one connection of this app. */
  const visible = (connection: string) =>
    and(
      eq(connectedAccounts.orgId, orgId),
      eq(connectedAccounts.appName, appName),
      eq(connectedAccounts.connectionName, connection),
      person
        ? or(
            eq(connectedAccounts.ownerType, "org"),
            and(eq(connectedAccounts.ownerType, "user"), eq(connectedAccounts.ownerId, person)),
          )
        : eq(connectedAccounts.ownerType, "org"),
    )

  const columns = {
    id: connectedAccounts.id,
    identifier: connectedAccounts.identifier,
    ownerType: connectedAccounts.ownerType,
    ownerId: connectedAccounts.ownerId,
    displayName: connectedAccounts.displayName,
    status: connectedAccounts.status,
    metadata: connectedAccounts.metadata,
    connectionName: connectedAccounts.connectionName,
    createdAt: connectedAccounts.createdAt,
    updatedAt: connectedAccounts.updatedAt,
  }

  function view(row: {
    id: string
    identifier: string
    ownerType: string
    ownerId: string | null
    displayName: string | null
    status: string
    metadata: unknown
    connectionName: string
    createdAt: unknown
    updatedAt: unknown
  }): AppAccountView {
    return {
      id: row.id,
      identifier: row.identifier,
      ownerType: row.ownerType === "org" ? "org" : "user",
      ownerId: row.ownerId,
      displayName: row.displayName,
      status: row.status,
      metadata:
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {},
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      canManage: mayManage(row),
    }
  }

  return {
    accounts_list: async (connection, optsJson) => {
      const name = assertDeclared(connection)
      const opts = (jsonArg(optsJson, "the options") ?? {}) as {
        identifier?: unknown
        includeInactive?: unknown
      }
      if (typeof opts !== "object" || Array.isArray(opts)) {
        throw typedError(400, "invalid_request", "ctx.accounts.list: the options are an object")
      }
      const conditions = [visible(name)]
      if (typeof opts.identifier === "string") {
        conditions.push(eq(connectedAccounts.identifier, opts.identifier))
      }
      if (opts.includeInactive !== true) conditions.push(eq(connectedAccounts.status, "active"))
      const rows = await withPrivilegedDb(orgId, `app-accounts-list:${appName}`, (tx) =>
        tx
          .select(columns)
          .from(connectedAccounts)
          .where(and(...conditions))
          .orderBy(connectedAccounts.createdAt),
      )
      return JSON.stringify(rows.map(view))
    },

    accounts_setMetadata: async (accountId, patchJson) => {
      if (typeof accountId !== "string" || !isUuid(accountId)) {
        throw typedError(
          400,
          "invalid_request",
          "ctx.accounts.setMetadata: accountId is an account id",
        )
      }
      const patch = jsonArg(patchJson, "the patch")
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw typedError(400, "invalid_request", "ctx.accounts.setMetadata: the patch is an object")
      }
      const keys = Object.keys(patch)
      const bad = keys.filter((k) => !METADATA_KEY.test(k))
      if (keys.length === 0 || bad.length > 0) {
        throw typedError(
          400,
          "invalid_request",
          `ctx.accounts.setMetadata: keys are identifiers (${bad.join(", ") || "none given"})`,
        )
      }
      // The kernel's own keys (the recorded OAuth grant, the admin-chosen drives
      // and items, the token expiry) are decisions, not app data: refused for
      // every caller, a system run of the app included.
      const reserved = keys.filter(isKernelAccountMetadataKey)
      if (reserved.length > 0) {
        throw typedError(
          403,
          "reserved_metadata_key",
          `ctx.accounts.setMetadata: ${reserved.join(", ")} ${reserved.length === 1 ? "is" : "are"} kept by the platform`,
        )
      }
      return withPrivilegedDb(orgId, `app-accounts-set-metadata:${appName}`, async (tx) => {
        const [row] = await tx
          .select(columns)
          .from(connectedAccounts)
          .where(
            and(
              eq(connectedAccounts.id, accountId),
              eq(connectedAccounts.orgId, orgId),
              eq(connectedAccounts.appName, appName),
            ),
          )
          .limit(1)
        // Another app's account, another member's or another org's: not found,
        // the same answer as an unknown id.
        const declared = row && manifest.connections?.[row.connectionName]
        const own = row && (row.ownerType === "org" || (person !== null && row.ownerId === person))
        if (!row || !declared || !own) {
          throw typedError(404, "not_found", "ctx.accounts.setMetadata: no such account")
        }
        if (!mayManage(row)) {
          throw typedError(
            403,
            "forbidden",
            `ctx.accounts.setMetadata: changing the organization's account needs ${connectionAdminScope(orgId, appName, row.connectionName)}`,
          )
        }
        const next: Record<string, unknown> = { ...view(row).metadata }
        for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
          if (v === null) delete next[k]
          else next[k] = v
        }
        if (JSON.stringify(next).length > MAX_METADATA_BYTES) {
          throw typedError(413, "too_large", "ctx.accounts.setMetadata: metadata is at most 32 KiB")
        }
        const now = new Date()
        await tx
          .update(connectedAccounts)
          .set({ metadata: next, updatedAt: now })
          .where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.orgId, orgId)))
        const { writeAuditLog } = await import("~/modules/audit/service")
        await writeAuditLog(tx, {
          orgId,
          actorId: person,
          actorType: person ? "user" : "system",
          app: appName,
          entityType: "connected_account",
          entityId: accountId,
          action: `${appName}.account_metadata.changed`,
          metadata: { identifier: row.identifier, keys },
        })
        return JSON.stringify(view({ ...row, metadata: next, updatedAt: now }))
      })
    },
  }
}
