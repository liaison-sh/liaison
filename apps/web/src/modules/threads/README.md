# Chat Components

Thread and message UI. All components use stores from `~/stores/` for state and UI primitives from `~/components/ui/`.

## Key Components

| Component | Purpose |
|-----------|---------|
| **MessageList** | Renders messages with reactions, action toolbar, edit mode. Uses `ScrollFade` for container |
| **MessageComposer** | Input area with send, attachments, mentions |
| **ReactionPicker** | Emoji grid in a `PopupMenu` — hover grace auto-dismisses |
| **ThreadHeader** | Title, participants, archive/leave actions via `PopupMenu` |
| **ThreadSidebar** | Thread list in sidebar panel |

## Patterns

### Message action toolbar
Visible on hover, uses `activeMenu` signal to coordinate multiple menus (reaction picker + edit/delete). Only one menu open at a time per message row.

### Inline editing
`MessageList` manages edit state locally. Edit mode replaces the message body with an input, Escape cancels, Enter saves.

### Reactions
- Existing reactions render as pill buttons below the message (click to toggle)
- New reactions added via `ReactionPicker` in the action toolbar
- All reaction state flows through `message-store` + WebSocket events
