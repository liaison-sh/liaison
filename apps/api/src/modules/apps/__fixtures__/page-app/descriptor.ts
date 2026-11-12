// SPDX-License-Identifier: FSL-1.1-ALv2
// `pagefx`: a test-only SANDBOXED app (trusted: false) with a page and the route
// it calls, a tool that mints a link to the page (`ctx.pages.link`), declarative
// provisioning, and two oauth2 connections sharing one client key. Registered
// per test org with `registerApps`.

export const PAGE_FX_APP = "pagefx"

export const pageFixtureManifest = {
  name: PAGE_FX_APP,
  version: "1.0.0",
  trusted: false,
  kind: "app",
  description: "App pages, routes and provisioning fixture",
  displayName: "Page fixture",
  license: "MIT",
  listing: {
    publisher: "Fixture Works",
    category: "Productivity",
    icon: "settings",
    summary: "A test-only app with a page, a route and provisioning.",
    sourceRepository: "https://example.invalid/pagefx",
  },
  roles: {
    user: {
      description: "Uses the fixture's page",
      scopes: ["pagefx:items:read", "pagefx:items:write"],
    },
  },
  tools: {
    "page.link": {
      description: "A link to the hello page",
      requiredScopes: ["pagefx:items:read"],
      handler: "pageLink",
      readOnly: true,
      params: { type: "object", properties: { tag: { type: "string" } } },
    },
  },
  pages: {
    hello: {
      source: "pages/hello.ts",
      title: "Hello page",
      scope: "pagefx:items:read",
      routes: ["greet"],
      hosts: { script: ["apis.example.com"], frame: ["docs.example.com"] },
    },
  },
  pageRoutes: {
    greet: { handler: "greetRoute", scope: "pagefx:items:write" },
  },
  provisioning: {
    schema: {
      type: "object",
      properties: {
        greeting: { type: "string", minLength: 1 },
        folders: { type: "array", items: { type: "string" } },
      },
      required: ["greeting"],
      additionalProperties: false,
    },
    handler: "provision",
    verify: "verifySetup",
  },
  connections: {
    primary: {
      type: "oauth2",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      allowedDomains: ["api.example.com"],
      scopes: ["read"],
      oauthClient: { key: "pagefx:shared" },
    },
    secondary: {
      type: "oauth2",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      allowedDomains: ["api.example.com"],
      scopes: ["write"],
      oauthClient: { key: "pagefx:shared" },
    },
  },
}

export const pageFixtureApp = {
  ...pageFixtureManifest,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
}
