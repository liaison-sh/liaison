// SPDX-License-Identifier: FSL-1.1-ALv2
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { isPrivateIp } from "~/lib/ip-classify"

function normalizeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Dev-only escape hatch. Allows IMAP/SMTP credentials to point at a private
 *  host (loopback, RFC1918, etc.) when explicitly opted in via env. Required
 *  for local mail QA against tools like Mailpit/Stalwart/GreenMail. Off by
 *  default; production must never set this. */
function isPrivateHostAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false
  return process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true"
}

export async function validateExternalHost(
  host: string,
  protocol: "IMAP" | "SMTP",
): Promise<{ host: string; address: string; family: 4 | 6; servername?: string }> {
  const normalizedHost = normalizeHost(host)
  if (!normalizedHost) {
    throw new Error(`${protocol} host is required`)
  }

  const allowPrivate = isPrivateHostAllowed()
  if (!allowPrivate && isPrivateIp(normalizedHost)) {
    throw new Error(`${protocol} host must not point to a private network`)
  }

  if (isIP(normalizedHost)) {
    return { host: normalizedHost, address: normalizedHost, family: isIP(normalizedHost) as 4 | 6 }
  }

  const resolved = await lookup(normalizedHost, { all: true })
  if (resolved.length === 0) {
    throw new Error(`${protocol} host could not be resolved`)
  }
  if (!allowPrivate && resolved.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(`${protocol} host must not resolve to a private network`)
  }
  const first = resolved[0]
  return {
    host: normalizedHost,
    address: first.address,
    family: first.family as 4 | 6,
    servername: normalizedHost,
  }
}
