# Frontend Overview

## Runtime & Framework

The frontend is a **SolidJS** single-page application bundled with **Vite**, styled with **Tailwind CSS**, and using **Kobalte** for accessible UI primitives. The entry point is `src/index.tsx`: it first exposes the shared Solid runtime and host-services (`@liaison/host`) as window globals so plugin app bundles share one reactive graph with the kernel, then calls `initializeAuth()` and `completeRuntimeInit()` (both from `startup.ts`) around the `<App />` render.

Startup sequence:
1. `bootstrapKernelApps()` — registers kernel tab types, WS handlers, activity bar, settings sections, commands, keybindings
2. `loadManifestApps()` — loads plugin apps declared in backend manifests
3. `rehydrateTabs()` — restores persisted tabs from localStorage, validates entities still exist

---

## Domain Modules

The frontend uses **domain modules** — each module colocates its stores, components, and pages under `src/modules/`. The four below are the kernel core; `src/modules/` also holds many other domain modules (agent, tickets, mail, contacts, knowledge, projects, search, calendar, files, and more), each following the same colocation pattern:

### `auth/` — Auth & Identity

- **`auth-store.ts`** — Signals: `accessToken`, `hasSession`, `challengeToken`, `isRestoringSession`. Accessors: `isAuthenticated()`, `userFromToken()`, `hasScope(scope)`. BroadcastChannel syncs login/logout across browser tabs
- **`createAuthManager.ts`** — Singleton `authManager` with `ensureFreshToken()` and `logout()`. Logout triggers `teardownSession()` (LIFO cleanup of all stores)
- **Pages:** `Login.tsx`, `Register.tsx`, `TotpVerify.tsx`, `ResetPassword.tsx`, `ResetPasswordConfirm.tsx`, `OAuthComplete.tsx`, `ProtectedRoute.tsx`

### `shell/` — App Shell & Layout

- **`tab-store.ts`** — SolidJS store. Single source of truth for open tabs. Supports singleton tabs, preview tabs (italic/temporary until promoted), preview groups, localStorage persistence (Zod-validated), entity validation on rehydration
- **`toast-store.ts`** — Signal. Max 3 visible, auto-dismiss after 5s
- **`panel-store.ts`** — Signal. Manages the right-side panel slot. Panel types: `"agent"` (default), `"discussion"`, `"app-panel"` (app-provided panels with `appName` + `panelType` + optional `context`). Persists open/closed state to localStorage
- **`Shell.tsx`** — Main layout: creates WebSocket, sets up event dispatch via registry, syncs URL ↔ active tab (uses `untrack()` to prevent cascades from WS label updates), registers global keybindings. Renders app panels via the panel registry using `<Dynamic>` — when `activePanel().type === "app-panel"`, resolves the component from `getPanel()` by fully-qualified key (`appName:panelType`)
- **`MainPanel.tsx`** — Keep-alive rendering: all open tabs mounted simultaneously, inactive hidden via `display: none`. Zero-cost tab switches — no remount, scroll position preserved
- **`TabBar.tsx`** — Tab strip with drag-reorder
- **`ActivityBar.tsx`** — Vertical icon sidebar (left edge)
- **`Sidebar.tsx`** — Context sidebar (content changes per active tab's registry entry)
- **Contexts:** `ApiContext.tsx`, `WsContext.tsx`, `PanelContext.tsx`, `TabVisibilityContext.tsx`
- **`CommandPalette.tsx`** — Cmd+P fuzzy search, `KeyboardShortcutsOverlay.tsx` — Cmd+? help

### `threads/` — Messaging System

- **`thread-store.ts`** — SolidJS store: `byId`, partition signals (`pinnedIds`, `userPinnedIds`, `unpinnedIds`). `threadDisplayName(thread, currentUserId)` derives display name from title or participant names
- **`message-store.ts`** — SolidJS store: messages organized by `threadId`. Cursor-based pagination. Handles optimistic updates via `thread-view-optimistic.ts`
- **`presence-store.ts`** — SolidJS store: user online/away/offline status, typing indicators (4s TTL per user per thread)
- **Components:** `ThreadView.tsx`, `ThreadHeader.tsx`, `MessageList.tsx` (infinite scroll), `MessageRow.tsx` (reactions), `ComposeBar.tsx` (contenteditable with mention detection), `MentionAutocomplete.tsx`, `ReactionPicker.tsx`, `TypingIndicator.tsx`, `HomeSidebar.tsx`, `NewChannelDialog.tsx`, `NewMessageDialog.tsx`

### `settings/` — Configuration & Admin

- **`SettingsLayout.tsx`** — Settings container with sidebar nav
- **Pages:** `ProfileSettings.tsx`, `SecuritySettings.tsx`, `AdminUsers.tsx`, `AdminOrg.tsx`, `AdminOAuth.tsx`

---

## Framework Layer (`src/framework/`)

Three-layer architecture that eliminates circular dependencies:

### Layer 1: `app-registry.ts` — Pure Registry

Zero domain imports. Exports registration functions and accessors for:

| Registry | Key Type | Purpose |
|----------|----------|---------|
| **Tab Types** | `TabTypeRegistration` | Component, sidebar, icon, URL pattern, singleton, resolveLabel, preserveSubRoutes, validateEntity |
| **Activity Bar** | `ActivityBarEntry` | Icon, label, order, position (top/bottom), tabAction |
| **Settings** | `SettingsSection` | Label, href, component, group (user/admin), adminScope, order |
| **Commands** | `CommandRegistration` | Label, shortcut, execute callback |
| **Keybindings** | `KeyBinding` | Key spec (e.g. `mod+p`), handler. `mod` maps to Cmd on Mac, Ctrl elsewhere |
| **WS Entity Handlers** | Per-entity | Handler with owner + priority (0–100, lower first) |
| **WS Message Handlers** | Per-message-type | Handler with owner + priority |
| **Slots & Contributions** | Extensible UI points | Slot declarations + contribution entries |
| **Panels** | `PanelRegistration` | Component, icon, label. Keyed by `appId:localType`. Rendered by Shell via `<Dynamic>` |

URL pattern helpers: `patternToUrl()`, `matchUrlPattern()`, `urlToTabInfo()`.

The home attention feed itself is server-driven: `modules/shell/attention-store.ts` fetches an `AttentionFeedResponse` from the backend feed API rather than polling frontend-app-registered providers.

### Layer 2: `define-app.ts` — App Contract

- `AppDefinition` interface: `{ name, tabTypes?, activityBar?, settings?, commands?, wsHandlers?, wsMessages?, keybindings?, slots?, contributions?, panels?, entityExternalLinks?, saveable?, savedViews?, bulkUi? }`
- `registerApp(def)` — Registers all primitives (including panels), tracks index for clean teardown. Idempotent, batched refresh: re-registering updates in place without tearing down unchanged tab types (avoids tab/URL churn during manifest reloads)
- `unregisterApp(name)` — Removes all registered primitives
- `registerAppFromManifest(manifest, uiExports)` — Hydrates a backend `AppManifest` into registry entries. Resolves component/icon/handler references from the `uiExports` map. Used by manifest-format apps whose frontend views are declared as metadata rather than programmatic `registerApp()` calls

### Layer 3: `bootstrap.ts` — Kernel Registration (leaf module)

Imports domain stores. Registers:
- Tab types: `home` (/), `thread` (/threads/:entityId), `settings` (/settings), `search` (/search, singleton), `detail` (/detail/:entityId+ — the generic plugin detail tab that mounts panels via `PluginMountBoundary`)
- Settings sections, in four groups (`group` on each section): You (Profile, Security, Notifications, Computers, Connections), AI (AI models, Agent safety, Media analysis, Usage, Plan), Workspace (Organization, Users, Roles, Access requests, Apps, Integrations, SSO, MCP servers, Data export, System), Apps (each app's own sections, registered from its manifest)
- WS handlers: thread, message, reaction, participant, typing, presence events
- WS message handlers: `sync` (tab validation), `presence_sync`
- Activity bar: Home (top), Settings (bottom)
- Commands and keybindings

Manifest-format apps call `registerAppFromManifest()` from startup rather than `bootstrap.ts`. The manifest declares tab types, panels, activity bar entries, settings sections, etc. as metadata; `registerAppFromManifest()` resolves the referenced components from a `uiExports` map and delegates to `registerApp()`.

**Import rule:** Layer N may only import from layers < N. Nothing imports from `bootstrap.ts`.

---

## UI Components (`src/ui/`)

Kobalte + Tailwind wrappers. **Never use raw Kobalte primitives directly** — always use these wrappers.

| Component | Pattern | Key Features |
|-----------|---------|-------------|
| `Button` | Kobalte Button | Variants: default/ghost/outline/primary/danger. Sizes: sm/md/lg. Loading state |
| `PopupMenu` | Kobalte DropdownMenu | Compound: `.Trigger`, `.Content`, `.Item`, `.Group`, `.Label`, `.Separator` |
| `FloatingPanel` | Kobalte Popover | `.Uncontrolled` variant with hover grace (300ms) |
| `Dialog` | Kobalte Dialog | Compound: `.Content`, `.Title`, `.Description`, `.Close` |
| `Input` | HTML input | Tailwind-styled text input |
| `Tooltip` | Kobalte Tooltip | `content` + `children` |
| `Toggle` | Kobalte Toggle | Binary on/off |
| `ScrollFade` | Custom | Scrollable with CSS fade edges |
| `Skeleton` | Div | Loading placeholder |
| `AvatarStack` | Custom | Overlapping avatar circles |
| `SafeHTML` | Custom | `innerHTML` with sanitization |

All use `splitProps()` for reactivity, `cn()` for class merging, `class` (not `className`).

---

## Reactive Primitives (`src/primitives/`)

| Primitive | Purpose |
|-----------|---------|
| `createWebSocket` | WebSocket client with auto-reconnect, ping/pong (30s/5s timeout), lastEventId persistence scoped per org+user. Returns `{ status(), on(), connect(), disconnect(), send() }` |
| `createDebouncedSearch` | Debounced async search with request cancellation |
| `createScrollOverflow` | Track scroll position for fade edge rendering |
| `createNow` | Reactive current-time signal (ticking clock) |
| `createStaleResource` | Resource wrapper that keeps the previous value visible while refetching |

---

## Lib Utilities (`src/lib/`)

| Module | Purpose |
|--------|---------|
| `api-client.ts` | HTTP client: auto `Authorization: Bearer` header, unwraps `{ data: T }` envelope, content-type auto-detection. Config: `{ getAccessToken, onUnauthorized, ensureFreshToken?, onError? }` |
| `session-lifecycle.ts` | `onSessionTeardown(fn)` registry. Every store registers its reset function. `teardownSession()` runs all in LIFO order on logout |
| `mention-format.ts` | Grammar: `@[Label](type:id)`. `parseMentions()`, `serializeMention()`, `createMentionRe()` |
| `mention-service.ts` | `searchMentions(api, query, trigger, limit, type?)` — API wrapper for mention autocomplete |
| `auth-refresh.ts` | Token refresh error classification: `"invalid_credentials"` → logout, `"transient"` → retry |
| `sanitize.ts` | HTML sanitization for user-generated content |
| `cn.ts` | clsx-like class merging |
| `logger.ts` | Structured logging with `child()` context |
| `env.ts` | Vite env: `VITE_API_BASE`, `VITE_WS_BASE`. URL builders: `apiUrl()`, `authApiUrl()` |
| `storage.ts` | Namespaced localStorage (prevents collisions) |
| `roving-focus.ts` | Roving tabindex for keyboard accessibility |
| `safe-return-to.ts` | Sanitize redirect URLs |

---

## Key Patterns

### Session Lifecycle

Every store registers cleanup at module scope:
```typescript
onSessionTeardown(resetThreadStore)
```
On logout, `teardownSession()` runs all cleanups in LIFO order — stores reset, localStorage cleared, WebSocket disconnected.

### Tab System

1. **Tab ID:** `makeTabId(type, entityId)` → deterministic string
2. **Keep-alive:** All tabs mounted, inactive hidden via `display: none` — no remount, scroll preserved
3. **URL sync:** Shell syncs URL ↔ active tab bidirectionally. `untrack()` prevents WS label update cascades
4. **Singletons:** `singleton: true` → `openTab` activates existing instead of duplicating
5. **Previews:** Single-click = preview (italic, temporary). Double-click or engagement = promote to permanent
6. **Label resolution:** `resolveLabel(entityId)` callback fetches from store (avoids circular imports)
7. **Entity validation:** Optional `validateEntity(entityId)` — checks if resource still exists, evicts stale tabs on startup

### Mention System

1. **Triggers:** `@` for users, `#` for entities/threads
2. **Detection:** ComposeBar walks contenteditable DOM looking for trigger chars
3. **Autocomplete:** `MentionAutocomplete` debounces 150ms, calls API, roving-focus selection
4. **Storage:** `<span data-mentionRef="@[Label](ref)">` — mention syntax preserved in DOM for serialization
5. **Extraction:** `getContent()` reads data attrs + text → reconstructs mention-syntax strings

### Composer Attachments

- **`StagedAttachmentChips`** (`src/modules/files/StagedAttachmentChips.tsx`) — Shared staged-attachment strip: shows files queued for send with an attach control, consumed by every composer.
- **Consumers:** `ComposeBar.tsx` (threads), `TicketComposer.tsx` (tickets), `MailCompose.tsx` and `MailReplyBar.tsx` (mail). A new composer should mount `StagedAttachmentChips` rather than building its own upload strip.

### WebSocket Event Dispatch

1. Shell creates WebSocket via `createWebSocket()`
2. Messages arrive as typed JSON (`event`, `presence_sync`, `sync`)
3. `dispatchWsEntityEvent()` and `dispatchWsMessage()` route to registry handlers
4. Handlers run by priority (0–100, lower first)
5. Context passed: `{ currentUserId, activeTabId, isDocumentVisible, isOwnAction }`

---

## App UI SDK (`@liaison/app-ui`)

Frontend SDK for app components that need to interact with the shell (open tabs, show toasts, etc.). Two bridge implementations support different trust tiers:

| Bridge | Function | Trust Tier | Mechanism |
|--------|----------|------------|-----------|
| **Direct** | `createDirectBridge(shell)` | Kernel / Trusted | Direct function calls into shell stores |
| **Iframe** | `createIframeBridge(channel)` | Sandboxed | `postMessage` JSON protocol across iframe boundary |

**`AppUIContext` interface:** `openTab(type, entityId, label?)`, `closeTab()`, `showToast(message, variant?)`

**Trust tiers** (architecture established, enforcement progressive):

| Tier | Runtime | Example |
|------|---------|---------|
| **Kernel** | Direct SolidJS components, full store access | Threads, Settings |
| **Trusted** | Direct components registered via manifest | First-party domain apps |
| **Sandboxed** | Iframe with postMessage bridge | Future third-party apps |

See `docs/app-sandbox.md` for full sandbox architecture details.

---

## Adding a New Frontend App

Every frontend app — kernel or domain — follows the same pattern: a domain module under `src/modules/`, registered via `registerApp()`. No changes to Shell, MainPanel, Sidebar, or ActivityBar are ever needed.

> **Manifest-format apps:** For apps whose views are declared in a backend manifest (rather than programmatically), use `registerAppFromManifest(manifest, uiExports)` instead. It auto-registers tab types, panels, activity bar entries, settings sections, commands, and keybindings from the manifest metadata. The `registerApp()` path below is for kernel and programmatic apps.

### 1. Create the domain module

```
src/modules/tickets/
  ticket-store.ts        # SolidJS store + onSessionTeardown(resetTicketStore)
  TicketView.tsx          # Main tab component (receives entityId as prop)
  TicketSidebar.tsx       # Sidebar shown when a ticket tab is active
  TicketList.tsx           # List component (used in sidebar or home)
```

### 2. Register the app

Kernel apps register from `framework/bootstrap.ts`. Programmatic domain apps register from a `<name>-app.ts` file inside their own module (see `modules/agent/agent-app.ts`); apps whose views are declared in a backend manifest instead go through `registerAppFromManifest()` (see the manifest note above), never a `framework/bootstrap-<app>.ts` file. Either way, call `registerApp()`:

```typescript
import { registerApp } from "~/framework/define-app"
import { lazy } from "solid-js"
import { Ticket } from "lucide-solid"

registerApp({
  name: "tickets",

  // Tab types — one entry per distinct view
  tabTypes: {
    ticket: {
      component: lazy(() => import("~/modules/tickets/TicketView")),
      sidebar: lazy(() => import("~/modules/tickets/TicketSidebar")),
      icon: Ticket,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      // Optional: resolve dynamic labels from store
      resolveLabel: (entityId) => getTicket(entityId)?.title,
      // Optional: validate entity still exists on tab rehydration
      validateEntity: async (entityId) => {
        const res = await fetch(apiUrl(`/tickets/${entityId}`), { ... })
        return res.status !== 404 && res.status !== 403
      },
    },
    // Singleton tab example (like Home or Settings)
    ticketBoard: {
      component: lazy(() => import("~/modules/tickets/TicketBoard")),
      sidebar: lazy(() => import("~/modules/tickets/TicketSidebar")),
      icon: Ticket,
      urlPattern: "/tickets",
      defaultLabel: "Tickets",
      singleton: true,   // Only one instance allowed
    },
  },

  // Activity bar icon — opens the first tab type by default
  activityBar: {
    icon: Ticket,
    label: "Tickets",
    order: 20,  // Position in the bar (kernel Home = 0, Settings = 1000)
    tabAction: { type: "ticketBoard", entityId: "tickets", label: "Tickets" },
  },

  // Settings sections (show up in Settings sidebar)
  settings: [
    {
      id: "sla",
      label: "SLA Targets",
      href: "/settings/tickets/sla",
      component: lazy(() => import("~/modules/tickets/TicketSlaSettings")),
      group: "admin",
      adminScope: "tickets:admin",
      order: 50,
    },
  ],

  // WebSocket entity handlers — called when server broadcasts entity events
  wsHandlers: {
    ticket: (action, data) => handleTicketEvent(action, data),
  },

  // Commands for the command palette (Cmd+P)
  commands: [
    {
      id: "new-ticket",
      label: "New Ticket",
      shortcut: "mod+shift+t",
      execute: () => openNewTicketDialog(),
    },
  ],

  // Keybindings (global keyboard shortcuts)
  keybindings: [
    { id: "focus-tickets", key: "mod+shift+t", label: "New ticket", handler: () => { ... } },
  ],

})
```

### 3. Checklist

| Step | What | Why |
|------|------|-----|
| Module dir | `src/modules/<name>/` | Colocate store + components + pages |
| Store teardown | `onSessionTeardown(resetStore)` | Clean logout, no stale state across sessions |
| `registerApp()` | In `bootstrap.ts` (kernel) or a `<name>-app.ts` inside the module (domain) | Registers all primitives with clean teardown |
| `lazy()` imports | All components in tab/settings registration | Code-split by default |
| No Shell edits | — | The registry drives Shell, MainPanel, Sidebar, ActivityBar |
| Props, not params | Components receive `entityId` as prop | Tab store is source of truth, not the URL |

### What you get for free

Once registered, the framework automatically handles:
- **Tab lifecycle** — open, close, reorder, persist to localStorage, rehydrate on reload
- **URL routing** — URL ↔ tab sync (both directions), deep-linking
- **Keep-alive rendering** — tab stays mounted when inactive, scroll position preserved
- **Activity bar** — icon appears at configured position, click opens/activates the tab
- **Sidebar** — swaps to your sidebar component when your tab is active
- **Command palette** — your commands appear in Cmd+P search
- **Keyboard shortcuts** — your keybindings are active globally
- **WebSocket dispatch** — your entity handlers fire on matching server events
- **Settings** — your sections appear in the settings sidebar with scope-gating
- **Clean teardown** — `unregisterApp()` removes everything (idempotent, used for hot-reload)

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_BASE` | `/api` | API endpoint prefix |
| `VITE_WS_BASE` | `/ws` | WebSocket endpoint |
