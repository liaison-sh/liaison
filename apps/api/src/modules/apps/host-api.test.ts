// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10: an app may declare the settings page format it needs
// (`requires.settingsSchema`); a server with an older format refuses it with
// one message that says what to do. The host API range (S3) is checked beside it.
import { describe, expect, it } from "bun:test"
import { SETTINGS_SCHEMA_VERSION } from "@liaison/app-sdk"
import {
  assertSettingsSchemaCompatible,
  settingsSchemaIncompatibility,
} from "~/modules/apps/host-api"

const app = { name: "acme", version: "1.0.0" }

describe("requires.settingsSchema", () => {
  it("accepts an app that declares nothing, or a format this server provides", () => {
    expect(settingsSchemaIncompatibility(app)).toBeNull()
    expect(settingsSchemaIncompatibility({ ...app, requires: {} })).toBeNull()
    expect(settingsSchemaIncompatibility({ ...app, requires: { settingsSchema: 1 } })).toBeNull()
    expect(
      settingsSchemaIncompatibility({
        ...app,
        requires: { settingsSchema: SETTINGS_SCHEMA_VERSION },
      }),
    ).toBeNull()
    expect(() =>
      assertSettingsSchemaCompatible({ ...app, requires: { settingsSchema: 1 } }),
    ).not.toThrow()
  })

  it("refuses an app that needs a newer format, saying both versions", () => {
    const needs = SETTINGS_SCHEMA_VERSION + 1
    const message = `acme 1.0.0 needs settings schema ${needs}; this server provides ${SETTINGS_SCHEMA_VERSION}. Update Liaison first.`
    expect(settingsSchemaIncompatibility({ ...app, requires: { settingsSchema: needs } })).toBe(
      message,
    )
    expect(() =>
      assertSettingsSchemaCompatible({ ...app, requires: { settingsSchema: needs } }),
    ).toThrow(message)
  })
})
