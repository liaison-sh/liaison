// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Context over `panel-store`: the right-hand APP panel and nothing else.
 *
 * It was named for the agent panel it once carried; that panel retired with
 * P4c-T17 and `PanelState` is `app-panel` only (DV5), so the name follows the
 * thing it actually wraps. Conversation lives in the chat dock and the thread
 * view, never in a panel.
 */
import { type Accessor, createContext, type ParentComponent } from "solid-js"
import { panelOpen, togglePanel } from "./panel-store"

interface PanelContextValue {
  isOpen: Accessor<boolean>
  toggle: () => void
}

const PanelContext = createContext<PanelContextValue>()

export const PanelProvider: ParentComponent = (props) => {
  return (
    <PanelContext.Provider value={{ isOpen: panelOpen, toggle: togglePanel }}>
      {props.children}
    </PanelContext.Provider>
  )
}
