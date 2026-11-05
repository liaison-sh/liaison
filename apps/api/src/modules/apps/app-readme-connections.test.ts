// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Closed-world oracle: an app's README must not contradict its manifest about
 * which connections it owns.
 *
 * Why this exists. The tickets README stated, in bold, that Tickets has "no
 * `connections` block in its manifest" and pointed the reader at the *mail*
 * app — while the manifest declared `gmail` and `imap`. Someone followed it and
 * connected `mail/gmail` for a ticket desk. That failure is silent: the OAuth
 * succeeds, the account reads `active`, and no ticket ever arrives, because
 * `ticketsOnAccountConnected` is gated on `appName === "tickets"`. Hours are
 * lost looking at sync code when the doc was simply wrong.
 *
 * A prose bug caused it, so prose is what gets pinned. Two rules:
 *
 *  1. An app that DECLARES connections must not claim it has none, and must
 *     name each one — so a reader can find the right `<app>/<connection>` ref.
 *  2. A connection NAME declared by more than one app (today: `gmail`) is the
 *     dangerous case, because both consent screens look identical. Each such
 *     README must disambiguate — name a sibling app or point at the section
 *     that does.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// apps/api/src/modules/apps → ../../../../.. = liaison/
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const APPS_DIR = join(REPO_ROOT, "apps", "api", "src", "apps")

interface AppEntry {
  name: string
  connections: string[]
  readme: string | null
}

function loadApps(): AppEntry[] {
  const out: AppEntry[] = []
  for (const name of readdirSync(APPS_DIR)) {
    const manifestPath = join(APPS_DIR, name, "app.manifest.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      connections?: Record<string, unknown>
    }
    const connections = Object.keys(manifest.connections ?? {})
    if (connections.length === 0) continue
    const readmePath = join(APPS_DIR, name, "README.md")
    out.push({
      name,
      connections,
      readme: existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null,
    })
  }
  return out
}

/**
 * In-tree fixture apps that exist to exercise the app contract, not to be
 * connected by anyone. Their connections are stubs, so a name they happen to
 * share with a real app is not a trap a human can fall into.
 */
const FIXTURE_APPS = new Set(["test", "test-bridge-a", "test-bridge-b", "example", "chaos-debug"])

const APPS = loadApps()
const REAL_APPS = APPS.filter((a) => !FIXTURE_APPS.has(a.name))

/** Phrasings that assert the app owns NO connection. Fatal when it owns some. */
const DENIALS = [
  /no\s+`?connections`?\s+block/i,
  /no\s+kernel\s+connection\s+is\s+required/i,
  /declares\s+no\s+connections/i,
]

describe("app README ↔ manifest connection agreement", () => {
  it("finds apps to check (guards against a broken glob silently passing)", () => {
    expect(APPS.length).toBeGreaterThan(0)
    // The regression that motivated this oracle.
    expect(APPS.find((a) => a.name === "tickets")?.connections).toContain("gmail")
  })

  for (const app of APPS) {
    it(`${app.name}: has a README (it declares ${app.connections.join(", ")})`, () => {
      expect(app.readme, `apps/api/src/apps/${app.name}/README.md is missing`).not.toBeNull()
    })

    it(`${app.name}: README does not deny owning connections`, () => {
      if (!app.readme) return
      for (const denial of DENIALS) {
        expect(
          denial.test(app.readme),
          `apps/api/src/apps/${app.name}/README.md claims it has no connections, but its manifest declares: ${app.connections.join(", ")}`,
        ).toBe(false)
      }
    })

    it(`${app.name}: README names every connection it declares`, () => {
      if (!app.readme) return
      for (const conn of app.connections) {
        expect(
          app.readme.includes(conn),
          `apps/api/src/apps/${app.name}/README.md never mentions its \`${conn}\` connection — a reader cannot learn the ${app.name}/${conn} ref`,
        ).toBe(true)
      }
    })
  }
})

describe("shared connection names must be disambiguated", () => {
  // name → apps declaring it. Fixture apps are excluded: a stub connection
  // sharing a name is not a trap anyone can walk into.
  const byConnection = new Map<string, string[]>()
  for (const app of REAL_APPS) {
    for (const conn of app.connections) {
      byConnection.set(conn, [...(byConnection.get(conn) ?? []), app.name])
    }
  }
  const shared = [...byConnection.entries()].filter(([, apps]) => apps.length > 1)

  it("still detects at least one shared connection name (else this suite is inert)", () => {
    // If this ever legitimately drops to zero, delete the suite rather than
    // letting it pass vacuously forever.
    expect(shared.length).toBeGreaterThan(0)
  })

  for (const [conn, owners] of shared) {
    for (const owner of owners) {
      const others = owners.filter((o) => o !== owner)
      it(`${owner}/${conn}: README warns it is not ${others.map((o) => `${o}/${conn}`).join(" or ")}`, () => {
        const readme = APPS.find((a) => a.name === owner)?.readme
        expect(readme).not.toBeNull()
        if (!readme) return
        // Either it names a sibling app explicitly, or it points at the
        // cross-app section that enumerates them.
        const namesSibling = others.some((o) => readme.includes(`${o}/${conn}`))
        const pointsAtGuide = /connecting-apps\.md/.test(readme)
        expect(
          namesSibling && pointsAtGuide,
          `apps/api/src/apps/${owner}/README.md must say that \`${conn}\` is ALSO declared by ${others.join(", ")} ` +
            `(name the '${others[0]}/${conn}' ref) and link docs/connecting-apps.md — connecting the wrong one fails silently`,
        ).toBe(true)
      })
    }
  }
})

describe("the cross-app section that both READMEs point at", () => {
  const guide = readFileSync(join(REPO_ROOT, "docs", "connecting-apps.md"), "utf8")

  it("enumerates the apps that share a provider, and says the failure is silent", () => {
    expect(guide).toContain("tickets/gmail")
    expect(guide).toContain("mail/gmail")
    // The whole point: it succeeds and does nothing. A reader who only skims
    // must still get that.
    expect(guide.toLowerCase()).toContain("silent")
  })
})
