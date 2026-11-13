// SPDX-License-Identifier: FSL-1.1-ALv2
// `settingsfx`: a test-only app declaring a declarative settings page with
// every field source (settings, config, tool), a user section, an org section
// with its own adminScope, one without (kernel:apps:admin by default) and a
// gated tool-backed field. Registered per test org with `registerApps`.

export const SETTINGS_FX_APP = "settingsfx"

export const settingsFixtureManifest = {
  name: SETTINGS_FX_APP,
  version: "1.0.0",
  kind: "app",
  description: "Declarative settings fixture",
  displayName: "Settings fixture",
  license: "MIT",
  listing: {
    publisher: "Fixture Works",
    category: "Productivity",
    icon: "settings",
    summary: "A test-only app with a declarative settings page.",
    sourceRepository: "https://example.invalid/settingsfx",
  },
  roles: {
    admin: {
      description: "Administers the fixture's limits",
      scopes: ["settingsfx:limits:admin", "settingsfx:remote:read", "settingsfx:remote:write"],
    },
  },
  tools: {
    "remote.get": {
      description: "Read the remote settings object",
      requiredScopes: ["settingsfx:remote:read"],
      handler: "settingsFxRemoteGet",
      readOnly: true,
      params: { type: "object", properties: {} },
    },
    "remote.set": {
      description: "Store the remote settings object",
      requiredScopes: ["settingsfx:remote:write"],
      handler: "settingsFxRemoteSet",
      params: { type: "object", additionalProperties: true },
    },
    "remote.setGated": {
      description: "Store the remote settings object after approval",
      requiredScopes: ["settingsfx:remote:write"],
      handler: "settingsFxRemoteSetGated",
      gated: true,
      params: { type: "object", additionalProperties: true },
    },
    "address.setGated": {
      description: "Store the whole address object after approval",
      requiredScopes: ["settingsfx:remote:write"],
      handler: "settingsFxAddressSetGated",
      gated: true,
      params: { type: "object", additionalProperties: true },
    },
  },
  configKeys: [{ key: "dashboardUrl", type: "url" }],
  settings: {
    sections: [
      {
        id: "prefs",
        title: "Your preferences",
        scope: "user",
        blocks: [
          { block: "field", key: "signature.text", type: "textarea", label: "Signature" },
          { block: "field", key: "digest.enabled", type: "toggle", label: "Digest", default: true },
        ],
      },
      {
        id: "limits",
        title: "Limits",
        scope: "org",
        adminScope: "settingsfx:limits:admin",
        blocks: [
          {
            block: "field",
            key: "limits.max",
            type: "number",
            label: "Maximum",
            validation: { min: 1, max: 100 },
          },
          { block: "field", key: "limits.label", type: "text", label: "Label" },
          { block: "field", key: "deep.level.leaf", type: "text", label: "Leaf" },
          { block: "field", key: "hours.weekly", type: "schedule", label: "Hours" },
          { block: "field", key: "hours.holidays", type: "dates", label: "Holidays" },
          {
            block: "field",
            key: "dashboardUrl",
            type: "url",
            label: "Dashboard",
            source: "config",
          },
        ],
      },
      {
        id: "general",
        title: "General",
        scope: "org",
        blocks: [{ block: "field", key: "greeting", type: "text", label: "Greeting" }],
      },
      {
        id: "remote",
        title: "Remote",
        scope: "org",
        adminScope: "settingsfx:limits:admin",
        blocks: [
          {
            block: "field",
            key: "remote.mode",
            type: "select",
            label: "Mode",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
            source: { tool: { get: "remote.get", set: "remote.set" } },
          },
          {
            block: "field",
            key: "remote.gated",
            type: "toggle",
            label: "Gated",
            source: { tool: { get: "remote.get", set: "remote.setGated" } },
          },
        ],
      },
      {
        // Several fields of ONE gated whole-object setter: saved as one unit (M1).
        id: "address",
        title: "Address",
        scope: "org",
        adminScope: "settingsfx:limits:admin",
        blocks: (["street", "city", "zip"] as const).map((k) => ({
          block: "field" as const,
          key: `address.${k}`,
          type: "text" as const,
          label: k,
          source: { tool: { get: "remote.get", set: "address.setGated" } },
        })),
      },
    ],
  },
}

/** The descriptor `registerApps` takes (handlers run in the sandbox from handlers.ts). */
export const settingsFixtureApp = {
  ...settingsFixtureManifest,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}
