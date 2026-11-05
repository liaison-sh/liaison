// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AppConnectionConfig, appsStore } from "./apps-store"
import {
  ConnectDialogHost,
  connectDialogRequest,
  openConnectDialog,
  settleConnectDialog,
} from "./connect-dialog-host"

const gitlabConn: AppConnectionConfig = {
  name: "gitlab",
  type: "credentials",
  credentialFields: [{ name: "token", label: "Access token", type: "password", required: true }],
}

describe("ConnectDialogHost", () => {
  beforeEach(() => appsStore.reset())
  afterEach(() => settleConnectDialog({ connected: false }))

  it("renders the credential form of the requested connection over the page", async () => {
    appsStore.setConnections({ gitlab: [gitlabConn] })
    render(() => <ConnectDialogHost />)
    expect(screen.queryByTestId("connect-app-dialog")).not.toBeInTheDocument()
    void openConnectDialog(undefined, "gitlab", { connectionName: "gitlab" })
    expect(await screen.findByTestId("connect-app-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("connect-field-token")).toBeInTheDocument()
  })

  it("Cancel closes the dialog and answers not connected", async () => {
    appsStore.setConnections({ gitlab: [gitlabConn] })
    render(() => <ConnectDialogHost />)
    const opened = openConnectDialog(undefined, "gitlab")
    await screen.findByTestId("connect-app-dialog")
    fireEvent.click(screen.getByText("Cancel"))
    await expect(opened).resolves.toEqual({ connected: false })
    expect(connectDialogRequest()).toBeNull()
    expect(screen.queryByTestId("connect-app-dialog")).not.toBeInTheDocument()
  })

  it("a newer request answers the open one as not connected", async () => {
    appsStore.setConnections({ gitlab: [gitlabConn] })
    const first = openConnectDialog(undefined, "gitlab")
    const second = openConnectDialog(undefined, "gitlab")
    await expect(first).resolves.toEqual({ connected: false })
    settleConnectDialog({ connected: true })
    await expect(second).resolves.toEqual({ connected: true })
  })
})
