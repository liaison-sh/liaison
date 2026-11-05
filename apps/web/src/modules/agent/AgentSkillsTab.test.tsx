// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import AgentSkillsTab from "./AgentSkillsTab"
import { canAdministerAgent } from "./agent-permissions"
import { resetSkillsStore } from "./skills-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: vi.fn(() => "tab-id"),
}))

afterEach(resetSkillsStore)

const OWNED = {
  id: "sk-1",
  name: "triage-refunds",
  description: "How this agent triages a refund",
  body: "step one",
  source: "personal",
  requiredScopes: [],
  domain: null,
  ownerAgentId: "agent-1",
  canWrite: true,
}

const SOMEBODY_ELSES = {
  id: "sk-2",
  name: "unrelated-skill",
  description: "Owned by another agent",
  body: "nope",
  source: "personal",
  requiredScopes: [],
  domain: null,
  ownerAgentId: "agent-2",
  canWrite: true,
}

const APP_SHIPPED = {
  id: "sk-3",
  name: "shipped-playbook",
  description: "Shipped with the app",
  body: "app body",
  source: "app",
  appName: "tickets",
  requiredScopes: [],
  domain: null,
  ownerAgentId: "agent-1",
  canWrite: false,
}

function setup(canCreate: boolean, rows: any[] = [OWNED]) {
  const api = {
    // The route is the filter: only the agent's own rows come back, and a
    // request without the filter would be the FLAT screen's question.
    get: vi.fn(async (path: string) =>
      path.includes("ownerAgentId=agent-1") ? rows : [OWNED, SOMEBODY_ELSES],
    ),
    post: vi.fn(async (_path: string, body: any) => ({ ...body, id: "sk-new" })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentSkillsTab agentId="agent-1" canCreate={canCreate} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentSkillsTab", () => {
  it("the Skills tab lists only the agent's skills and creates with its ownerAgentId", async () => {
    const api = setup(true)

    await waitFor(() => expect(screen.getByTestId("skill-row-triage-refunds")).toBeInTheDocument())
    expect(api.get).toHaveBeenCalledWith("/agent/skills?ownerAgentId=agent-1")
    // Another agent's skill is not this agent's list.
    expect(screen.queryByTestId("skill-row-unrelated-skill")).toBeNull()
    // Provenance sub-tabs are the flat screen's question, not this one.
    expect(screen.queryByTestId("skills-subtabs")).toBeNull()

    fireEvent.click(screen.getByTestId("skills-new-skill"))
    await waitFor(() => expect(screen.getByTestId("agent-skill-create")).toBeInTheDocument())
    fireEvent.input(screen.getByTestId("agent-skill-create-name"), {
      target: { value: "new-playbook" },
    })
    fireEvent.input(screen.getByTestId("agent-skill-create-description"), {
      target: { value: "What it does" },
    })
    fireEvent.input(screen.getByTestId("agent-skill-create-body"), {
      target: { value: "the body" },
    })
    fireEvent.click(screen.getByTestId("agent-skill-create-save"))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/skills",
        expect.objectContaining({ name: "new-playbook", ownerAgentId: "agent-1" }),
      ),
    )
  })

  it("a member without write authority sees no New skill action", async () => {
    // The rule, once: a plain member looking at somebody else's personal agent.
    const canCreate = canAdministerAgent(
      { kind: "personal", ownerUserId: "user-other" },
      { userId: "user-me", isAgentsAdmin: false },
    )
    expect(canCreate).toBe(false)

    setup(canCreate, [{ ...OWNED, canWrite: false }])

    await waitFor(() => expect(screen.getByTestId("skill-row-triage-refunds")).toBeInTheDocument())
    expect(screen.queryByTestId("skills-new-skill")).toBeNull()

    // And the row's own edit affordance follows the server's `canWrite`.
    fireEvent.click(screen.getByTestId("skill-row-triage-refunds"))
    await waitFor(() => expect(screen.getByTestId("skill-detail")).toBeInTheDocument())
    expect(screen.queryByTestId("skill-edit")).toBeNull()
  })

  // The tab is a master/detail surface like Memory, so its right half is never
  // empty on arrival: an empty detail pane beside a narrow list is what read as
  // a mobile column that had lost its content.
  it("the first skill is selected on arrival, so the detail pane is never empty", async () => {
    setup(true)
    await waitFor(() => expect(screen.getByTestId("skill-detail")).toBeInTheDocument())
    // Without a single click.
    expect(screen.getByTestId("skill-row-triage-refunds")).toHaveClass("bg-surface-active")
    expect(screen.queryByTestId("agent-skills-no-selection")).toBeNull()
  })

  it("the list groups the agent's own skills apart from the app-shipped ones", async () => {
    setup(true, [OWNED, APP_SHIPPED])
    await waitFor(() =>
      expect(screen.getByTestId("skill-row-shipped-playbook")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("skills-group-agent")).toBeInTheDocument()
    expect(screen.getByTestId("skills-group-app")).toBeInTheDocument()
  })

  it("one provenance draws no header", async () => {
    setup(true)
    await waitFor(() => expect(screen.getByTestId("skill-row-triage-refunds")).toBeInTheDocument())
    expect(screen.queryByTestId("skills-group-agent")).toBeNull()
    expect(screen.queryByTestId("skills-group-app")).toBeNull()
  })
})
