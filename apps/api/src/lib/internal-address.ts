// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which local address the internal listener uses when the name it would
// advertise resolves onto the sandbox network.
//
// An app process of the compose stack sits on two networks: `internal` (every
// app process, the database, Redis) and `sandbox` (the sandbox service and the
// app processes' bridge-only listeners, nothing else). Inside the container its
// own hostname resolves to one of its two addresses, whichever network Docker
// attached first, while the other app processes may resolve the same name to
// the other one. A listener bound on the sandbox address is refused to every
// peer on the internal network (and the host firewall drops what the sandbox
// network sends it), so the internal listener never takes an address there.

import type { NetworkInterfaceInfo } from "node:os"

/** The 32-bit value of a dotted IPv4 address, or null when it is not one. */
function ipv4Value(address: string): number | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

/** Whether `cidr` is an IPv4 network in CIDR form (`10.73.250.0/24`). */
export function isIpv4Cidr(cidr: string): boolean {
  const [base, bits, ...rest] = cidr.split("/")
  if (rest.length > 0 || base === undefined || bits === undefined) return false
  if (!/^\d{1,2}$/.test(bits) || Number(bits) > 32) return false
  return ipv4Value(base) !== null
}

/** Whether the IPv4 `address` lies inside the IPv4 network `cidr`. False for anything else. */
export function ipv4InCidr(address: string, cidr: string): boolean {
  if (!isIpv4Cidr(cidr)) return false
  const [base = "", bits = "0"] = cidr.split("/")
  const a = ipv4Value(address)
  const b = ipv4Value(base)
  if (a === null || b === null) return false
  const prefix = Number(bits)
  if (prefix === 0) return true
  const size = 2 ** (32 - prefix)
  return Math.floor(a / size) === Math.floor(b / size)
}

/**
 * The first IPv4 address of this machine's non-loopback interfaces that lies
 * outside `avoid` (interfaces taken in name order, so eth0 before eth1), or
 * null when there is none.
 */
export function firstAddressOutside(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  avoid: string,
): string | null {
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      // Node reports the family as "IPv4" (or 4 on some versions).
      const v4 = info.family === "IPv4" || (info.family as unknown) === 4
      if (!v4 || info.internal) continue
      if (!ipv4InCidr(info.address, avoid)) return info.address
    }
  }
  return null
}
