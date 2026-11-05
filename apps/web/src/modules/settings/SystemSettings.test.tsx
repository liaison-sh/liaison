// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  running: "dev",
  securityUpdate: false,
  team: null as unknown,
  put: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: vi.fn(async (path: string) => {
      if (path === "/admin/version-check") {
        return state.securityUpdate
          ? {
              running: state.running,
              latest: "v1.1.0",
              updateAvailable: true,
              securityUpdate: true,
              enabled: true,
            }
          : { running: state.running, updateAvailable: false, enabled: false }
      }
      if (path === "/admin/liaison-team") return state.team
      return {
        status: "ok",
        version: state.running,
        migrationHead: "",
        schemaBaseline: "",
        dependencies: {},
      }
    }),
    put: (...args: unknown[]) => (state.put as (...a: unknown[]) => unknown)(...args),
    patch: vi.fn(),
  }),
}))

import SystemSettings from "./SystemSettings"

interface TeamBody {
  available: boolean
  canManage: boolean
  register: Record<string, unknown>
  forwardBugReports: { enabled: boolean }
  bugReportsTeamOnly: { enabled: boolean }
  outbox?: Record<string, unknown>
}

function team(over: Partial<TeamBody> = {}): TeamBody {
  return {
    available: true,
    canManage: true,
    register: { enabled: false, state: "off", instanceId: null, registeredAt: null },
    forwardBugReports: { enabled: false },
    bugReportsTeamOnly: { enabled: false },
    outbox: { pending: 0, failed: 0, expired: 0, lastDeliveredAt: null, lastError: null },
    ...over,
  }
}

describe("SystemSettings: the running version", () => {
  beforeEach(() => {
    state.running = "dev"
    state.securityUpdate = false
    state.team = team()
    state.put = vi.fn()
  })

  it("a build of main reads as the branch and its commit", async () => {
    state.running = "main-5f37ce0"
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("system-version-running")).toHaveTextContent("main · 5f37ce0")
  })

  it("a release tag reads verbatim", async () => {
    state.running = "v1.4.0"
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("system-version-running")).toHaveTextContent(/^v1\.4\.0$/)
  })

  it("a security update says so in the update banner", async () => {
    state.running = "v1.0.0"
    state.securityUpdate = true
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("update-banner")).toHaveTextContent(
      "Security update available:",
    )
  })
})

describe("SystemSettings: Liaison team", () => {
  beforeEach(() => {
    state.running = "dev"
    state.team = team()
    state.put = vi.fn()
  })

  it("lists exactly the four fields that are sent", async () => {
    render(() => <SystemSettings />)
    await screen.findByTestId("settings-liaison-team")
    expect(screen.getAllByTestId("liaison-team-field")).toHaveLength(4)
  })

  it("forward switch is disabled while register is off, and both start off", async () => {
    render(() => <SystemSettings />)
    const register = await screen.findByTestId("toggle-liaison-register")
    const forward = screen.getByTestId("toggle-liaison-forward")
    expect(register).not.toBeDisabled()
    expect(register).toHaveAttribute("aria-pressed", "false")
    expect(forward).toBeDisabled()
    expect(forward).toHaveAttribute("aria-pressed", "false")
  })

  it("forward switch is enabled once registration is on", async () => {
    state.team = team({
      register: { enabled: true, state: "registered", instanceId: "abc" },
    })
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("toggle-liaison-forward")).not.toBeDisabled()
  })

  it("turning registration on sends it and shows the answer", async () => {
    state.put = vi.fn(async () =>
      team({ register: { enabled: true, state: "pending", instanceId: "abc" } }),
    )
    render(() => <SystemSettings />)
    fireEvent.click(await screen.findByTestId("toggle-liaison-register"))
    await waitFor(() =>
      expect(screen.getByTestId("liaison-team-state-value")).toHaveTextContent("Registering"),
    )
    expect(state.put).toHaveBeenCalledWith("/admin/liaison-team", { register: true })
  })

  it("shows the last error when the state is error", async () => {
    state.team = team({
      register: { enabled: true, state: "error", lastError: "registration refused" },
    })
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("liaison-team-error")).toHaveTextContent(
      "registration refused",
    )
    expect(screen.getByTestId("liaison-team-state-value")).toHaveTextContent("Error")
  })

  it("shows the server id and the outbox to the operator when there is something waiting", async () => {
    state.team = team({
      register: { enabled: true, state: "registered", instanceId: "11111111-aaaa" },
      outbox: { pending: 2, failed: 1, expired: 0, lastDeliveredAt: null, lastError: null },
    })
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("liaison-team-server-id")).toHaveTextContent("11111111-aaaa")
    expect(screen.getByTestId("liaison-team-outbox")).toHaveTextContent("2")
  })

  it("no server id or outbox when canManage is false, and the switches are disabled with a reason", async () => {
    state.team = team({
      canManage: false,
      register: { enabled: true, state: "registered" },
      outbox: undefined,
    })
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("toggle-liaison-register")).toBeDisabled()
    expect(screen.getByTestId("toggle-liaison-forward")).toBeDisabled()
    expect(screen.queryByTestId("liaison-team-server-id")).toBeNull()
    expect(screen.queryByTestId("liaison-team-outbox")).toBeNull()
    expect(screen.getByTestId("liaison-team-reason")).toBeInTheDocument()
  })

  it("team-only switch is disabled with a hint while forwarding is off", async () => {
    state.team = team({ register: { enabled: true, state: "registered", instanceId: "abc" } })
    render(() => <SystemSettings />)
    const teamOnly = await screen.findByTestId("toggle-liaison-team-only")
    expect(teamOnly).toBeDisabled()
    expect(teamOnly).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("liaison-team-team-only-hint")).toHaveTextContent(
      "Allow sending bug reports first.",
    )
  })

  it("team-only switch turns on once forwarding is on, and shows the stored state", async () => {
    state.team = team({
      register: { enabled: true, state: "registered", instanceId: "abc" },
      forwardBugReports: { enabled: true },
    })
    state.put = vi.fn(async () =>
      team({
        register: { enabled: true, state: "registered", instanceId: "abc" },
        forwardBugReports: { enabled: true },
        bugReportsTeamOnly: { enabled: true },
      }),
    )
    render(() => <SystemSettings />)
    const teamOnly = await screen.findByTestId("toggle-liaison-team-only")
    expect(teamOnly).not.toBeDisabled()
    expect(screen.queryByTestId("liaison-team-team-only-hint")).toBeNull()
    fireEvent.click(teamOnly)
    await waitFor(() =>
      expect(screen.getByTestId("toggle-liaison-team-only")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    )
    expect(state.put).toHaveBeenCalledWith("/admin/liaison-team", { bugReportsTeamOnly: true })
  })

  it("when sharing is unavailable, both switches are disabled and the reason says so", async () => {
    state.team = team({ available: false })
    render(() => <SystemSettings />)
    expect(await screen.findByTestId("toggle-liaison-register")).toBeDisabled()
    expect(screen.getByTestId("liaison-team-reason")).toHaveTextContent("not available")
  })
})
