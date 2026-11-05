// SPDX-License-Identifier: FSL-1.1-ALv2
import { bindingAllowsOrg, hostBindingEnabled, rawRequestHostBinding } from "~/lib/org-host"
import { effectiveRequestFromRaw } from "~/lib/request-context"
import { isOrgDeletingAsync } from "~/modules/apps/org-apps"
import { isUserAuthCurrent } from "~/modules/auth/auth-state"
import { isSessionRevoked } from "~/modules/auth/session-revocation"
import { createScope, type Scope } from "~/modules/permissions/types"

export interface TicketPayload {
  userId: string
  orgId: string
  scopes: Scope[]
  roles: string[]
  dimensionGrants: Record<string, string[]>
  authVersion: number
  permissionVersion: number
  /** The sign-in session the ticket was minted from, when it had one. */
  sid?: string
  /** With org hosts: the host the ticket was minted on; it opens a socket there only. */
  host?: string
}

/** Parse and validate a WS ticket payload from Redis. Returns null if invalid. */
export function parseTicketPayload(raw: string): TicketPayload | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed.userId === "string" &&
      parsed.userId.length > 0 &&
      typeof parsed.orgId === "string" &&
      parsed.orgId.length > 0 &&
      Array.isArray(parsed.scopes) &&
      typeof parsed.authVersion === "number" &&
      typeof parsed.permissionVersion === "number"
    ) {
      return {
        userId: parsed.userId,
        orgId: parsed.orgId,
        scopes: (parsed.scopes as string[]).map(createScope),
        roles: Array.isArray(parsed.roles) ? parsed.roles : [],
        dimensionGrants: parsed.dimensionGrants ?? {},
        authVersion: parsed.authVersion,
        permissionVersion: parsed.permissionVersion,
        ...(typeof parsed.sid === "string" && parsed.sid.length > 0 ? { sid: parsed.sid } : {}),
        ...(typeof parsed.host === "string" && parsed.host.length > 0 ? { host: parsed.host } : {}),
      }
    }
  } catch {
    // Malformed JSON or invalid scope
  }
  return null
}

export async function consumeWsTicket(
  redisClient: { getdel: (key: string) => Promise<string | null> },
  ticket: string,
  /** The upgrade request: with org hosts, its host must be the one the ticket was minted on. */
  req?: Request,
): Promise<TicketPayload | null> {
  const raw = await redisClient.getdel(`ws-ticket:${ticket}`)
  if (!raw) return null

  const payload = parseTicketPayload(raw)
  if (!payload) return null
  // Host binding (lib/org-host.ts): a ticket opens a socket only on the host it
  // was minted on, and only if that host serves the ticket's org.
  if (hostBindingEnabled()) {
    if (!req) return null
    const host = effectiveRequestFromRaw(req, null).host
    if (!payload.host || payload.host !== host) return null
    if (!(await bindingAllowsOrg(rawRequestHostBinding(req, null), payload.orgId))) return null
  }
  // A ticket minted just before its session ended opens nothing.
  if (payload.sid && isSessionRevoked(payload.sid)) return null

  const isCurrent = await isUserAuthCurrent(
    {
      userId: payload.userId,
      orgId: payload.orgId,
      authVersion: payload.authVersion,
      permissionVersion: payload.permissionVersion,
    },
    { forceFresh: true },
  )

  if (!isCurrent) return null
  // An org whose deletion has started opens no socket (S2.5), even with a
  // ticket minted before the mark.
  if (await isOrgDeletingAsync(payload.orgId)) return null
  return payload
}

export async function isWsAuthStillValid(params: {
  userId: string
  orgId: string
  authVersion?: number
  permissionVersion?: number
}): Promise<boolean> {
  if (!(await isUserAuthCurrent(params, { forceFresh: true }))) return false
  // An open socket of an org being deleted fails its next revalidation and is
  // closed (lib/server.ts).
  return !(await isOrgDeletingAsync(params.orgId))
}
