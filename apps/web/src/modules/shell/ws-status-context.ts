// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Accessor, createContext } from "solid-js"

export type WsStatus = "connecting" | "connected" | "disconnected" | "reconnecting"

const defaultStatus: Accessor<WsStatus> = () => "connected"

/**
 * Thin reactive accessor for WebSocket connection status, used by widgets
 * that need to surface offline UX (e.g. ComposeBar) without holding a
 * reference to the full WS context (which throws outside a provider).
 *
 * When no provider is mounted (tests, isolated stories) the default
 * accessor returns "connected" — components must degrade gracefully.
 */
export const WsStatusContext = createContext<Accessor<WsStatus>>(defaultStatus)
