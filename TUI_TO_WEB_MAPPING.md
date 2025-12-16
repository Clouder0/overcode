# TUI to Web Component Mapping Guide

This guide provides a comprehensive mapping between TUI (Terminal User Interface) components and their web equivalents, focusing on translating terminal-specific patterns to web technologies.

## 1. Rendering Primitives

### TUI Box → HTML Elements

| TUI Component      | Web Equivalent                       | Notes                                          |
| ------------------ | ------------------------------------ | ---------------------------------------------- |
| `<box>`            | `<div>`                              | Primary layout container, maps to flexbox/grid |
| `<text>`           | `<span>` or text content             | Inline text rendering                          |
| `<scrollbox>`      | `<div>` with `overflow: auto/scroll` | Scrollable content area                        |
| `<input>`          | `<input type="text">`                | Text input fields                              |
| `<textarea>`       | `<textarea>`                         | Multi-line text input                          |
| `backgroundColor`  | `background-color` CSS               | Direct CSS property mapping                    |
| `fg` (foreground)  | `color` CSS                          | Text color mapping                             |
| `border`           | `border` CSS                         | Border styling                                 |
| `padding`/`margin` | `padding`/`margin` CSS               | Spacing properties                             |

### Layout Properties

| TUI Property              | Web Equivalent              | Example               |
| ------------------------- | --------------------------- | --------------------- |
| `flexDirection="row"`     | `flex-direction: row`       | Row layout            |
| `flexDirection="column"`  | `flex-direction: column`    | Column layout         |
| `flexGrow={1}`            | `flex: 1` or `flex-grow: 1` | Grow to fill space    |
| `flexShrink={0}`          | `flex-shrink: 0`            | Don't shrink          |
| `justifyContent="center"` | `justify-content: center`   | Horizontal centering  |
| `alignItems="center"`     | `align-items: center`       | Vertical centering    |
| `gap={1}`                 | `gap: 0.25rem`              | Spacing between items |
| `position="absolute"`     | `position: absolute`        | Absolute positioning  |

## 2. Component Mapping

### Core Components

#### TUI Dialog → Web Dialog

```tsx
// TUI
<Dialog onClose={handleClose}>
  <text>Title</text>
  <button onClick={action}>OK</button>
</Dialog>

// Web
<Dialog title="Title" onOpenChange={(open) => !open && handleClose()}>
  <Dialog.Body>
    <Button onClick={action}>OK</Button>
  </Dialog.Body>
</Dialog>
```

#### TUI DialogAlert → Web Dialog with Alert

```tsx
// TUI
<DialogAlert title="Warning" message="Are you sure?" onConfirm={handleConfirm} />

// Web
<Dialog>
  <Dialog.Title>Warning</Dialog.Title>
  <Dialog.Description>Are you sure?</Dialog.Description>
  <Dialog.Actions>
    <Button onClick={handleConfirm}>OK</Button>
  </Dialog.Actions>
</Dialog>
```

#### TUI DialogSelect → Web Select

```tsx
// TUI
<DialogSelect
  options={options}
  onSelect={handleSelect}
  placeholder="Choose..."
/>

// Web
<Select
  options={options}
  onSelect={handleSelect}
  placeholder="Choose..."
/>
```

#### TUI DialogPrompt → Web TextField

```tsx
// TUI
<DialogPrompt
  title="Enter value"
  placeholder="Type here..."
  onConfirm={handleConfirm}
/>

// Web
<Dialog>
  <Dialog.Title>Enter value</Dialog.Title>
  <TextField
    placeholder="Type here..."
    onKeyUp={(e) => e.key === 'Enter' && handleConfirm(e.currentTarget.value)}
  />
</Dialog>
```

#### TUI Toast → Web Toast

```tsx
// TUI
;<Toast message="Operation complete" variant="success" />

// Web
showToast({
  description: "Operation complete",
  variant: "success",
})
```

#### TUI Spinner → Web Spinner

```tsx
// TUI - Uses Knight Rider style with ASCII characters
<spinner />

// Web - SVG-based animation
<Spinner />
```

### Interactive Elements

#### TUI Button → Web Button

```tsx
// TUI
<box onMouseUp={handleClick} backgroundColor={theme.primary}>
  <text>Click me</text>
</box>

// Web
<Button onClick={handleClick} variant="primary">
  Click me
</Button>
```

#### TUI Input → Web TextField

```tsx
// TUI
<input
  placeholder="Enter text"
  onInput={handleInput}
  focusedBackgroundColor={theme.backgroundPanel}
/>

// Web
<TextField
  placeholder="Enter text"
  onInput={handleInput}
/>
```

## 3. Color and Theming Translation

### Terminal Colors to CSS Variables

| TUI Color System   | Web CSS Variables              | Example                   |
| ------------------ | ------------------------------ | ------------------------- |
| `theme.primary`    | `var(--icon-interactive-base)` | Primary interactive color |
| `theme.background` | `var(--background-base)`       | Main background           |
| `theme.text`       | `var(--text-base)`             | Primary text color        |
| `theme.textMuted`  | `var(--text-weak)`             | Muted text                |
| `theme.success`    | `var(--icon-success-base)`     | Success state             |
| `theme.error`      | `var(--icon-critical-base)`    | Error state               |
| `theme.warning`    | `var(--icon-warning-base)`     | Warning state             |

### Theme Translation Pattern

```typescript
// TUI Theme Structure
interface ThemeColors {
  primary: RGBA
  background: RGBA
  text: RGBA
  textMuted: RGBA
  // ... more colors
}

// Web CSS Variables (from theme.css)
:root {
  --icon-interactive-base: #5b91f3;
  --background-base: #f8f7f7;
  --text-base: #1a1a1a;
  --text-weak: #8a8a8a;
}
```

## 4. Event Handling Translation

### Terminal Events → DOM Events

| TUI Event                        | Web Event              | Implementation        |
| -------------------------------- | ---------------------- | --------------------- |
| `onMouseUp`                      | `onClick`              | Primary click handler |
| `onMouseOver`                    | `onMouseEnter`         | Hover events          |
| Keyboard input via `useKeyboard` | `onKeyDown`, `onKeyUp` | Keyboard events       |
| Terminal resize                  | `window.resize`        | Viewport changes      |
| Focus management                 | `focus`, `blur` events | Focus handling        |

### Example: Keyboard Navigation

```tsx
// TUI
useKeyboard((evt) => {
  if (evt.name === "escape") dialog.clear()
  if (evt.name === "return") submit()
})

// Web
useKeyDown((e) => {
  if (e.key === "Escape") dialog.clear()
  if (e.key === "Enter") submit()
})
```

## 5. Terminal-Specific Features → Web Equivalents

### Selection and Copy

```tsx
// TUI - Terminal selection with OSC52
onMouseUp={async () => {
  const text = renderer.getSelection()?.getSelectedText()
  if (text) {
    const osc52 = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`
    await Clipboard.copy(text)
  }
}}

// Web - Clipboard API
onClick={async () => {
  await navigator.clipboard.writeText(text)
}}
```

### Terminal Dimensions → Viewport

```tsx
// TUI
const dimensions = useTerminalDimensions()

// Web
const dimensions = createSignal({
  width: window.innerWidth,
  height: window.innerHeight,
})

useEffect(() => {
  const handleResize = () => {
    setDimensions({
      width: window.innerWidth,
      height: window.innerHeight,
    })
  }
  window.addEventListener("resize", handleResize)
  return () => window.removeEventListener("resize", handleResize)
}, [])
```

## 6. Component Library Mapping

### Existing Web Components Ready for Use

| TUI Pattern        | Available Web Component | Notes                            |
| ------------------ | ----------------------- | -------------------------------- |
| ✅ Dialog          | `Dialog`                | Fully implemented with overlay   |
| ✅ Button          | `Button`                | Multiple variants available      |
| ✅ Input/TextField | `TextField`             | With validation and copy support |
| ✅ Select/Dropdown | `Select`                | With search and grouping         |
| ✅ Toast           | `Toast`                 | With `showToast()` helper        |
| ✅ Spinner         | `Spinner`               | SVG animation ready              |
| ✅ Tooltip         | `Tooltip`               | Hover tooltips                   |
| ✅ Card            | `Card`                  | Container component              |
| ✅ Icon            | `Icon`                  | SVG icon system                  |
| ❌ ScrollBox       | Use CSS overflow        | Implement with `overflow: auto`  |
| ❌ Box             | Use `<div>`             | Implement with flexbox utilities |

## 7. Styling Translation Guide

### Layout Translation

```css
/* TUI flex layout */
.box {
  display: flex;
  flex-direction: row; /* flexDirection="row" */
  align-items: center; /* alignItems="center" */
  gap: 0.25rem; /* gap={1} */
  padding: 0.5rem; /* paddingLeft={2} paddingRight={2} */
}
```

### Color Translation

```css
/* TUI theme colors */
.tui-button {
  background-color: var(--icon-interactive-base); /* theme.primary */
  color: var(--icon-invert-base); /* theme.selectedListItemText */
  border: 1px solid var(--border-base); /* theme.border */
}

.tui-button:hover {
  background-color: var(--icon-interactive-hover);
}
```

## 8. Animation Translation

### TUI Frame-based → Web CSS Animations

```tsx
// TUI - Frame-based spinner
const frames = ["⬝", "■", "■", "⬝"]
const [frame, setFrame] = createSignal(0)

// Web - CSS animation
.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

## 9. Data Flow Patterns

### TUI Stores → Web State Management

```tsx
// TUI - SolidJS stores with useKeyboard
const [store, setStore] = createStore({ selected: 0 })
useKeyboard((evt) => {
  if (evt.name === "down") setStore("selected", (s) => s + 1)
})

// Web - SolidJS stores with event handlers
const [store, setStore] = createStore({ selected: 0 })
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === "ArrowDown") setStore("selected", (s) => s + 1)
}
```

## 10. Implementation Examples

### Complete Component Translation

#### TUI Select Component

```tsx
export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const filtered = createMemo(() =>
    pipe(
      props.options,
      filter((x) => x.disabled !== true),
    ),
  )

  useKeyboard((evt) => {
    if (evt.name === "up") move(-1)
    if (evt.name === "down") move(1)
    if (evt.name === "return") select()
  })

  return (
    <box>
      <scrollbox>
        <For each={filtered()}>
          {(option) => (
            <box onMouseUp={() => select(option)}>
              <text>{option.title}</text>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
```

#### Web Select Component

```tsx
export function Select<T>(props: SelectProps<T>) {
  const filtered = createMemo(() =>
    pipe(
      props.options,
      filter((x) => x.disabled !== true),
    ),
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") move(-1)
    if (e.key === "ArrowDown") move(1)
    if (e.key === "Enter") select()
  }

  return (
    <div onKeyDown={handleKeyDown}>
      <div style={{ overflow: "auto", maxHeight: "300px" }}>
        <For each={filtered()}>{(option) => <div onClick={() => select(option)}>{option.title}</div>}</For>
      </div>
    </div>
  )
}
```

## 11. Migration Checklist

### For Each TUI Component:

- [ ] Map `<box>` to appropriate HTML element (`<div>`, `<span>`, etc.)
- [ ] Convert TUI layout props to CSS flexbox/grid
- [ ] Replace `backgroundColor`/`fg` with CSS variables
- [ ] Convert `useKeyboard` to DOM event handlers
- [ ] Replace terminal-specific mouse events with DOM events
- [ ] Map TUI theme colors to CSS custom properties
- [ ] Convert TUI animations to CSS animations
- [ ] Replace TUI scroll containers with CSS overflow
- [ ] Test responsive behavior vs terminal dimensions

### For the Application:

- [ ] Establish CSS theme system using existing variables
- [ ] Set up global state management patterns
- [ ] Implement responsive design principles
- [ ] Add accessibility features (ARIA, keyboard navigation)
- [ ] Test cross-browser compatibility

## 12. Best Practices

1. **Use Existing Web Components**: Leverage the existing UI library components instead of rebuilding
2. **CSS Variable Consistency**: Use the established color system from `theme.css`
3. **Accessibility First**: Add proper ARIA labels and keyboard navigation
4. **Responsive Design**: Consider different screen sizes, not terminal dimensions
5. **Progressive Enhancement**: Ensure functionality without JavaScript where possible
6. **Performance**: Use CSS animations over JavaScript for smooth transitions
7. **Component Composition**: Build complex components from simple, reusable ones

## 13. Common Patterns

### Modal Pattern

```tsx
// TUI Pattern
<Dialog onClose={close}>
  <text>Title</text>
  <box gap={1}>
    <button onClick={action}>Confirm</button>
    <button onClick={close}>Cancel</button>
  </box>
</Dialog>

// Web Pattern
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <Dialog.Title>Title</Dialog.Title>
  <Dialog.Body>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <Button onClick={action}>Confirm</Button>
      <Button variant="ghost" onClick={close}>Cancel</Button>
    </div>
  </Dialog.Body>
</Dialog>
```

### Form Pattern

```tsx
// TUI Pattern
<box gap={1}>
  <text>Title</text>
  <input onInput={setInput} placeholder="Enter..." />
  <button onClick={submit}>Submit</button>
</box>

// Web Pattern
<div style={{ display: 'flex', 'flex-direction': 'column', gap: '0.25rem' }}>
  <TextField label="Title" />
  <TextField placeholder="Enter..." onInput={setInput} />
  <Button onClick={submit}>Submit</Button>
</div>
```

This mapping guide provides the foundation for translating TUI components to web equivalents while maintaining functionality, styling consistency, and user experience patterns.
