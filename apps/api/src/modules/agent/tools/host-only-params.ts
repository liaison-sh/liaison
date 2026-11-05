// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-only tool parameters: the `__mailbox*` arguments a tool's SECOND call carries after the
// two-phase mailbox protocol (mailbox-plaintext-broker.ts): message ids the owner's browser
// matched, a quote it decrypted, the readable bytes of a sealed attachment. The server trusts
// them as "read from the user's own encrypted mailbox", so they must come from the bridge's retry
// (or an approval's fulfilment) only, never from a model or an MCP client: a prompt-injected
// model could otherwise hand the tool bytes of its choosing under that label.
//
// They stay in the tool's declared parameters, so the retry validates, but are left out of the
// schema a model or an MCP client is shown (tool-bridge.ts `providerInputSchemaOf`) and are
// stripped from every argument object that comes from one, before the tool runs.

/** True for a parameter only the host may set. */
export function isHostOnlyParam(name: string): boolean {
  return name.startsWith("__mailbox")
}

/** The arguments without host-only parameters. Returns the same reference when there are none. */
export function stripHostOnlyParams<T>(args: T): T {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  if (!Object.keys(record).some(isHostOnlyParam)) return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!isHostOnlyParam(key)) out[key] = value
  }
  return out as T
}
