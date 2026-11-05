// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The committed recording (D3): every event is a valid node session event of
// the shared protocol, with the payload its type carries; tool results answer
// earlier tool calls; and nothing in it could be private: no home path, no
// key or token shape, no address outside the reserved `.example` domain, no
// IPv4 outside the documentation ranges. A machine's own names (account,
// host) are checked from `LIAISON_SCRUB_DENYLIST` (comma separated) when set,
// so no real value has to be committed here.
import { describe, expect, it } from "bun:test"
import { type NODE_SESSION_EVENT_TYPES, nodeSessionEventInSchema } from "@liaison/shared"
import { z } from "zod"
import recordingJson from "./recording.json"
import { RECORDING, recordingSchema } from "./replay"

const payloads: Partial<Record<(typeof NODE_SESSION_EVENT_TYPES)[number], z.ZodType>> = {
  user_message: z.object({ text: z.string().min(1) }).strict(),
  assistant_text: z.object({ text: z.string().min(1) }).strict(),
  thinking: z.object({ text: z.string().min(1) }).strict(),
  tool_call: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()),
    })
    .strict(),
  tool_result: z
    .object({ id: z.string().min(1), isError: z.boolean(), output: z.string() })
    .strict(),
  todo: z
    .object({
      from: z.enum(["TodoWrite", "Task"]),
      items: z.array(
        z
          .object({ content: z.string(), status: z.string(), activeForm: z.string().optional() })
          .strict(),
      ),
    })
    .strict(),
  permission_request: z
    .object({
      requestId: z.string().min(1),
      tool: z.string().min(1),
      input: z.record(z.string(), z.unknown()),
      reason: z.string(),
    })
    .strict(),
  usage: z
    .object({
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      model: z.string(),
      cacheRead: z.number().int().nonnegative().optional(),
    })
    .strict(),
  result: z
    .object({
      text: z.string().min(1),
      isError: z.boolean(),
      subtype: z.string(),
      branch: z.string().optional(),
      pushed: z.boolean().optional(),
      prUrl: z.url({ protocol: /^https$/ }).optional(),
    })
    .strict(),
  system: z
    .object({
      subtype: z.string(),
      text: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
}

/** Types a recording never carries: the server (or the replay's decision step) writes them. */
const SERVER_ONLY = new Set([
  "status",
  "decision",
  "command_applied",
  "model_changed",
  "level_changed",
])

const all = [...RECORDING.events, ...RECORDING.denied]

describe("the recorded session", () => {
  it("parses, holds at most 200 events and exactly one permission request", () => {
    expect(recordingSchema.safeParse(recordingJson).success).toBe(true)
    expect(all.length).toBeLessThanOrEqual(200)
    expect(RECORDING.events.filter((e) => e.type === "permission_request")).toHaveLength(1)
  })

  it("every event is a protocol event with its type's payload", () => {
    for (const [i, e] of all.entries()) {
      const wire = { at: new Date().toISOString(), type: e.type, payload: e.payload }
      expect({ i, ok: nodeSessionEventInSchema.safeParse(wire).success }).toEqual({ i, ok: true })
      expect(SERVER_ONLY.has(e.type)).toBe(false)
      const schema = payloads[e.type]
      expect({ i, type: e.type, known: schema !== undefined }).toEqual({
        i,
        type: e.type,
        known: true,
      })
      const parsed = schema?.safeParse(e.payload)
      expect({ i, type: e.type, error: parsed?.success ? null : parsed?.error.message }).toEqual({
        i,
        type: e.type,
        error: null,
      })
    }
  })

  it("every tool result answers an earlier tool call, and the Allow path ends with the pull request", () => {
    for (const path of [RECORDING.events, RECORDING.denied]) {
      const called = new Set<unknown>()
      for (const e of path) {
        if (e.type === "tool_call") called.add(e.payload.id)
        if (e.type === "tool_result") expect(called.has(e.payload.id)).toBe(true)
      }
    }
    const last = RECORDING.events.at(-1)
    expect(last?.type).toBe("result")
    expect(last?.payload.prUrl).toMatch(/^https:\/\/[a-z0-9.-]+\.example\//)
    expect(RECORDING.denied.at(-1)?.payload.pushed).toBe(false)
  })

  it("carries nothing private", () => {
    const text = JSON.stringify(recordingJson)
    const patterns: Array<[string, RegExp]> = [
      ["macOS home", /\/Users\//],
      ["Linux home", /\/home\//],
      ["Windows drive", /[A-Za-z]:\\\\/],
      ["tilde home", /~\//],
      ["node credential", /lnn_/],
      ["API key", /sk-|sk_live|sk_test/],
      ["GitHub token", /ghp_|gho_|github_pat_/],
      ["Slack token", /xox[bpas]-/],
      ["AWS key", /AKIA[0-9A-Z]{8,}/],
      ["private key", /-----BEGIN/],
      ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
    ]
    for (const [what, re] of patterns)
      expect({ what, found: re.test(text) }).toEqual({ what, found: false })

    for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      expect(email).toMatch(/@([a-z0-9-]+\.)*example$/i)
    }
    for (const url of text.match(/https?:\/\/[^\s"\\)]+/g) ?? []) {
      expect(new URL(url).hostname).toMatch(/(^|\.)example$/)
    }
    const documentation = [/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./]
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
      expect({ ip, documentation: documentation.some((re) => re.test(ip)) }).toEqual({
        ip,
        documentation: true,
      })
    }
    const denylist = (process.env.LIAISON_SCRUB_DENYLIST ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 3)
    const lower = text.toLowerCase()
    for (const name of denylist)
      expect({ name, found: lower.includes(name) }).toEqual({ name, found: false })
  })
})
