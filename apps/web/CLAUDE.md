# Web frontend (SolidJS)

Before implementing any UI, check what exists: `src/ui/README.md` is the primitive catalog, `src/modules/threads/README.md` covers message list, reactions and the action toolbar, `docs/frontend-overview.md` the architecture. Floating UI (menus, pickers, popovers) uses `PopupMenu`, modals and confirmations `Dialog`, hover hints `Tooltip`, clickable actions `Button` with the right variant. Reach for raw `@kobalte/core/*` only when building a NEW wrapper in `ui/`.

## SolidJS idioms

- Never destructure props: it breaks reactivity. Use `splitProps()` / `mergeProps()`.
- Derived signals over `createMemo`; upgrade to `createMemo` only for expensive or multi-reader computations. Never write to a signal inside `createEffect`: derive with `createMemo`.
- Stores for nested state, signals for primitives. If you are spreading `{ ...signal(), field }`, switch to `createStore` + `produce()`.
- `createResource` for data fetching, paired with `<Suspense>` and `<ErrorBoundary>`.
- Kobalte wrappers in `src/ui/`: one per primitive, `cn()` for class merging, `class` not `className`. `ParentComponent` for children, `Component` for leaves. Context pattern: `createContext<T>()`, `XxxProvider`, `useXxx()` that throws outside its provider.

## Layout and import rules

`src/modules/` colocates each domain's stores, components and pages (`threads/`, `auth/`, `shell/`, `settings/`; a new feature gets its own module). `src/framework/` is the app runtime, `src/ui/` the domain-agnostic design system, `src/lib/` utilities and API client, `src/primitives/` shared reactive primitives (`createWebSocket`, `createScrollOverflow`).

- `ui/` imports only from `lib/` and `primitives/`: no stores, no modules.
- Modules may import from `lib/`, `primitives/`, `ui/`, `framework/` and other modules. Cross-module imports are fine.
- `framework/` is three layers and layer N imports only from layers below it: `app-registry.ts` (pure registry of tab types, activity bar, settings sections, commands, keybindings, WebSocket entity handlers, slots, contributions; zero domain imports), then `define-app.ts` (the frontend app contract, `registerApp` / `unregisterApp`, tracking primitives in `appIndex` for clean teardown), then `bootstrap.ts` (leaf: imports domain stores, registers the kernel tab types, activity bar, commands and handlers, called once at startup, imported by nothing).

## Chat dock overlap (binding)

Chat dock overlap is intended. The dock's collapsed bar and pills may partly cover page content, including a bottom-right primary action. Never change layout, padding or the dock for a partial overlap; only a fully hidden action is a bug. The only exception is right-side panels such as task comments (and a thread's side panel), which reserve dock clearance at their bottom (`--shell-dock-strip`). A long form whose last row is an action row may also end its scroll container in a runway (`pb-dock-runway`, index.css): bottom padding that only shows once scrolled to the end, so the row can be lifted above the bar; the page, the row and the dock stay where they are. A bottom-pinned composer (every `DockedComposer` footer, and the mail compose footer) rises above the bar once the bar covers the centre of one of its controls, i.e. once enough conversations are open to hide it, and drops back when the bar shrinks (`primitives/dockLift.ts`, owner 2026-11-13); a bar that only grazes the Send corner still moves nothing. UI tests click a visible part of the action or assert it is not fully covered.

## Tabs

`modules/shell/tab-store.ts` is the single source of truth for open tabs; the URL is kept in sync by effects in Shell, which uses `untrack()` in the tab-to-URL sync so WebSocket label updates do not cascade. Sidebar content derives from the active tab's registry entry, and components receive `entityId` as a prop: never `useParams()`.

- All open tabs stay mounted, inactive ones hidden with `display: none`, so switching is free and scroll position survives.
- Adding a tab type is one `tabTypes` entry in the app's `registerApp()` call (component, sidebar, icon, URL pattern). Shell, MainPanel, Sidebar and ActivityBar need no changes.
- `singleton: true` makes `openTab` activate the existing instance instead of duplicating. Preview tabs are italic on single click and promote on double click or engagement. URL pattern sorting is dynamic (`/threads/:entityId`), then static by length, then root. `mod+` in keybindings maps to Cmd on Mac and Ctrl elsewhere. `resolveLabel` lets Shell fetch dynamic labels without circular imports, and `preserveSubRoutes` stops URL overwrite for tabs with internal navigation such as Settings.
