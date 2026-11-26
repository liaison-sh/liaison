// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { NetworkInterfaceInfo } from "node:os"
import { firstAddressOutside, ipv4InCidr, isIpv4Cidr } from "~/lib/internal-address"

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "02:42:ac:12:00:09",
    internal,
    cidr: `${address}/24`,
  }
}

function v6(address: string): NetworkInterfaceInfo {
  return { ...v4(address), family: "IPv6", scopeid: 0, cidr: `${address}/64` }
}

describe("internal listener address on a host with a sandbox network", () => {
  it("reads IPv4 CIDR networks", () => {
    expect(isIpv4Cidr("10.73.250.0/24")).toBe(true)
    expect(isIpv4Cidr("0.0.0.0/0")).toBe(true)
    expect(isIpv4Cidr("10.73.250.0")).toBe(false)
    expect(isIpv4Cidr("10.73.250.0/33")).toBe(false)
    expect(isIpv4Cidr("10.73.256.0/24")).toBe(false)
    expect(isIpv4Cidr("fd00::/8")).toBe(false)
    expect(ipv4InCidr("10.73.250.2", "10.73.250.0/24")).toBe(true)
    expect(ipv4InCidr("10.73.251.2", "10.73.250.0/24")).toBe(false)
    expect(ipv4InCidr("172.18.0.9", "10.73.250.0/24")).toBe(false)
    expect(ipv4InCidr("172.18.0.9", "0.0.0.0/0")).toBe(true)
    expect(ipv4InCidr("fe80::1", "10.73.250.0/24")).toBe(false)
  })

  it("a worker on both networks takes its internal-network address, never the sandbox one", () => {
    // The order Docker attached the networks in: sandbox first, as on the
    // container whose hostname resolved to its sandbox address.
    const interfaces = {
      lo: [v4("127.0.0.1", true)],
      eth0: [v4("10.73.250.2")],
      eth1: [v4("172.18.0.9"), v6("fe80::42")],
    }
    expect(firstAddressOutside(interfaces, "10.73.250.0/24")).toBe("172.18.0.9")
  })

  it("none when the sandbox network is the only one", () => {
    const interfaces = { lo: [v4("127.0.0.1", true)], eth0: [v4("10.73.250.2")] }
    expect(firstAddressOutside(interfaces, "10.73.250.0/24")).toBeNull()
  })
})
