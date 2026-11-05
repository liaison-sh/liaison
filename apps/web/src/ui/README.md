# UI Components

Kobalte + Tailwind wrappers. **Always use these before reaching for raw Kobalte primitives or custom implementations.**

## Available Components

| Component | File | When to use |
|-----------|------|-------------|
| **Button** | `Button.tsx` | All clickable actions. Variants: `default`, `ghost`, `outline`, `primary`, `danger`. Sizes: `sm`, `md`, `lg` |
| **PopupMenu** | `PopupMenu.tsx` | Action menus and dropdown menus that should expose robust menu semantics and keyboard behavior |
| **FloatingPanel** | `FloatingPanel.tsx` | Non-menu floating UI like emoji pickers, toolbars, and custom panels with arbitrary interactive content |
| **Dialog** | `Dialog.tsx` | Modals, confirmations, forms requiring focus trap |
| **Input** | `Input.tsx` | Text inputs with consistent styling |
| **Tooltip** | `Tooltip.tsx` | Hover hints on icons/buttons |
| **Toggle** | `Toggle.tsx` | Binary on/off state buttons |
| **Switch** | `Switch.tsx` | Settings switches: the track and thumb control, opted out of the tier touch floor (the enclosing row carries the 44px tap area) |
| **Toast** | `Toast.tsx` | Transient notifications |
| **ScrollFade** | `ScrollFade.tsx` | Scrollable containers with fade edges |
| **Skeleton** | `Skeleton.tsx` | Loading placeholders |
| **AvatarStack** | `AvatarStack.tsx` | Overlapping user avatars |
| **DockedComposer** | `DockedComposer.tsx` | The root of every text input at the bottom of a surface (composers). `footer` (default): the last row of a full-height column, lifted above the native keyboard by the shell. `inline`: a composer inside a scrolling page, docked to the keyboard's top while typed in. Never write per-surface keyboard code |

## PopupMenu — for real menus

Use `PopupMenu` when the content is actually a list of actions.

### Controlled (coordinate with sibling menus)
```tsx
<PopupMenu open={isOpen()} onOpenChange={setIsOpen}>
  <PopupMenu.Trigger class="...">...</PopupMenu.Trigger>
  <PopupMenu.Content>
    <PopupMenu.Group>
      <PopupMenu.Label>Thread actions</PopupMenu.Label>
      <PopupMenu.Item onSelect={() => doThing()}>Action</PopupMenu.Item>
    </PopupMenu.Group>
    <PopupMenu.Separator />
    <PopupMenu.Item onSelect={handleDelete} variant="danger">Delete</PopupMenu.Item>
  </PopupMenu.Content>
</PopupMenu>
```

### Keyboard and accessibility guarantees
- Uses Kobalte `DropdownMenu` primitives for proper `menu` / `menuitem` semantics
- Supports built-in roving focus, arrow-key navigation, typeahead, escape handling, and focus restoration
- The menu name is anchored to the trigger, so icon-only triggers should always include an `aria-label`
- Use `PopupMenu.Group` + `PopupMenu.Label` when items belong to a labeled section

## FloatingPanel — for custom floating content

Use `FloatingPanel` when the content is not a true menu: emoji grids, search forms, inline management panels, or mixed controls.

### Uncontrolled (standalone, self-managing)
```tsx
<FloatingPanel.Uncontrolled trigger={<Icon />} triggerLabel="Open picker">
  <EmojiGrid />
</FloatingPanel.Uncontrolled>
```

### Key behaviors
- **Hover grace period**: `FloatingPanel` waits 300ms before closing — pointer can briefly leave and return without dismissing
- **Menu selection**: `PopupMenu.Item` closes via the underlying dropdown-menu primitive
- **Sections**: Use `PopupMenu.Label` for group headers, `PopupMenu.Separator` between groups

## Do NOT use raw Kobalte primitives

If `PopupMenu`, `Dialog`, `Tooltip`, etc. exist here — use them. They carry project-specific behavior (hover grace, consistent styling, accessibility). Only reach for raw `@kobalte/core/*` when building a **new** UI wrapper in this directory.
