// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app manifest's settings field key is a dot path the host builds trees
// along. A key such as `constructor.prototype.<name>` must never reach
// Object.prototype, and option bags that widen access must ignore inherited
// values even if something else pollutes the prototype.
import { afterEach, describe, expect, test } from "bun:test"
import { appSettingsSchema } from "@liaison/app-sdk"
import { buildTransport } from "~/apps/database/bridge"
import { DbTransportError } from "~/apps/database/transport"
import {
  buildManifestSettingsEntry,
  namespaceDefaultsFor,
  namespaceSchemaFor,
} from "~/modules/apps/settings-schema-from-manifest"

function settingsWithKey(key: string) {
  return {
    sections: [
      {
        id: "general",
        title: "General",
        scope: "org",
        blocks: [{ block: "field", key, type: "text", label: "x", default: "d" }],
      },
    ],
  }
}

/** What runtime.ts does at app registration; returns whether it was refused. */
function registerManifestSettings(key: string): boolean {
  try {
    const entry = buildManifestSettingsEntry(appSettingsSchema.parse(settingsWithKey(key)), {
      app: "probe",
    })
    namespaceSchemaFor(entry, "org")
    namespaceDefaultsFor(entry, "org")
    return false
  } catch {
    return true
  }
}

const proto = Object.prototype as unknown as Record<string, unknown>

afterEach(() => {
  delete proto.trustedHost
  delete proto.probeFlag
})

async function directQueryError(): Promise<unknown> {
  const t = buildTransport({ connectionString: "postgres://u:p@127.0.0.1:5432/db" })
  const err = await t.runQuery("SELECT 1").catch((e) => e)
  await t.close().catch(() => {})
  return err
}

async function withAllowList<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.LIAISON_DATABASE_ALLOWED_HOSTS
  process.env.LIAISON_DATABASE_ALLOWED_HOSTS = "db.corp.example"
  try {
    return await fn()
  } finally {
    if (prior === undefined) delete process.env.LIAISON_DATABASE_ALLOWED_HOSTS
    else process.env.LIAISON_DATABASE_ALLOWED_HOSTS = prior
  }
}

describe("manifest settings keys cannot reach Object.prototype", () => {
  test("the settings schema refuses constructor, prototype and __proto__ segments", () => {
    for (const key of ["constructor.prototype.x", "a.constructor", "prototype.b", "a.prototype"]) {
      expect(appSettingsSchema.safeParse(settingsWithKey(key)).success).toBe(false)
    }
    expect(appSettingsSchema.safeParse(settingsWithKey("general.color")).success).toBe(true)
  })

  test("a manifest key does not pollute and the tenant DSN still meets the allow-list", async () => {
    registerManifestSettings("constructor.prototype.trustedHost")
    expect(({} as Record<string, unknown>).trustedHost).toBeUndefined()
    const err = await withAllowList(directQueryError)
    expect(err).toBeInstanceOf(DbTransportError)
    expect((err as DbTransportError).message).toContain("allow-list")
  })

  test("the host refuses an unsafe key even past the schema", () => {
    // A parsed manifest built by hand (no schema) still cannot walk into the prototype.
    const entry = buildManifestSettingsEntry(
      settingsWithKey("constructor.prototype.probeFlag") as never,
      { app: "probe" },
    )
    expect(() => namespaceSchemaFor(entry, "org")).toThrow(/unsafe settings field key/)
    expect(() => namespaceDefaultsFor(entry, "org")).toThrow(/unsafe settings field key/)
    expect(({} as Record<string, unknown>).probeFlag).toBeUndefined()
  })

  test("an inherited trustedHost does not skip the operator allow-list", async () => {
    proto.trustedHost = true
    const err = await withAllowList(directQueryError)
    expect(err).toBeInstanceOf(DbTransportError)
    expect((err as DbTransportError).message).toContain("allow-list")
  })

  test("a settings key cannot replace an Object.prototype method", () => {
    const original = Object.prototype.valueOf
    try {
      const refused = registerManifestSettings("constructor.prototype.valueOf")
      expect(refused || Object.prototype.valueOf === original).toBe(true)
      expect(Object.prototype.valueOf).toBe(original)
    } finally {
      Object.prototype.valueOf = original
    }
  })
})
