// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-D T5: the page's part in node jobs is to hand the shell what it hears.
// An offer reaches the shell only on an enabled node; the backlog prompt is
// started only there too.
import { afterEach, describe, expect, it, vi } from "vitest"
import { DESKTOP_BRIDGE_KEY, DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import {
  forwardNodeFolderRequest,
  forwardNodeFullOutput,
  forwardNodeImportRequest,
  forwardNodeJobOffer,
  forwardNodeReconnected,
  forwardNodeSessionCommand,
  nodeReconnectEdge,
  startNodeJobsIfNode,
} from "./node-jobs"
import { NodeSessionTestAccess, setNodeSession } from "./node-session"

function installBridge() {
  const bridge = {
    version: DESKTOP_BRIDGE_VERSION,
    nodeJobOffered: vi.fn(),
    startNodeJobs: vi.fn(),
    nodeSessionCommand: vi.fn(),
    nodeReconnected: vi.fn(),
    nodeFullOutputRequested: vi.fn(),
    nodeFolderRequest: vi.fn(),
    nodeImportRequest: vi.fn(),
  }
  ;(globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY] = bridge
  return bridge
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  NodeSessionTestAccess.reset()
})

describe("node jobs in the page", () => {
  it("forwards an offer to the shell only when this computer is an enabled node", () => {
    const bridge = installBridge()
    forwardNodeJobOffer({ type: "node_job_offer", jobId: "job-1" })
    expect(bridge.nodeJobOffered).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: false })
    forwardNodeJobOffer({ type: "node_job_offer", jobId: "job-1" })
    expect(bridge.nodeJobOffered).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeJobOffer({ type: "node_job_offer", jobId: "job-1" })
    forwardNodeJobOffer({ type: "node_job_offer" })
    expect(bridge.nodeJobOffered).toHaveBeenCalledTimes(1)
    expect(bridge.nodeJobOffered).toHaveBeenCalledWith("job-1")
  })

  it("the offer forwards the agent id (L24)", () => {
    const bridge = installBridge()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeJobOffer({ type: "node_job_offer", jobId: "job-2", agentId: "agent-7" })
    expect(bridge.nodeJobOffered).toHaveBeenCalledWith("job-2", "agent-7")
    forwardNodeJobOffer({ type: "node_job_offer", jobId: "job-3", agentId: 42 })
    expect(bridge.nodeJobOffered).toHaveBeenLastCalledWith("job-3")
  })

  it("starts the node's job runner (and its backlog prompt) only on an enabled node", () => {
    const bridge = installBridge()
    const onReview = vi.fn()
    expect(startNodeJobsIfNode(onReview)).toBe(false)
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    expect(startNodeJobsIfNode(onReview)).toBe(true)
    expect(bridge.startNodeJobs).toHaveBeenCalledWith({ onReview })
  })
})

describe("steering wake and reconnect (P3-T14)", () => {
  const SID = "9f8e7d6c-5b4a-4321-8fed-cba987654321"

  it("a node_session_command frame reaches the bridge with its session id; a malformed one does not", () => {
    const bridge = installBridge()
    forwardNodeSessionCommand({ type: "node_session_command", sessionId: SID })
    expect(bridge.nodeSessionCommand).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeSessionCommand({ type: "node_session_command", sessionId: SID })
    forwardNodeSessionCommand({ type: "node_session_command", sessionId: "../x" })
    forwardNodeSessionCommand({ type: "node_session_command", sessionId: 42 })
    forwardNodeSessionCommand(null)
    expect(bridge.nodeSessionCommand).toHaveBeenCalledTimes(1)
    expect(bridge.nodeSessionCommand).toHaveBeenCalledWith(SID)
  })

  it("a reconnect edge calls nodeReconnected once, the first connect does not", () => {
    const bridge = installBridge()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    const edge = nodeReconnectEdge()
    for (const status of ["connecting", "connected", "connected"]) edge(status)
    expect(bridge.nodeReconnected).not.toHaveBeenCalled()
    for (const status of ["reconnecting", "connected", "connected"]) edge(status)
    expect(bridge.nodeReconnected).toHaveBeenCalledTimes(1)
    edge("disconnected")
    edge("connected")
    expect(bridge.nodeReconnected).toHaveBeenCalledTimes(2)
  })

  it("a reconnect on a computer that is not an enabled node forwards nothing", () => {
    const bridge = installBridge()
    forwardNodeReconnected()
    expect(bridge.nodeReconnected).not.toHaveBeenCalled()
  })
})

describe("full output request (P3-T22)", () => {
  const SID = "9f8e7d6c-5b4a-4321-8fed-cba987654321"

  it("a node_folder_request frame reaches the bridge; a bad id or a non-node does not", () => {
    const bridge = installBridge()
    forwardNodeFolderRequest({ type: "node_folder_request", requestId: SID })
    expect(bridge.nodeFolderRequest).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeFolderRequest({ type: "node_folder_request", requestId: "x/../y" })
    forwardNodeFolderRequest({ type: "node_folder_request", requestId: SID })
    expect(bridge.nodeFolderRequest).toHaveBeenCalledTimes(1)
    expect(bridge.nodeFolderRequest).toHaveBeenCalledWith(SID)
  })

  it("S40: a node_import_request frame reaches the bridge; a bad id or a non-node does not", () => {
    const bridge = installBridge()
    forwardNodeImportRequest({ type: "node_import_request", requestId: SID })
    expect(bridge.nodeImportRequest).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeImportRequest({ type: "node_import_request", requestId: "x/../y" })
    forwardNodeImportRequest({ type: "node_import_request", requestId: SID })
    expect(bridge.nodeImportRequest).toHaveBeenCalledTimes(1)
    expect(bridge.nodeImportRequest).toHaveBeenCalledWith(SID)
    expect(bridge.nodeFolderRequest).not.toHaveBeenCalled()
  })

  it("a node_session_full_output frame reaches the bridge; bad ids or a non-node do not", () => {
    const bridge = installBridge()
    forwardNodeFullOutput({
      type: "node_session_full_output",
      sessionId: SID,
      toolUseId: "toolu_01A",
    })
    expect(bridge.nodeFullOutputRequested).not.toHaveBeenCalled()
    setNodeSession({ nodeId: "n", credential: "lnn_x", enabled: true })
    forwardNodeFullOutput({ sessionId: SID, toolUseId: "toolu_01A" })
    forwardNodeFullOutput({ sessionId: SID, toolUseId: "toolu_../x" })
    forwardNodeFullOutput({ sessionId: "nope", toolUseId: "toolu_01A" })
    forwardNodeFullOutput(null)
    expect(bridge.nodeFullOutputRequested).toHaveBeenCalledTimes(1)
    expect(bridge.nodeFullOutputRequested).toHaveBeenCalledWith(SID, "toolu_01A")
  })
})
