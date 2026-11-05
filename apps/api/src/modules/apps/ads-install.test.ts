// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HOST-SIDE install gate for the ads bundled app.
//
// The bundled-app suite only validates the ads manifest against the
// PERMISSIVE app-sdk `packageManifestSchema` (which passthrough-strips tools,
// routines, events and only spot-checks connections). That blind spot let a
// manifest ship that the REAL host registration path rejects — at install,
// `runtime.ts` calls `validateAppManifest` from `contract.ts`, and `continue`s
// (does NOT register) on failure, so the app silently fails to install while
// the bundled suite reports green.
//
// This test runs the REAL `validateAppManifest` against the real
// `bundled-apps/ads/app.manifest.json` so an install-blocking manifest
// error fails CI here. This is allowed host-side — purity only forbids the
// *bundled app* importing apps/api, never a host test reading the manifest.
//
// `validateAppManifest` (and its transitive imports: zod, ajv, manifest-schema)
// does NOT import the env validator, so this test needs no JWT_SECRET /
// ENCRYPTION_KEY injection.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"

const MANIFEST_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "ads",
  "app.manifest.json",
)

const BARREL_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "ads",
  "src",
  "ui",
  "index.tsx",
)

function loadManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>
}

describe("ads install gate — real validateAppManifest", () => {
  it("the real ads manifest validates cleanly (it would register at install)", () => {
    const result = validateAppManifest(loadManifest())
    if (!result.success) {
      // Surface the exact rejection so a regression names the failing field.
      console.error("validateAppManifest rejected ads manifest:", result.error)
    }
    expect(result.success).toBe(true)
  })

  // ── Targeted pins for the four install-blocking categories (C1–C4) ──────────

  it("C1: connections.meta.credentialFields use `name` (not `key`)", () => {
    const m = loadManifest() as {
      connections: Record<string, { credentialFields?: Array<Record<string, unknown>> }>
    }
    const fields = m.connections?.meta?.credentialFields ?? []
    expect(fields.length).toBeGreaterThan(0)
    for (const f of fields) {
      expect(typeof f.name, `credentialField must have 'name': ${JSON.stringify(f)}`).toBe("string")
      expect("key" in f, "credentialField must NOT use 'key'").toBe(false)
    }
  })

  it("C2: connections.meta.setupGuide is an OBJECT with a summary", () => {
    const m = loadManifest() as {
      connections: Record<string, { setupGuide?: unknown }>
    }
    const guide = m.connections?.meta?.setupGuide
    expect(typeof guide).toBe("object")
    expect(guide).not.toBeNull()
    expect(typeof (guide as { summary?: unknown }).summary).toBe("string")
  })

  it("C3: every routine description is <= 200 chars", () => {
    const m = loadManifest() as { routines?: Record<string, { description?: string }> }
    for (const [name, routine] of Object.entries(m.routines ?? {})) {
      const desc = routine.description ?? ""
      expect(
        desc.length,
        `routine '${name}' description is ${desc.length} chars (max 200)`,
      ).toBeLessThanOrEqual(200)
    }
  })

  it("C4: budget text-widget editableFields have a string-typed param", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        {
          params?: { properties?: Record<string, { type?: string }> }
          editableFields?: Array<{ field: string; widget: string }>
        }
      >
    }
    for (const [toolName, tool] of Object.entries(m.tools)) {
      for (const ef of tool.editableFields ?? []) {
        if (ef.widget === "text" || ef.widget === "richtext") {
          const paramType = tool.params?.properties?.[ef.field]?.type
          expect(
            paramType,
            `${toolName}.editableFields field '${ef.field}' widget '${ef.widget}' requires params.properties.${ef.field}.type === 'string'`,
          ).toBe("string")
        }
      }
    }
  })
})

// ── Views block assertions (Task 9 — barrel export + manifest consistency) ─────
//
// Static source-grep approach: read barrel source as a string and assert each
// views component name appears as an export. Does NOT import the barrel (that
// would pull in Solid JSX + @liaison/host window reads, unavailable in bun:test).

describe("ads views — barrel exports every manifest component", () => {
  const barrelSource = readFileSync(BARREL_PATH, "utf8")

  it("views.activityBar.icon appears as an export in the barrel", () => {
    const m = loadManifest() as { views?: { activityBar?: { icon?: string } } }
    const icon = m.views?.activityBar?.icon
    expect(typeof icon).toBe("string")
    expect(barrelSource).toContain(icon!)
  })

  it("views.tabTypes components all appear as exports in the barrel", () => {
    const m = loadManifest() as { views?: { tabTypes?: Record<string, { component?: string }> } }
    for (const [tabKey, tab] of Object.entries(m.views?.tabTypes ?? {})) {
      expect(typeof tab.component, `tabTypes.${tabKey}.component must be a string`).toBe("string")
      expect(
        barrelSource,
        `barrel must export '${tab.component}' (tabTypes.${tabKey}.component)`,
      ).toContain(tab.component!)
    }
  })

  it("views.detail components all appear as exports in the barrel", () => {
    const m = loadManifest() as { views?: { detail?: Record<string, { component?: string }> } }
    for (const [entityKey, detail] of Object.entries(m.views?.detail ?? {})) {
      expect(typeof detail.component, `detail.${entityKey}.component must be a string`).toBe(
        "string",
      )
      expect(
        barrelSource,
        `barrel must export '${detail.component}' (detail.${entityKey}.component)`,
      ).toContain(detail.component!)
    }
  })

  it("views.settings components all appear as exports in the barrel", () => {
    const m = loadManifest() as {
      views?: { settings?: Array<{ component?: string; id?: string }> }
    }
    for (const entry of m.views?.settings ?? []) {
      expect(typeof entry.component, `settings entry ${entry.id} component must be a string`).toBe(
        "string",
      )
      expect(
        barrelSource,
        `barrel must export '${entry.component}' (settings.${entry.id}.component)`,
      ).toContain(entry.component!)
    }
  })

  it("views block passes validateAppManifest (structural check)", () => {
    // This overlaps the main validate test but makes the views-specifically failing case explicit.
    const result = validateAppManifest(loadManifest())
    expect(result.success).toBe(true)
  })
})
