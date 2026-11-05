// SPDX-License-Identifier: FSL-1.1-ALv2
// What an app page shares with its blocks: which list and tree blocks hold
// unsaved edits (the page asks "Discard changes?" before leaving), and whether
// the page is the one on screen (blocks refetch when it comes back).
import {
  type Accessor,
  createContext,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js"

export interface AppPageContextValue {
  /** A block reports whether it holds unsaved edits. */
  setDirty: (blockId: string, dirty: boolean) => void
  /** Any block holds unsaved edits. */
  dirty: Accessor<boolean>
  /** Bumps each time the page becomes active again: blocks reload on change. */
  reloadToken: Accessor<number>
}

const AppPageContext = createContext<AppPageContextValue>()

/** The page's context, or undefined for a block rendered on its own. */
export function useAppPage(): AppPageContextValue | undefined {
  return useContext(AppPageContext)
}

export function createAppPageState(): AppPageContextValue & {
  bumpReload: () => void
  clearDirty: () => void
} {
  const [dirtyIds, setDirtyIds] = createSignal<ReadonlySet<string>>(new Set())
  const [reloadToken, setReloadToken] = createSignal(0)
  return {
    setDirty: (id, dirty) =>
      setDirtyIds((prev) => {
        if (prev.has(id) === dirty) return prev
        const next = new Set(prev)
        if (dirty) next.add(id)
        else next.delete(id)
        return next
      }),
    dirty: () => dirtyIds().size > 0,
    reloadToken,
    bumpReload: () => setReloadToken((n) => n + 1),
    clearDirty: () => setDirtyIds(new Set()),
  }
}

export const AppPageProvider: ParentComponent<{ value: AppPageContextValue }> = (props) => (
  <AppPageContext.Provider value={props.value}>{props.children}</AppPageContext.Provider>
)
