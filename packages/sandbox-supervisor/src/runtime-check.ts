// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The container runtime the service was started under, as the compose file
// says it (SANDBOX_RUNTIME, the same value as the service's `runtime:`).
// gVisor (`runsc`) is the boundary between a tenant's code and the host's
// kernel: production declares it, so Docker refuses to start the service on
// a host without gVisor. A host that cannot run gVisor may opt out, loudly:
// SANDBOX_RUNTIME=runc alone refuses to start; with
// SANDBOX_ALLOW_NO_GVISOR=1 it starts and warns at boot and every hour.
// Unset (development, CI: the supervisor run directly, no container): no check.

export type RuntimeCheck =
  | { kind: "ok" }
  | { kind: "refuse"; message: string }
  | { kind: "warn"; message: string }

export function checkContainerRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeCheck {
  const runtime = (env.SANDBOX_RUNTIME ?? "").trim()
  if (runtime === "" || runtime === "runsc") return { kind: "ok" }
  if (env.SANDBOX_ALLOW_NO_GVISOR !== "1") {
    return {
      kind: "refuse",
      message:
        `The sandbox service runs under "${runtime}", not gVisor (runsc): refusing to start. ` +
        "Install gVisor (docs/self-hosting/sandbox.md), or accept running tenants' app code " +
        "with only a container between it and the host kernel by setting " +
        "LIAISON_SANDBOX_ALLOW_NO_GVISOR=1.",
    }
  }
  return {
    kind: "warn",
    message:
      `INSECURE: the sandbox service runs under "${runtime}", not gVisor (runsc). App code ` +
      "is separated from the host kernel by a container only (LIAISON_SANDBOX_ALLOW_NO_GVISOR=1). " +
      "Install gVisor and remove the opt-out (docs/self-hosting/sandbox.md).",
  }
}
