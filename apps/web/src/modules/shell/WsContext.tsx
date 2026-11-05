// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Accessor, createContext, type ParentComponent, useContext } from "solid-js"

type WsStatus = "connecting" | "connected" | "disconnected" | "reconnecting"

interface WsContextValue {
  send: (data: unknown) => void
  status: Accessor<WsStatus>
  /** The connection keeps being cut seconds after it opens (createWebSocket's `unstable`). */
  unstable: Accessor<boolean>
}

const WsContext = createContext<WsContextValue>()

interface WsProviderProps {
  send: (data: unknown) => void
  status: Accessor<WsStatus>
  /** Omitted (a baseline render, a test): never unstable. */
  unstable?: Accessor<boolean>
}

export const WsProvider: ParentComponent<WsProviderProps> = (props) => {
  return (
    <WsContext.Provider
      value={{
        send: props.send,
        status: props.status,
        unstable: () => props.unstable?.() ?? false,
      }}
    >
      {props.children}
    </WsContext.Provider>
  )
}

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext)
  if (!ctx) throw new Error("useWs must be used within WsProvider")
  return ctx
}

/**
 * For a component whose job is degraded, not broken, without a socket: it sends
 * nothing and says nothing rather than taking the surface down with it.
 */
export function useOptionalWs(): WsContextValue | undefined {
  return useContext(WsContext)
}
