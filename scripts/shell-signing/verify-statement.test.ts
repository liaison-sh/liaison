// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { utf8 } from "../../packages/shared/src/app-signing/encoding"
import {
  type ShellStatement,
  shellStatementBytes,
} from "../../packages/shared/src/app-signing/shell-statement"
import { createTestSigningKey } from "../../packages/shared/src/app-signing/testing"
import { verifyPublishedShell } from "./verify-statement"

const BUILD = "0123456789abcdef"

async function host(buildIdInStatement: string) {
  const signer = await createTestSigningKey("k1")
  const statement: ShellStatement = {
    v: 1,
    kind: "shell",
    keyId: "k1",
    mode: "desktop",
    buildId: buildIdInStatement,
    commit: "a".repeat(40),
    seq: 1_764_300_000,
    liaisonVersion: "nightly-20261128",
    bridge: { desktop: "^1", ios: "^1", android: "^1" },
    settingsSchema: 1,
    files: { "index.html": "b".repeat(64) },
    issuedAt: "2026-11-28T00:00:00.000Z",
  }
  const bytes = shellStatementBytes(statement)
  const sig = utf8.encode(await signer.sign(bytes))
  const files: Record<string, Uint8Array> = {
    [`/shell/desktop/${BUILD}/statement.json`]: bytes,
    [`/shell/desktop/${BUILD}/statement.sig`]: sig,
  }
  const fetchStub = (async (url: string | URL | Request) => {
    const body = files[new URL(String(url)).pathname]
    return body ? new Response(body) : new Response("", { status: 404 })
  }) as typeof fetch
  return { keys: [signer.key], fetch: fetchStub, base: "https://downloads.test" }
}

describe("verifyPublishedShell", () => {
  it("accepts the statement published for the build asked for", async () => {
    const h = await host(BUILD)
    expect(await verifyPublishedShell({ mode: "desktop", buildId: BUILD, ...h })).toBe("ok")
  })

  it("refuses a validly signed statement for another build served at the asked path", async () => {
    const h = await host("fedcba9876543210")
    expect(await verifyPublishedShell({ mode: "desktop", buildId: BUILD, ...h })).toBe(
      "wrong_build",
    )
  })

  it("says not published when the host has no statement for that mode", async () => {
    const h = await host(BUILD)
    expect(await verifyPublishedShell({ mode: "native", buildId: BUILD, ...h })).toBe(
      "not published",
    )
  })
})
