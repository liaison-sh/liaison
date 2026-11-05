// SPDX-License-Identifier: FSL-1.1-ALv2
// Snapshot test for the rendered digest email body. The fixture file at
// `__fixtures__/daily-digest.html` is git-tracked — any change to the template
// shows up as a reviewable diff. To intentionally update after a redesign:
//
//   UPDATE_EMAIL_FIXTURES=1 bun test apps/api/src/modules/attention/digest-snapshot.test.ts
//
// then visually open the file in a browser and inspect the changes.
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { type PendingAttentionRow, renderDigestEmail } from "./digest"

const FIXTURE_DIR = path.join(__dirname, "__fixtures__")
const HTML_FIXTURE = path.join(FIXTURE_DIR, "daily-digest.html")
const TEXT_FIXTURE = path.join(FIXTURE_DIR, "daily-digest.txt")
const SUBJECT_FIXTURE = path.join(FIXTURE_DIR, "daily-digest.subject.txt")

const NOW = new Date("2026-05-13T08:05:00Z")
const ORG = "00000000-0000-0000-0000-000000000111"
const USER = "00000000-0000-0000-0000-000000000aaa"

function row(over: Partial<PendingAttentionRow>): PendingAttentionRow {
  return {
    id: "r-x",
    orgId: ORG,
    userId: USER,
    app: "kernel",
    entityType: "thread",
    entityId: "t1",
    kind: "thread_reply",
    urgency: 30,
    summary: "summary",
    isUrgent: false,
    occurredAt: new Date("2026-05-13T07:00:00Z"),
    ...over,
  }
}

// A representative digest covering every AttentionKind plus a payload with
// characters that exercise HTML escaping. Keep this fixture stable: changes
// here will rewrite three checked-in fixture files.
const FIXTURE_ROWS: PendingAttentionRow[] = [
  row({
    id: "r-1",
    kind: "mention",
    summary: 'Alice mentioned you in "Sprint Planning"',
    occurredAt: new Date("2026-05-13T07:54:00Z"),
    entityId: "thread-sprint-planning",
  }),
  row({
    id: "r-2",
    kind: "thread_reply",
    summary: "Bob replied: looks good, shipping after standup",
    occurredAt: new Date("2026-05-13T06:30:00Z"),
    entityId: "thread-sprint-planning",
  }),
  row({
    id: "r-3",
    kind: "approval_decision",
    summary: "Your spend request was approved by Taylor",
    occurredAt: new Date("2026-05-13T03:15:00Z"),
    app: "kernel",
    entityType: "approval_request",
    entityId: "ar-091",
  }),
  row({
    id: "r-4",
    kind: "system_alert",
    summary: "Search reindex failed — manual investigation needed <urgent>",
    occurredAt: new Date("2026-05-12T22:00:00Z"),
    isUrgent: true,
    urgency: 85,
    entityType: "alert",
    entityId: "a-77",
  }),
  row({
    id: "r-5",
    kind: "file_shared",
    summary: "Diana attached Q2-roadmap.pdf to #Sprint Planning",
    occurredAt: new Date("2026-05-11T16:20:00Z"),
    app: "tickets",
    entityType: "ticket",
    entityId: "T-413",
  }),
]

function readOrWrite(target: string, value: string): string {
  if (process.env.UPDATE_EMAIL_FIXTURES === "1") {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true })
    fs.writeFileSync(target, value)
    return value
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true })
    fs.writeFileSync(target, value)
    return value
  }
  return fs.readFileSync(target, "utf8")
}

describe("renderDigestEmail — snapshot", () => {
  const message = renderDigestEmail({
    rows: FIXTURE_ROWS,
    baseUrl: "https://app.liaison.sh",
    now: NOW,
    toAddress: "admin@example.com",
  })

  it("HTML body matches checked-in fixture", () => {
    const expected = readOrWrite(HTML_FIXTURE, message.html)
    expect(message.html).toBe(expected)
  })

  it("text body matches checked-in fixture", () => {
    const expected = readOrWrite(TEXT_FIXTURE, message.text ?? "")
    expect(message.text).toBe(expected)
  })

  it("subject matches checked-in fixture", () => {
    const expected = readOrWrite(SUBJECT_FIXTURE, `${message.subject}\n`)
    expect(`${message.subject}\n`).toBe(expected)
  })
})

describe("renderDigestEmail — structural guarantees", () => {
  const message = renderDigestEmail({
    rows: FIXTURE_ROWS,
    baseUrl: "https://app.liaison.sh",
    now: NOW,
    toAddress: "u@example.com",
  })

  it("is a complete HTML document, not a fragment", () => {
    expect(message.html.startsWith("<!doctype html>")).toBe(true)
    expect(message.html).toContain("<html")
    expect(message.html).toContain("</html>")
    expect(message.html).toContain('<meta name="color-scheme" content="light dark">')
  })

  it("uses tables for layout (Outlook/Gmail compatibility)", () => {
    // No flex/grid escapees should leak into the template.
    expect(message.html).not.toMatch(/display:\s*flex/i)
    expect(message.html).not.toMatch(/display:\s*grid/i)
    expect(message.html).toContain('role="presentation"')
  })

  it("ships a dark-mode override block", () => {
    expect(message.html).toContain("@media (prefers-color-scheme: dark)")
  })

  it("has no external assets (no <img>, no remote stylesheet, no webfont)", () => {
    expect(message.html).not.toMatch(/<img\b/i)
    expect(message.html).not.toMatch(/<link\b[^>]*stylesheet/i)
    expect(message.html).not.toMatch(/@import/)
    expect(message.html).not.toMatch(/https?:\/\/fonts\./)
  })

  it("escapes HTML in summaries", () => {
    // r-4's summary contains "<urgent>" — should be escaped.
    expect(message.html).not.toContain("<urgent>")
    expect(message.html).toContain("&lt;urgent&gt;")
  })

  it("renders one row per pending attention event", () => {
    // Five `Open →` CTAs from row blocks plus one wrapper "Open Liaison →".
    const matches = message.html.match(/Open\s+&rarr;/g) ?? []
    expect(matches.length).toBe(FIXTURE_ROWS.length)
    // The wrapper CTA uses the same arrow but a different label.
    expect(message.html).toContain("Open Liaison &rarr;")
  })

  it("includes a deep link per row", () => {
    expect(message.html).toContain("https://app.liaison.sh/threads/thread-sprint-planning")
    expect(message.html).toContain("https://app.liaison.sh/approvals/ar-091")
    expect(message.html).toContain("https://app.liaison.sh/tickets/T-413")
  })

  it("includes a footer link back to attention preferences", () => {
    expect(message.html).toContain("https://app.liaison.sh/settings/notifications")
  })

  it("uses tabular labels per kind", () => {
    expect(message.html).toContain(">mention<")
    expect(message.html).toContain(">reply<")
    expect(message.html).toContain(">approval<")
    expect(message.html).toContain(">alert<")
    expect(message.html).toContain(">file<")
  })

  it("text body includes every row + the management footer", () => {
    for (const r of FIXTURE_ROWS) {
      expect(message.text).toContain(r.summary.replace(/<[^>]+>/g, ""))
    }
    expect(message.text).toContain("Manage attention preferences:")
  })

  it("throws on empty rows (callers must filter)", () => {
    expect(() =>
      renderDigestEmail({
        rows: [],
        baseUrl: "https://app.liaison.sh",
        now: NOW,
        toAddress: "u@example.com",
      }),
    ).toThrow(/zero rows/)
  })

  it("subject pluralizes correctly", () => {
    const single = renderDigestEmail({
      rows: [FIXTURE_ROWS[0]],
      baseUrl: "https://app.liaison.sh",
      now: NOW,
      toAddress: "u@example.com",
    })
    expect(single.subject).toBe("1 thing needs your attention")
    expect(message.subject).toBe("5 things need your attention")
  })
})
