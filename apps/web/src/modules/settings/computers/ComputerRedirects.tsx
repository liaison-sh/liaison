// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FORMER PATHS of Settings > Computers, still in links people kept
// (notifications, messages, an agent's earlier answers):
//
//   /settings/nodes[?node=<id>&folder=<name>]  -> /settings/computers, or that
//                                                 computer's Folders with Add a
//                                                 folder searching for <name>
//   /settings/this-computer                    -> this computer's page, or the
//                                                 list while it is not set up
//
// Each is a hidden settings section whose page only redirects. It reacts to
// the path rather than to being mounted: a settings page stays mounted once
// visited.

import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { type Component, createEffect } from "solid-js"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { serverAddressOverride } from "~/lib/env"
import { COMPUTERS_ROUTE, computerRoute } from "./computer-model"

export const NODES_PATH = "/settings/nodes"
export const THIS_COMPUTER_PATH = "/settings/this-computer"

/** Where a former `/settings/nodes?…` link lands now. */
export function nodesRedirectTarget(params: { node?: unknown; folder?: unknown }): string {
  const node = typeof params.node === "string" && params.node ? params.node : null
  if (!node) return COMPUTERS_ROUTE
  const folder = typeof params.folder === "string" && params.folder ? params.folder : null
  return folder
    ? `${computerRoute(node)}?${new URLSearchParams({ folder }).toString()}`
    : computerRoute(node)
}

export const NodesRedirect: Component = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  createEffect(() => {
    if (location.pathname !== NODES_PATH) return
    navigate(nodesRedirectTarget({ node: params.node, folder: params.folder }), { replace: true })
  })
  return null
}

export const ThisComputerRedirect: Component = () => {
  const location = useLocation()
  const navigate = useNavigate()
  createEffect(() => {
    if (location.pathname !== THIS_COMPUTER_PATH) return
    const shell = getDesktopBridge()
    const server = serverAddressOverride()
    if (!shell?.loadNodeCredential || !server) {
      navigate(COMPUTERS_ROUTE, { replace: true })
      return
    }
    void shell
      .loadNodeCredential(server)
      .catch(() => null)
      .then((node) => {
        if (location.pathname !== THIS_COMPUTER_PATH) return
        navigate(node?.enabled ? computerRoute(node.nodeId) : COMPUTERS_ROUTE, { replace: true })
      })
  })
  return null
}
