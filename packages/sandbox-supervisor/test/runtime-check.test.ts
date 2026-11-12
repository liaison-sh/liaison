// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { checkContainerRuntime } from "../src/runtime-check"

describe("the container runtime check", () => {
  it("passes gVisor, and a supervisor run directly (no runtime named)", () => {
    expect(checkContainerRuntime({ SANDBOX_RUNTIME: "runsc" })).toEqual({ kind: "ok" })
    expect(checkContainerRuntime({})).toEqual({ kind: "ok" })
  })

  it("refuses another runtime unless the opt-out is set, then warns", () => {
    expect(checkContainerRuntime({ SANDBOX_RUNTIME: "runc" }).kind).toBe("refuse")
    expect(
      checkContainerRuntime({ SANDBOX_RUNTIME: "runc", SANDBOX_ALLOW_NO_GVISOR: "true" }).kind,
    ).toBe("refuse")
    const warn = checkContainerRuntime({ SANDBOX_RUNTIME: "runc", SANDBOX_ALLOW_NO_GVISOR: "1" })
    expect(warn.kind).toBe("warn")
    expect(warn.kind === "warn" && warn.message).toMatch(/INSECURE/)
  })
})
