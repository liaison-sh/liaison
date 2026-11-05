// SPDX-License-Identifier: FSL-1.1-ALv2
import { redis } from "~/lib/redis"

// Short-lived OAuth authorization-code store. Binds an issued code to its PKCE
// challenge + the authenticated principal + client. Single-consume via the
// atomic ioredis GETDEL (mirrors the device-flow single-consume discipline).

const AUTH_CODE_TTL_SECONDS = 60

export interface AuthCodeEntry {
  clientId: string
  redirectUri: string
  codeChallenge: string
  userId: string
  orgId: string
  /** Bind the minted connection to this agent. Absent = a legacy connection. */
  agentId?: string
}

function key(code: string): string {
  return `mcp:oauth:authcode:${code}`
}

export async function putAuthCode(code: string, entry: AuthCodeEntry): Promise<void> {
  await redis.set(key(code), JSON.stringify(entry), "EX", AUTH_CODE_TTL_SECONDS)
}

/** Atomically reads and deletes the code. Returns null if absent/expired/replayed. */
export async function consumeAuthCode(code: string): Promise<AuthCodeEntry | null> {
  const raw = await redis.getdel(key(code))
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthCodeEntry
  } catch {
    return null
  }
}
