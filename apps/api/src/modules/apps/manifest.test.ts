// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"

describe("validateAppManifest", () => {
  it("accepts a valid minimal manifest", () => {
    const result = validateAppManifest({ name: "test", version: "1.0.0" })
    expect(result.success).toBe(true)
  })

  it("accepts a full manifest with all fields", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      description: "A test app",
      agentInstructions: "Help users with items",
      dependencies: { required: ["contacts"], optional: ["search"] },
      schema: {
        items: {
          fields: {
            title: "string",
            status: "string",
            priority: { type: "integer", required: false },
          },
          dimensions: {
            team: { type: "membership" },
            sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
          },
          timeline: ["status"],
          searchable: ["title"],
        },
      },
      tools: {
        listItems: {
          description: "List items",
          params: { type: "object", properties: { status: { type: "string" } } },
          requiredScopes: ["test:items:read"],
          handler: "listItems",
        },
        createItem: {
          description: "Create an item",
          params: {
            type: "object",
            properties: { title: { type: "string" }, team: { type: "string" } },
            required: ["title", "team"],
          },
          requiredScopes: ["test:items:write"],
          handler: "createItem",
          taintSource: true,
        },
        riskyAction: {
          description: "A gated action",
          params: { type: "object", properties: { itemId: { type: "string" } } },
          requiredScopes: ["test:items:write"],
          handler: "riskyAction",
          gated: true,
        },
      },
      events: {
        emits: ["items:created", "items:updated"],
        subscribes: { "items:created": "onItemCreated" },
      },
      jobs: {
        processItems: {
          schedule: "0/5 * * * *",
          handler: "processItemsBatch",
          retry: { attempts: 2, backoff: "exponential" },
        },
      },
      webhooks: {
        "test-hook": { handler: "handleTestWebhook", verify: "verifyTestSignature" },
      },
      webhookHealth: { probe: null, reason: "test fixture" },
      entities: {
        items: {
          labelField: "title",
          handlePrefix: "item",
          searchable: true,
          tableName: "items",
          readScope: "test:items:read",
        },
      },
      // `skills.overview` was removed pre-launch (see contract.ts:244); the
      // descriptor now uses top-level `agentInstructions` for kernel-level
      // overview text and `skills` becomes a map of named skill entries.
      // Leaving as an empty map exercises the post-migration shape without
      // requiring a fully-populated skill payload.
      skills: {},
      export: { formats: ["json"], handler: "exportItems" },
      connections: {
        gitlab: {
          type: "oauth2",
          authorizationUrl: "https://gitlab.com/oauth/authorize",
          tokenUrl: "https://gitlab.com/oauth/token",
          scopes: ["read_api"],
          allowedDomains: ["gitlab.com", "*.gitlab.com"],
        },
      },
      network: { allowedDomains: ["api.example.com"] },
      views: {
        tabTypes: {
          list: {
            component: "ItemList",
            icon: "ItemIcon",
            singleton: true,
            urlPattern: "/test",
          },
        },
        activityBar: { icon: "TestIcon", label: "Test", order: 50 },
        panels: { detail: { component: "DetailPanel", label: "Detail" } },
      },
      slots: { "item:detail:actions": { position: "toolbar" } },
      contributions: { "test:detail:tabs": { label: "Contrib", component: "ContribPanel" } },
    })
    expect(result.success).toBe(true)
  })

  it("rejects missing name", () => {
    const result = validateAppManifest({ version: "1.0.0" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects missing version", () => {
    const result = validateAppManifest({ name: "test" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("version")
  })

  it("rejects invalid name format", () => {
    const result = validateAppManifest({ name: "Test App!", version: "1.0.0" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects invalid semver", () => {
    const result = validateAppManifest({ name: "test", version: "abc" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("version")
  })

  it("rejects tool handler that is a function instead of string", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Bad",
          requiredScopes: ["test:items:read"],
          handler: () => {},
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("handler")
  })

  it("rejects tool scope not prefixed with app name", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Bad scope",
          requiredScopes: ["other:items:read"],
          handler: "myTool",
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('must start with "test:"')
  })

  it("rejects timeline field not in fields", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      schema: {
        items: {
          fields: { title: "string" },
          timeline: ["nonexistent"],
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("nonexistent")
  })

  it("rejects level dimension without order", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      schema: {
        items: {
          fields: { status: "string" },
          dimensions: { status: { type: "level" } },
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("order")
  })

  it("rejects invalid cron expression in job schedule", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      jobs: { bad: { schedule: "not a cron", handler: "badHandler" } },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("cron")
  })

  it("rejects event subscriber that is a function instead of string", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      events: { subscribes: { "items:created": () => {} } },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("subscriber")
  })

  it("accepts connection with credential fields", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      connections: {
        imap: {
          type: "credentials",
          credentialFields: [
            { name: "host", label: "Host", type: "text" },
            { name: "password", label: "Password", type: "password" },
          ],
          allowedDomains: ["*.example.com"],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it("rejects connection without allowedDomains", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      connections: {
        gitlab: {
          type: "oauth2",
          authorizationUrl: "https://x.com/auth",
          tokenUrl: "https://x.com/token",
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("allowedDomains")
  })

  it("accepts views.wsHandlers as Record<string, string>", () => {
    const result = validateAppManifest({
      name: "mail",
      version: "1.0.0",
      views: {
        wsHandlers: { conversation: "handleConversationEvent", message: "handleMessageEvent" },
      },
    })
    expect(result.success).toBe(true)
  })

  it("rejects views.wsHandlers with non-string handler value", () => {
    const result = validateAppManifest({
      name: "mail",
      version: "1.0.0",
      views: {
        wsHandlers: { conversation: 42 },
      },
    })
    expect(result.success).toBe(false)
  })

  // P2 T12: `views.settings` (an app's own settings pages) is gone; an app declares ONE
  // declarative page with the manifest `settings` object.
  it("refuses views.settings and names its replacement", () => {
    const result = validateAppManifest({
      name: "mail",
      version: "1.0.0",
      views: {
        settings: [
          { label: "Email Accounts", href: "/settings/mail/accounts", group: "app", order: 0 },
        ],
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("views.settings")
    expect(result.error).toContain('"settings"')
  })

  it("rejects a role declaration missing a description", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      roles: {
        support: { scopes: ["test:items:read"] },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("description")
  })

  it("rejects a role declaration with an empty description", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      roles: {
        support: { description: "", scopes: ["test:items:read"] },
      },
    })
    expect(result.success).toBe(false)
  })

  it("accepts a role declaration with a non-empty description", () => {
    const result = validateAppManifest({
      name: "test",
      version: "1.0.0",
      roles: {
        support: {
          description: "Standard support agent",
          scopes: ["test:items:read"],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  describe("manifest capabilities field", () => {
    it("accepts a valid capabilities array", () => {
      const result = validateAppManifest({
        name: "test",
        version: "1.0.0",
        capabilities: ["agent.run", "realtime.publish"],
      })
      expect(result.success).toBe(true)
    })

    it("accepts a manifest with no capabilities key", () => {
      const result = validateAppManifest({ name: "test", version: "1.0.0" })
      expect(result.success).toBe(true)
    })

    it("rejects unknown capability values", () => {
      const result = validateAppManifest({
        name: "test",
        version: "1.0.0",
        capabilities: ["agent.run", "agent.delete_universe"],
      })
      expect(result.success).toBe(false)
    })

    it("rejects duplicate capability entries", () => {
      const result = validateAppManifest({
        name: "test",
        version: "1.0.0",
        capabilities: ["agent.run", "agent.run"],
      })
      expect(result.success).toBe(false)
    })
  })

  describe("manifest network.allowPrivateHostsInTest", () => {
    it("accepts allowPrivateHostsInTest: true", () => {
      const result = validateAppManifest({
        name: "test",
        version: "1.0.0",
        network: { allowedDomains: ["127.0.0.1"], allowPrivateHostsInTest: true },
      })
      expect(result.success).toBe(true)
    })

    it("rejects non-boolean allowPrivateHostsInTest", () => {
      const result = validateAppManifest({
        name: "test",
        version: "1.0.0",
        network: { allowedDomains: ["example.com"], allowPrivateHostsInTest: "yes" },
      })
      expect(result.success).toBe(false)
    })
  })
})

// Declarative settings (S9, A8, A19, A21; settings-overhaul P2 T1). One
// `settings` object per app, rendered by the kernel as the app's settings page.
describe("manifest kind and settings", () => {
  /** A manifest exercising every block kind and every field source. */
  function fullSettingsManifest(): Record<string, any> {
    const tool = (scope: string) => ({
      description: "t",
      requiredScopes: [scope],
      handler: "h",
    })
    return {
      name: "demoapp",
      version: "1.0.0",
      kind: "app",
      tools: {
        "categories.list": tool("demoapp:categories:read"),
        "categories.create": tool("demoapp:categories:admin"),
        "categories.update": tool("demoapp:categories:admin"),
        "categories.reorder": tool("demoapp:categories:admin"),
        "categories.archive": tool("demoapp:categories:admin"),
        "keys.list": tool("demoapp:settings:admin"),
        "keys.create": tool("demoapp:settings:admin"),
        "keys.revoke": tool("demoapp:settings:admin"),
        "keys.rotate": tool("demoapp:settings:admin"),
        "approve.get": tool("demoapp:settings:admin"),
        "approve.set": tool("demoapp:settings:admin"),
        "providers.options": tool("demoapp:settings:admin"),
      },
      connections: {
        gmail: {
          type: "credentials",
          credentialFields: [{ name: "host", label: "Host", type: "text" }],
          allowedDomains: ["*.example.com"],
        },
      },
      configKeys: [{ key: "dashboardUrl", type: "url" }],
      settings: {
        sections: [
          {
            id: "signature",
            title: "Your signature",
            titleKey: "demoapp.settings.signature",
            scope: "user",
            blocks: [
              { block: "field", key: "signature.text", type: "textarea", label: "Signature" },
            ],
          },
          {
            id: "inboxes",
            title: "Inboxes",
            scope: "org",
            adminScope: "demoapp:settings:admin",
            blocks: [
              { block: "connections", names: ["gmail"] },
              { block: "custom", component: "InboxRouting", reason: "per-row rich editor" },
            ],
          },
          {
            id: "categories",
            title: "Categories",
            scope: "org",
            adminScope: "demoapp:categories:admin",
            blocks: [
              {
                block: "tree",
                maxDepth: 2,
                ops: {
                  list: "categories.list",
                  create: "categories.create",
                  update: "categories.update",
                  reorder: "categories.reorder",
                  archive: "categories.archive",
                },
              },
            ],
          },
          {
            id: "response-times",
            title: "Response times",
            scope: "org",
            blocks: [
              {
                block: "field",
                key: "sla.targets.low",
                type: "duration",
                label: "Low",
                validation: { min: 60, max: 864000, required: true },
              },
              { block: "field", key: "sla.businessHours.weekly", type: "schedule", label: "Hours" },
              {
                block: "field",
                key: "sla.businessHours.holidays",
                type: "dates",
                label: "Holidays",
              },
              {
                block: "field",
                key: "emailTemplate.accentColor",
                type: "text",
                label: "Accent",
                validation: { pattern: "^#[0-9a-fA-F]{6}$" },
              },
              {
                block: "field",
                key: "timezone",
                type: "select",
                label: "Time zone",
                options: [{ value: "UTC", label: "UTC" }],
                default: "UTC",
              },
              {
                block: "field",
                key: "provider",
                type: "select",
                label: "Provider",
                optionsTool: "providers.options",
              },
              {
                block: "field",
                key: "approveRepliesFromHome",
                type: "toggle",
                label: "Approve from home",
                source: { tool: { get: "approve.get", set: "approve.set" } },
              },
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
            id: "api-keys",
            title: "API keys",
            scope: "org",
            adminScope: "kernel:apps:admin",
            blocks: [
              {
                block: "list",
                ops: {
                  list: "keys.list",
                  create: "keys.create",
                  archive: "keys.revoke",
                  rowAction: [{ label: "Rotate", tool: "keys.rotate" }],
                },
                columns: [{ key: "label", label: "Label" }],
                createFields: [{ key: "label", type: "text", label: "Label" }],
                revealOnCreate: "key",
              },
            ],
          },
        ],
      },
    }
  }

  function withSettings(mutate: (m: Record<string, any>) => void): Record<string, any> {
    const m = fullSettingsManifest()
    mutate(m)
    return m
  }

  it("accepts a manifest using every block kind and field source", () => {
    const result = validateAppManifest(fullSettingsManifest())
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
  })

  it("accepts kind connector without workspace views", () => {
    const result = validateAppManifest({ name: "gitconn", version: "1.0.0", kind: "connector" })
    expect(result.success).toBe(true)
  })

  it("rejects an unknown kind", () => {
    const result = validateAppManifest({ name: "x", version: "1.0.0", kind: "widget" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("/kind")
  })

  it.each(["activityBar", "tabTypes"])("rejects a connector that declares views.%s", (view) => {
    const result = validateAppManifest({
      name: "gitconn",
      version: "1.0.0",
      kind: "connector",
      views: { [view]: {} },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain(`views.${view}: a connector has no workspace view`)
  })

  it("rejects duplicate section ids", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].id = "signature"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('duplicate section id "signature"')
  })

  it("rejects an unknown block kind", () => {
    const m = withSettings((m) => {
      m.settings.sections[0].blocks.push({ block: "chart", key: "x" })
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("settings.sections.0.blocks.1")
  })

  it("rejects a field type outside the declared set", () => {
    const m = withSettings((m) => {
      m.settings.sections[0].blocks[0].type = "richtext"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("settings.sections.0.blocks.0.type")
  })

  it.each([
    [
      "a list op",
      (m: Record<string, any>) => (m.settings.sections[4].blocks[0].ops.list = "keys.nope"),
      "ops.list",
    ],
    [
      "a list row action",
      (m: Record<string, any>) =>
        (m.settings.sections[4].blocks[0].ops.rowAction[0].tool = "keys.nope"),
      "rowAction[0].tool",
    ],
    [
      "a tree op",
      (m: Record<string, any>) => (m.settings.sections[2].blocks[0].ops.reorder = "keys.nope"),
      "ops.reorder",
    ],
    [
      "a field tool source",
      (m: Record<string, any>) => (m.settings.sections[3].blocks[6].source.tool.set = "keys.nope"),
      "source.tool.set",
    ],
    [
      "a field optionsTool",
      (m: Record<string, any>) => (m.settings.sections[3].blocks[5].optionsTool = "keys.nope"),
      "optionsTool",
    ],
  ])("rejects %s naming a tool the app does not declare", (_label, mutate, where) => {
    const result = validateAppManifest(withSettings(mutate))
    expect(result.success).toBe(false)
    expect(result.error).toContain(where)
    expect(result.error).toContain('"keys.nope" is not a tool of this app')
  })

  it("rejects a custom block without a reason", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].blocks[1].reason = "  "
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("a custom block states why no declarative block fits")
  })

  it("rejects a config field whose key is not a declared configKey", () => {
    const m = withSettings((m) => {
      m.configKeys = [{ key: "otherUrl", type: "url" }]
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('"dashboardUrl" is not declared in configKeys')
  })

  it("rejects a config field in a user section", () => {
    const m = withSettings((m) => {
      m.settings.sections[0].blocks.push({
        block: "field",
        key: "dashboardUrl",
        type: "url",
        label: "Dashboard",
        source: "config",
      })
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('a "config" field belongs in an org section')
  })

  it("rejects an adminScope that is neither an app scope nor a kernel scope", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].adminScope = "otherapp:settings:admin"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain(
      '"otherapp:settings:admin" is neither a scope of this app nor a kernel scope',
    )
  })

  it("accepts a kernel scope as adminScope", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].adminScope = "kernel:org:admin"
    })
    expect(validateAppManifest(m).success).toBe(true)
  })

  it("rejects an adminScope on a user section", () => {
    const m = withSettings((m) => {
      m.settings.sections[0].adminScope = "kernel:apps:admin"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("only an org section has an admin scope")
  })

  it("rejects a field key that names secret material", () => {
    const m = withSettings((m) => {
      m.settings.sections[3].blocks[0].key = "provider.apiKey"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("names secret material")
  })

  it("rejects two settings fields that write the same path", () => {
    const m = withSettings((m) => {
      m.settings.sections[3].blocks.push({
        block: "field",
        key: "sla.targets",
        type: "text",
        label: "x",
      })
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('"sla.targets" overlaps "sla.targets.low"')
  })

  it("rejects a connections block naming an undeclared connection", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].blocks[0].names = ["imap"]
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('"imap" is not a declared connection')
  })

  // A connector's card says whether its connection works: the connections
  // block names the read tool that checks it (settings overhaul P2 T10).
  it("accepts a connections block naming a status tool of the app", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].blocks[0].status = {
        tool: "keys.list",
        params: { limit: 1 },
      }
    })
    const result = validateAppManifest(m)
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
  })

  it("rejects a connections status tool the app does not declare", () => {
    const m = withSettings((m) => {
      m.settings.sections[1].blocks[0].status = { tool: "probe" }
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('status.tool: "probe" is not a tool of this app')
  })

  it("rejects an approval-gated connections status tool (a status read must answer at once)", () => {
    const m = withSettings((m) => {
      m.tools["keys.list"].gated = true
      m.settings.sections[1].blocks[0].status = { tool: "keys.list" }
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain('status.tool: "keys.list" is approval-gated')
  })

  it("rejects a select field without options", () => {
    const m = withSettings((m) => {
      delete m.settings.sections[3].blocks[4].options
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("a select field declares options or optionsTool")
  })

  it("rejects a default that does not fit the field type", () => {
    const m = withSettings((m) => {
      m.settings.sections[3].blocks[0].default = "soon"
    })
    const result = validateAppManifest(m)
    expect(result.success).toBe(false)
    expect(result.error).toContain("settings.sections[3].blocks[0].default")
  })

  it.each(["integrations", "ai", "email", "kernel"])(
    "rejects an app named %s, a kernel-owned settings key",
    (name) => {
      const result = validateAppManifest({ name, version: "1.0.0" })
      expect(result.success).toBe(false)
      expect(result.error).toContain(`"${name}" is reserved`)
    },
  )
})
