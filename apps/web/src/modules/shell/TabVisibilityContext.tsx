// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Accessor, createContext, type ParentComponent, useContext } from "solid-js"

const TabVisibilityContext = createContext<Accessor<boolean>>()
const TabIdContext = createContext<string>()

export const TabVisibilityProvider: ParentComponent<{
  value: Accessor<boolean>
  tabId?: string
}> = (props) => {
  return (
    <TabVisibilityContext.Provider value={props.value}>
      <TabIdContext.Provider value={props.tabId}>{props.children}</TabIdContext.Provider>
    </TabVisibilityContext.Provider>
  )
}

export function useTabIsActive(): Accessor<boolean> {
  return useContext(TabVisibilityContext) ?? (() => true)
}

/** The id of the tab this component renders in, or undefined outside a tab (the chat dock). */
export function useTabId(): string | undefined {
  return useContext(TabIdContext)
}
