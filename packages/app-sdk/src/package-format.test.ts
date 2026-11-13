// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { AppSettingsSchema } from "./app-settings"
import {
  appRegistryEntrySchema,
  LIAISON_APP_VERSION,
  ManifestValidationError,
  packageManifestSchema,
  REQUIRED_FILES,
  validateManifest,
} from "./package-format"

describe("package-format", () => {
  it("exports a stable major version for the .liaisonapp format", () => {
    expect(LIAISON_APP_VERSION).toBe(1)
  })

  it("lists required files for a valid .liaisonapp tarball", () => {
    expect(REQUIRED_FILES).toEqual(["app.manifest.json", "bundle.js"])
  })

  it("validates a minimal manifest", () => {
    const ok = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: ["my-app:items:read"],
    })
    expect(ok.success).toBe(true)
  })

  it("rejects manifest with missing name", () => {
    const bad = packageManifestSchema.safeParse({ version: "1.0.0", packageFormat: 1 })
    expect(bad.success).toBe(false)
  })

  it("rejects manifest with missing license (installed apps must declare one)", () => {
    const bad = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      scopes: [],
    })
    expect(bad.success).toBe(false)
  })

  it("accepts a manifest with no sdkVersion or minLiaisonVersion (the host range replaces them)", () => {
    const ok = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      host: "^1",
    })
    expect(ok.success).toBe(true)
  })

  it("still parses an older package that carries sdkVersion and minLiaisonVersion", () => {
    const ok = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      sdkVersion: "0.1.0",
      minLiaisonVersion: "v0.1.0",
    })
    expect(ok.success).toBe(true)
  })

  it("rejects an empty host range", () => {
    const bad = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      host: "",
    })
    expect(bad.success).toBe(false)
  })

  it("rejects a manifest carrying trusted, true or false: only the platform decides which apps are core", () => {
    for (const trusted of [true, false]) {
      const bad = packageManifestSchema.safeParse({
        name: "my-app",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [],
        trusted,
      })
      expect(bad.success).toBe(false)
      expect(bad.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
        "trusted: trusted is not a manifest field: every package runs sandboxed, and the platform alone decides which apps are core. Remove it.",
      ])
    }
  })

  it("rejects scopes that don't match app:resource:action shape", () => {
    const bad = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: ["bad-scope"],
    })
    expect(bad.success).toBe(false)
  })

  it("accepts an optional updateUrl release-channel pointer", () => {
    const ok = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      updateUrl: "https://apps.example.com/my-app/latest.liaisonapp",
    })
    expect(ok.success).toBe(true)
  })

  it("rejects a non-URL updateUrl", () => {
    const bad = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      updateUrl: "not-a-url",
    })
    expect(bad.success).toBe(false)
  })

  it("rejects an unknown packageFormat version", () => {
    const bad = packageManifestSchema.safeParse({
      name: "my-app",
      version: "1.0.0",
      packageFormat: 2,
      license: "MIT",
      scopes: [],
    })
    expect(bad.success).toBe(false)
  })

  it("appRegistryEntrySchema captures the GET /api/apps response shape (used by CLI + admin UI)", () => {
    const ok = appRegistryEntrySchema.safeParse({
      name: "mail",
      version: "1.0.0",
      source: "in-tree",
      status: "active",
      core: true,
    })
    expect(ok.success).toBe(true)
  })
})

// Phase 17 — manifest validation extensions.
function baseManifest(): Record<string, unknown> {
  return {
    name: "test-app",
    version: "0.1.0",
    packageFormat: 1,
    license: "FSL-1.1-ALv2",
    scopes: [],
  }
}

describe("manifest validation — Phase 17 additions", () => {
  it("accepts pdf_templates[] with kind + source", () => {
    const m = {
      ...baseManifest(),
      capabilities: ["pdf.render"],
      pdf_templates: [{ kind: "test-app:invoice_v1", source: "templates/invoice.ts" }],
    }
    expect(() => validateManifest(m)).not.toThrow()
  })

  it("rejects pdf_templates entry without 'kind'", () => {
    const m = {
      ...baseManifest(),
      capabilities: ["pdf.render"],
      pdf_templates: [{ source: "templates/invoice.ts" }],
    }
    expect(() => validateManifest(m)).toThrow(/pdf_templates/i)
  })

  it("rejects pdf_templates declared without 'pdf.render' capability", () => {
    const m = {
      ...baseManifest(),
      pdf_templates: [{ kind: "x:y", source: "templates/y.ts" }],
    }
    expect(() => validateManifest(m)).toThrow(/pdf\.render.*capability/i)
  })

  it("accepts cross_app_calls[] and synthesizes dependencies.tools", () => {
    const m = {
      ...baseManifest(),
      cross_app_calls: [{ target: "mail:compose", reason: "send PDFs" }],
    }
    const result = validateManifest(m) as { dependencies?: { tools?: string[] } }
    expect(result.dependencies?.tools).toEqual(["mail:compose"])
  })

  it("rejects malformed cross_app_calls target (missing colon)", () => {
    const m = {
      ...baseManifest(),
      cross_app_calls: [{ target: "no-colon-here", reason: "x" }],
    }
    expect(() => validateManifest(m)).toThrow(/cross_app_calls/i)
  })

  it("accepts slots.contact_detail.panels[]", () => {
    const m = {
      ...baseManifest(),
      slots: {
        contact_detail: {
          panels: [
            {
              id: "test-panel",
              label: "Test",
              component: "TestPanel",
              order: 50,
              visibility_scope: "test-app:read",
            },
          ],
        },
      },
    }
    expect(() => validateManifest(m)).not.toThrow()
  })

  it("accepts capabilities as opaque strings (no allowlist — gating is runtime via requireCapability)", () => {
    for (const cap of ["messages.post", "pdf.render", "sequences.allocate", "any.future.string"]) {
      const m = { ...baseManifest(), capabilities: [cap] }
      expect(() => validateManifest(m)).not.toThrow()
    }
  })

  it("rejects cross_app_calls[] that disagrees with explicit dependencies.tools[]", () => {
    const m = {
      ...baseManifest(),
      cross_app_calls: [{ target: "mail:compose", reason: "x" }],
      dependencies: { tools: ["shopify:orders.get"] },
    }
    expect(() => validateManifest(m)).toThrow(/cross_app_calls.*dependencies\.tools.*disagree/i)
  })

  it("accepts cross_app_calls target with dot-segmented tool name (e.g. shopify:orders.get)", () => {
    const m = {
      ...baseManifest(),
      cross_app_calls: [{ target: "shopify:orders.get", reason: "fetch order" }],
    }
    expect(() => validateManifest(m)).not.toThrow()
  })

  it("throws ManifestValidationError (a typed Error) on failure", () => {
    const m = { ...baseManifest(), name: "INVALID_UPPERCASE" }
    expect(() => validateManifest(m)).toThrow(ManifestValidationError)
  })
})

function toolFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    description: "does a thing",
    handler: "fooHandler",
    params: { type: "object", properties: {} },
    ...overrides,
  }
}

describe("manifest validation — tool requiredScopes", () => {
  it("accepts a tool with several requiredScopes", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({ requiredScopes: ["a:b:read", "a:c:write"] }),
      },
    }
    const result = packageManifestSchema.parse(m)
    expect(result.tools?.foo.requiredScopes).toEqual(["a:b:read", "a:c:write"])
  })

  it("refuses a tool that still declares the retired scope key, naming the tool", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({ scope: "a:b:read" }),
      },
    }
    expect(() => validateManifest(m)).toThrow(/tools\.foo\.scope: .*requiredScopes/)
  })

  it("refuses scope even alongside a valid requiredScopes, naming the tool", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({ scope: "a:b:read", requiredScopes: ["a:b:read"] }),
      },
    }
    expect(() => validateManifest(m)).toThrow(/tools\.foo\.scope/)
  })

  it("rejects requiredScopes entries that dont match app:resource:action shape", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({ requiredScopes: ["not a scope"] }),
      },
    }
    expect(() => packageManifestSchema.parse(m)).toThrow()
  })

  it("rejects a tool declaring no requiredScopes", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({}),
      },
    }
    expect(() => packageManifestSchema.parse(m)).toThrow()
  })

  it("rejects a tool with an empty requiredScopes array", () => {
    const m = {
      ...baseManifest(),
      tools: {
        foo: toolFixture({ requiredScopes: [] }),
      },
    }
    expect(() => packageManifestSchema.parse(m)).toThrow()
  })
})

describe("manifest validation: tool scope-taint declarations", () => {
  it("keeps a tool's writesToTable and readOnly through the parse", () => {
    const m = {
      ...baseManifest(),
      tools: {
        writer: toolFixture({ requiredScopes: ["a:b:write"], writesToTable: "app_a.items" }),
        reader: toolFixture({ requiredScopes: ["a:b:read"], readOnly: true }),
      },
    }
    const result = packageManifestSchema.parse(m)
    expect(result.tools?.writer.writesToTable).toBe("app_a.items")
    expect(result.tools?.reader.readOnly).toBe(true)
  })

  it("rejects a writesToTable that is not a schema-qualified table", () => {
    for (const writesToTable of ["items", "App_A.items", "app_a.items.x", ""]) {
      const m = {
        ...baseManifest(),
        tools: { writer: toolFixture({ requiredScopes: ["a:b:write"], writesToTable }) },
      }
      expect(() => packageManifestSchema.parse(m)).toThrow()
    }
  })

  it("rejects a non-boolean readOnly", () => {
    const m = {
      ...baseManifest(),
      tools: { reader: toolFixture({ requiredScopes: ["a:b:read"], readOnly: "yes" }) },
    }
    expect(() => packageManifestSchema.parse(m)).toThrow()
  })
})

// Declarative settings (settings-overhaul P2 T1): a package keeps its `kind`
// and `settings`; a plain z.object would strip both on parse.
describe("package-format kind and settings", () => {
  const base = {
    name: "my-app",
    version: "1.0.0",
    packageFormat: 1,
    license: "MIT",
    scopes: ["my-app:items:read"],
    tools: {
      items_get: { description: "d", handler: "h", requiredScopes: ["my-app:items:read"] },
      items_set: { description: "d", handler: "h", requiredScopes: ["my-app:items:read"] },
    },
  }
  const settings: AppSettingsSchema = {
    sections: [
      {
        id: "general",
        title: "General",
        scope: "org",
        blocks: [
          {
            block: "field",
            key: "sender.name",
            type: "text",
            label: "Sender",
            source: { tool: { get: "items_get", set: "items_set" } },
          },
        ],
      },
    ],
  }

  it("refuses views.settings (removed), naming the settings object instead", () => {
    expect(() =>
      validateManifest({ ...base, views: { settings: [{ id: "x", component: "X", href: "/x" }] } }),
    ).toThrow(/views\.settings: removed/)
  })

  it("keeps kind and settings through the parse", () => {
    const parsed = validateManifest({ ...base, kind: "connector", settings })
    expect(parsed.kind).toBe("connector")
    expect(parsed.settings).toEqual(settings)
  })

  it("rejects settings naming a tool the package does not declare", () => {
    const bad = {
      ...settings,
      sections: [
        {
          ...settings.sections[0],
          blocks: [
            { ...settings.sections[0].blocks[0], source: { tool: { get: "x", set: "items_set" } } },
          ],
        },
      ],
    }
    expect(() => validateManifest({ ...base, settings: bad })).toThrow(
      '"x" is not a tool of this app',
    )
  })

  it("rejects a malformed settings block", () => {
    const r = packageManifestSchema.safeParse({
      ...base,
      settings: { sections: [{ id: "g", title: "G", scope: "org", blocks: [{ block: "field" }] }] },
    })
    expect(r.success).toBe(false)
  })

  it("keeps a list block's archive label, and refuses one without an archive tool", () => {
    const list = (ops: Record<string, string>) => ({
      sections: [
        {
          id: "terms",
          title: "Terms",
          scope: "org",
          blocks: [
            {
              block: "list",
              ops,
              columns: [{ key: "value", label: "Term" }],
              archiveLabel: "Remove",
            },
          ],
        },
      ],
    })
    const ok = validateManifest({
      ...base,
      settings: list({ list: "items_get", archive: "items_set" }),
    })
    expect(JSON.stringify(ok.settings)).toContain('"archiveLabel":"Remove"')
    expect(() => validateManifest({ ...base, settings: list({ list: "items_get" }) })).toThrow(
      "archiveLabel: declared without ops.archive",
    )
  })

  it("rejects a package named after a kernel settings key", () => {
    expect(() => validateManifest({ ...base, name: "integrations", scopes: [] })).toThrow(
      "reserved",
    )
  })
})

describe("package-format icon fields (S1)", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h1"/></svg>'

  it("keeps iconSvg and iconName on a parsed manifest", () => {
    const parsed = validateManifest({ ...baseManifest(), iconSvg: svg, iconName: "gauge" })
    expect(parsed.iconSvg).toBe(svg)
    expect(parsed.iconName).toBe("gauge")
  })

  it("refuses an iconSvg over 8 KB", () => {
    expect(() => validateManifest({ ...baseManifest(), iconSvg: "x".repeat(8193) })).toThrow(
      /iconSvg must be at most 8 KB/,
    )
  })
})
