// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Check a published shell statement the way a client will: fetch
// `shell/<mode>/<buildId>/statement.{json,sig}` from the downloads host,
// verify it against the pinned keys (packages/shared/src/app-signing/keys.json)
// and the shell floors (the compiled one, and the signed revocation list when
// the host has one), and check it names the mode and build id asked for.
//
// Usage:
//   bun scripts/shell-signing/verify-statement.ts <desktop|native> <buildId>
//     [--base https://downloads.liaison.sh]
// Prints `ok`, or the reason, and exits non-zero on anything but ok.
import { utf8 } from "../../packages/shared/src/app-signing/encoding"
import { APP_SIGNING_KEYS, type AppSigningKey } from "../../packages/shared/src/app-signing/keys"
import {
  type RevocationList,
  verifyRevocationList,
} from "../../packages/shared/src/app-signing/revocations"
import {
  isShellMode,
  type ShellMode,
  verifyShellStatementFor,
} from "../../packages/shared/src/app-signing/shell-statement"

export const DEFAULT_DOWNLOADS_BASE = "https://downloads.liaison.sh"

export interface VerifyPublishedInput {
  mode: ShellMode
  buildId: string
  base?: string
  keys?: readonly AppSigningKey[]
  fetch?: typeof fetch
}

async function get(f: typeof fetch, url: string): Promise<Uint8Array | null | "error"> {
  try {
    const res = await f(url, { redirect: "error", headers: { "Cache-Control": "no-cache" } })
    if (res.status === 404) return null
    if (!res.ok) return "error"
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return "error"
  }
}

/** `ok`, or why the published statement must not be trusted. */
export async function verifyPublishedShell(input: VerifyPublishedInput): Promise<string> {
  if (!/^[0-9a-f]{16}$/.test(input.buildId)) return "not a build id"
  const base = (input.base ?? DEFAULT_DOWNLOADS_BASE).replace(/\/+$/, "")
  const f = input.fetch ?? fetch
  const keys = input.keys ?? APP_SIGNING_KEYS
  const prefix = `${base}/shell/${input.mode}/${input.buildId}`
  const statement = await get(f, `${prefix}/statement.json`)
  const sig = await get(f, `${prefix}/statement.sig`)
  if (statement === null || sig === null) return "not published"
  if (statement === "error" || sig === "error") return "downloads host unreachable"

  let list: RevocationList | null = null
  const revs = await get(f, `${base}/apps/revocations.json`)
  const revSig = await get(f, `${base}/apps/revocations.json.sig`)
  if (revs === "error" || revSig === "error") return "revocation list unreachable"
  if (revs !== null) {
    if (revSig === null) return "revocation list has no signature"
    const checked = await verifyRevocationList(revs, utf8.decode(revSig), keys)
    if (!checked.ok) return `revocation list: ${checked.reason}`
    list = checked.list
  }

  // Bound to the URL: the statement must name the mode and build id asked for.
  const result = await verifyShellStatementFor(
    { mode: input.mode, buildId: input.buildId },
    statement,
    utf8.decode(sig),
    keys,
    { list },
  )
  return result.ok ? "ok" : result.reason
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const [mode, buildId] = args
  const i = args.indexOf("--base")
  if (!isShellMode(mode) || !buildId) {
    console.error("usage: verify-statement.ts <desktop|native> <buildId> [--base <url>]")
    process.exit(2)
  }
  const verdict = await verifyPublishedShell({
    mode,
    buildId,
    base: i >= 0 ? args[i + 1] : undefined,
  })
  console.log(verdict)
  process.exit(verdict === "ok" ? 0 : 1)
}
