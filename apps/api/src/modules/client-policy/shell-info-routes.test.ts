// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/shell/info: which web builds the server ships (desktop at `/`,
// native under `/native/`), public and never cached, with the operator's
// served-shell switch, which /api/client-policy carries too.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETTINGS_SCHEMA_VERSION } from "@liaison/app-sdk"
import { app } from "~/app"
import { env, envSchema } from "~/lib/env"
import { ShellBuildIdsTestAccess } from "~/lib/web-shell-builds"

describe("GET /api/shell/info", () => {
  let root: string
  const saved = {
    publicDir: process.env.LIAISON_PUBLIC_DIR,
    nativeDir: process.env.LIAISON_PUBLIC_NATIVE_DIR,
    served: env.LIAISON_SERVED_SHELL,
  }
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "liaison-shell-info-"))
    mkdirSync(join(root, "public"))
    mkdirSync(join(root, "public-native"))
    process.env.LIAISON_PUBLIC_DIR = join(root, "public")
    process.env.LIAISON_PUBLIC_NATIVE_DIR = join(root, "public-native")
    ShellBuildIdsTestAccess.reset()
  })

  afterEach(() => {
    restore("LIAISON_PUBLIC_DIR", saved.publicDir)
    restore("LIAISON_PUBLIC_NATIVE_DIR", saved.nativeDir)
    env.LIAISON_SERVED_SHELL = saved.served
    ShellBuildIdsTestAccess.reset()
    rmSync(root, { recursive: true, force: true })
  })

  async function info(): Promise<{ res: Response; data: Record<string, unknown> }> {
    const res = await app.request("/api/shell/info")
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(Object.keys(body)).toEqual(["data"])
    return { res, data: body.data }
  }

  it("answers without a credential, never cached, with both build ids", async () => {
    writeFileSync(join(root, "public", "build-id.txt"), "0123456789abcdef\n")
    writeFileSync(join(root, "public-native", "build-id.txt"), "fedcba9876543210\n")
    const { res, data } = await info()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(data).sort()).toEqual([
      "desktop",
      "liaisonVersion",
      "native",
      "servedShell",
      "settingsSchema",
    ])
    expect(data).toEqual({
      desktop: { buildId: "0123456789abcdef" },
      native: { buildId: "fedcba9876543210" },
      liaisonVersion: env.LIAISON_VERSION,
      settingsSchema: SETTINGS_SCHEMA_VERSION,
      servedShell: true,
    })
  })

  it("native is null when the image ships no native build", async () => {
    writeFileSync(join(root, "public", "build-id.txt"), "0123456789abcdef\n")
    const { data } = await info()
    expect(data.native).toBeNull()
    expect(data.desktop).toEqual({ buildId: "0123456789abcdef" })
  })

  it("the operator's switch turns the served shell off here and in the client policy", async () => {
    env.LIAISON_SERVED_SHELL = false
    expect((await info()).data.servedShell).toBe(false)
    const policy = (await (await app.request("/api/client-policy")).json()) as {
      data: { servedShell: boolean }
    }
    expect(policy.data.servedShell).toBe(false)
  })

  it("LIAISON_SERVED_SHELL defaults to true and parses strictly", () => {
    expect(
      envSchema.parse({ ...process.env, LIAISON_SERVED_SHELL: undefined }).LIAISON_SERVED_SHELL,
    ).toBe(true)
    expect(
      envSchema.parse({ ...process.env, LIAISON_SERVED_SHELL: "false" }).LIAISON_SERVED_SHELL,
    ).toBe(false)
    expect(envSchema.safeParse({ ...process.env, LIAISON_SERVED_SHELL: "maybe" }).success).toBe(
      false,
    )
  })
})
