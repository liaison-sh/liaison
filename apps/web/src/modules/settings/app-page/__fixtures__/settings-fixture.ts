// SPDX-License-Identifier: FSL-1.1-ALv2
// Test-only manifest `settings` exercising every block and field type, so the
// renderer's tests do not depend on any real app's migration.
import type { AppSettingsManifest } from "../types"

export const FIXTURE_APP = "fixture"

export const fixtureManifest: AppSettingsManifest = {
  name: FIXTURE_APP,
  displayName: "Fixture",
  version: "1.2.3",
  author: "Liaison",
  kind: "app",
  settings: {
    sections: [
      {
        id: "lead",
        title: "Lead section",
        scope: "org",
        adminScope: "fixture:lead:admin",
        blocks: [{ block: "field", key: "lead.note", type: "text", label: "Lead note" }],
      },
      {
        id: "general",
        title: "General",
        description: "Every field type.",
        scope: "org",
        blocks: [
          { block: "field", key: "f.text", type: "text", label: "Text" },
          { block: "field", key: "f.textarea", type: "textarea", label: "Textarea" },
          { block: "field", key: "f.number", type: "number", label: "Number" },
          { block: "field", key: "f.toggle", type: "toggle", label: "Toggle" },
          {
            block: "field",
            key: "f.select",
            type: "select",
            label: "Select",
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
          },
          {
            block: "field",
            key: "f.multi",
            type: "multiselect",
            label: "Multi",
            optionsTool: "options.list",
          },
          { block: "field", key: "f.url", type: "url", label: "Url" },
          { block: "field", key: "f.email", type: "email", label: "Email" },
          { block: "field", key: "f.date", type: "date", label: "Date" },
          { block: "field", key: "f.dates", type: "dates", label: "Dates" },
          { block: "field", key: "f.duration", type: "duration", label: "Duration" },
          { block: "field", key: "f.schedule", type: "schedule", label: "Schedule" },
          {
            block: "field",
            key: "approve",
            type: "toggle",
            label: "Approve from home",
            source: { tool: { get: "approve.get", set: "approve.set" } },
          },
        ],
      },
      {
        id: "prefs",
        title: "Your preferences",
        scope: "user",
        blocks: [{ block: "field", key: "signature.text", type: "textarea", label: "Signature" }],
      },
      {
        id: "keys",
        title: "API keys",
        scope: "org",
        blocks: [
          {
            block: "list",
            ops: {
              list: "keys.list",
              create: "keys.create",
              archive: "keys.revoke",
              rowAction: [{ label: "Test", tool: "keys.test" }],
            },
            columns: [
              { key: "label", label: "Label" },
              { key: "prefix", label: "Key" },
            ],
            createFields: [{ key: "label", type: "text", label: "Label" }],
            revealOnCreate: "key",
          },
        ],
      },
      {
        id: "categories",
        title: "Categories",
        scope: "org",
        blocks: [
          {
            block: "tree",
            ops: {
              list: "categories.list",
              create: "categories.create",
              update: "categories.update",
              reorder: "categories.reorder",
              archive: "categories.archive",
            },
            maxDepth: 2,
          },
        ],
      },
      {
        id: "accounts",
        title: "Accounts",
        scope: "org",
        blocks: [{ block: "connections" }],
      },
      {
        id: "panel",
        title: "Panel",
        scope: "org",
        blocks: [{ block: "custom", component: "FixturePanel", reason: "test" }],
      },
      {
        // Several fields of ONE whole-object setter: saved as one unit (M1).
        id: "address",
        title: "Ship from",
        scope: "org",
        blocks: (["street", "city", "zip"] as const).map((k) => ({
          block: "field" as const,
          key: `address.${k}`,
          type: "text" as const,
          label: k,
          source: { tool: { get: "address.get", set: "address.set" } },
        })),
      },
    ],
  },
}
