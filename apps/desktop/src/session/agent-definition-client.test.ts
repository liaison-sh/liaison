// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AgentDefinitionForbiddenError,
  AgentDefinitionRequestError,
  composeAgentDefinitionText,
  fetchAgentDefinition,
  LOCAL_TOOL_PREFIX,
  SKILLS_PREAMBLE,
  TOOLS_PREAMBLE,
} from "./agent-definition-client"

const DEFINITION = {
  systemPrompt: "you are an agent",
  skillIndex: [],
  scopedMemory: [],
  mcpToolList: [],
}

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const OPTIONS = { serverAddress: "https://acme.example.com", accessToken: "tok1" }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchAgentDefinition", () => {
  it("calls the composition route on the named server with the bearer", async () => {
    const fetchMock = mockFetch(200, { data: DEFINITION })
    await fetchAgentDefinition("agent-1", OPTIONS)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe("https://acme.example.com/api/agents/agent-1/definition")
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer tok1")
  })

  it("names the session's room, so the server bounds the definition by its floor", async () => {
    const fetchMock = mockFetch(200, { data: DEFINITION })
    await fetchAgentDefinition("agent-1", { ...OPTIONS, threadId: "thread-9" })
    const [url] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toBe(
      "https://acme.example.com/api/agents/agent-1/definition?threadId=thread-9",
    )
  })

  it("never sends an asUser parameter", async () => {
    const fetchMock = mockFetch(200, { data: DEFINITION })
    await fetchAgentDefinition("agent-1", OPTIONS)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).not.toMatch(/asUser|userId/)
    expect(init?.body ?? null).toBeNull()
    expect(init?.method ?? "GET").toBe("GET")
  })

  it("returns the same request regardless of any runtimeLocation argument", async () => {
    const fetchMock = mockFetch(200, { data: DEFINITION })
    // The signature takes an agent id and the connection, and nothing about
    // where the turn will run: an extra argument cannot change the request.
    expect(fetchAgentDefinition.length).toBe(2)
    await fetchAgentDefinition("agent-1", OPTIONS)
    await (fetchAgentDefinition as (...args: unknown[]) => Promise<unknown>)(
      "agent-1",
      OPTIONS,
      "local",
    )
    const [first, second] = fetchMock.mock.calls
    expect(String(second?.[0])).toBe(String(first?.[0]))
    expect(second?.[1]).toEqual(first?.[1])
  })

  it("surfaces a 403 as a typed forbidden error, never an empty definition", async () => {
    mockFetch(403, { error: { message: "missing scope" } })
    const failure = await fetchAgentDefinition("agent-1", OPTIONS).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(AgentDefinitionForbiddenError)
    expect((failure as AgentDefinitionForbiddenError).status).toBe(403)
  })

  it("surfaces any other failure as a typed request error", async () => {
    mockFetch(404, { error: { message: "agent not found" } })
    const failure = await fetchAgentDefinition("agent-1", OPTIONS).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(AgentDefinitionRequestError)
    expect(failure).not.toBeInstanceOf(AgentDefinitionForbiddenError)
    expect((failure as AgentDefinitionRequestError).status).toBe(404)
  })

  it("unwraps the envelope into the four documented fields", async () => {
    mockFetch(200, { data: DEFINITION })
    await expect(fetchAgentDefinition("agent-1", OPTIONS)).resolves.toEqual(DEFINITION)
  })
})

// THE COMPOSED TEXT IS THE COST. It is appended to the system prompt of every
// local turn, so what it renders is a budget question, not a formatting one.
// Both list parts used to be content: every skill's whole body, and the whole
// tool catalog. They are indexes now, and the composition is what makes that
// true on the wire.
describe("composeAgentDefinitionText", () => {
  const FULL = {
    systemPrompt: "you are @support",
    skillIndex: [
      { name: "invoicing", description: "always de-tax an export" },
      { name: "shipping", description: "carton ladder first" },
    ],
    scopedMemory: [{ line: "- [crm](project/crm-note.md), 2026-09-01" }],
    mcpToolList: [
      { name: "kernel__tool_search", description: "find a tool by task keywords" },
      { name: "kernel__skill_read", description: "load a skill by name" },
    ],
  }

  it("renders the parts in order, each under its heading and preamble", () => {
    const text = composeAgentDefinitionText(FULL)
    const order = [
      text.indexOf("you are @support"),
      text.indexOf("## Skills available"),
      text.indexOf("## Memory index"),
      text.indexOf("## Liaison tools"),
    ]
    for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain(SKILLS_PREAMBLE)
    expect(text).toContain(TOOLS_PREAMBLE)
    expect(text).toContain("- invoicing: always de-tax an export")
    // The session's own name for the tool: the SDK prefixes MCP tools with
    // `mcp__<server>__`, and the bare server name is no tool at all there.
    expect(text).toContain("- mcp__liaison__kernel__tool_search: find a tool by task keywords")
    expect(text).not.toMatch(/^- kernel__/m)
  })

  it("renders nothing for an empty part, so an agent with no skills carries no heading", () => {
    const text = composeAgentDefinitionText({
      systemPrompt: "bare",
      skillIndex: [],
      scopedMemory: [],
      mcpToolList: [],
    })
    expect(text).toBe("bare")
  })

  it("has no way to render a skill body: a part carrying one contributes its name only", () => {
    // The old shape, handed to the new composer. A body must not reach the
    // text through a stale field name or a lenient row reader.
    const text = composeAgentDefinitionText({
      systemPrompt: "you are @support",
      skillIndex: [{ name: "invoicing", body: "BODY_SHOULD_NOT_RIDE" }],
      scopedMemory: [],
      mcpToolList: [],
    })
    expect(text).not.toContain("BODY_SHOULD_NOT_RIDE")
    expect(text).toContain("- invoicing")
  })
})

// THE SAME SENTENCE ON BOTH SIDES. The API measures the definition's budget
// over `AGENT_DEFINITION_SKILLS_PREAMBLE` and this composer renders
// `SKILLS_PREAMBLE`; a drift between the two means the budget guards a text no
// session carries. The API module pulls in its database layer, so the literal
// is read from its source rather than imported.
describe("SKILLS_PREAMBLE", () => {
  const EXPECTED =
    "Each line below names a Liaison skill, served by the Liaison MCP server, never by a local Skill tool: load one by calling the tool mcp__liaison__kernel__skill_read with the skill's exact name, then follow its instructions. mcp__liaison__kernel__skill_search finds one by keyword. Both are loaded from the start: call them directly, no tool search first."

  it("names the exact local tool that loads a Liaison skill, not a bare skill_read", () => {
    // The SDK carries its own local `Skill` tool; under the old wording a
    // model called it with a Liaison skill name and got "Unknown skill".
    expect(SKILLS_PREAMBLE).toBe(EXPECTED)
  })

  it("is byte-identical to the API's AGENT_DEFINITION_SKILLS_PREAMBLE", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../api/src/modules/agent/context/context.ts"),
      "utf8",
    )
    const match = source.match(
      /export const AGENT_DEFINITION_SKILLS_PREAMBLE =\s*"((?:[^"\\]|\\.)*)"/,
    )
    expect(match).not.toBeNull()
    expect(JSON.parse(`"${match?.[1]}"`)).toBe(SKILLS_PREAMBLE)
  })
})

describe("LOCAL_TOOL_PREFIX", () => {
  it("is the prefix the sidecar's Liaison MCP server gives its tools", async () => {
    const { LIAISON_MCP_SERVER } = await import("../../sidecar/auto-policy")
    expect(LOCAL_TOOL_PREFIX).toBe(`mcp__${LIAISON_MCP_SERVER}__`)
  })

  it("is the prefix the skills preamble names the skill tools with", () => {
    expect(SKILLS_PREAMBLE).toContain(`${LOCAL_TOOL_PREFIX}kernel__skill_read`)
    expect(SKILLS_PREAMBLE).toContain(`${LOCAL_TOOL_PREFIX}kernel__skill_search`)
  })

  it("is byte-identical to the API's AGENT_DEFINITION_LOCAL_TOOL_PREFIX", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../api/src/modules/agent/context/context.ts"),
      "utf8",
    )
    const match = source.match(/export const AGENT_DEFINITION_LOCAL_TOOL_PREFIX = "([^"]*)"/)
    expect(match?.[1]).toBe(LOCAL_TOOL_PREFIX)
  })
})
