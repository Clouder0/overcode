Session recovery behaviors in Overcode, including how we handle interrupted runs that leave partial thinking.

---

## Orphan Thinking on Resume

### What happens

If Overcode is interrupted while a model is streaming output, the session history may contain an assistant message that only has thinking/reasoning parts and no final output.

On the next prompt (including after switching providers), Overcode:

- Preserves that thinking in the local transcript for inspection.
- Omits that thinking from the next model prompt.
- Marks the thinking block so you can clearly see what was omitted.

### Why

Some providers require every message to be non-empty. When switching providers, unsupported thinking/reasoning parts can be dropped by adapters, which would turn a thinking-only assistant message into an empty message and cause the request to fail.

We also avoid automatically replaying partial thinking across providers to reduce prompt noise and prevent unintended cross-provider leakage.

### How to tell what's omitted

In the TUI, omitted thinking blocks are labeled:

- `_Thinking (omitted when you continued):_`

They also show a distinct border color to indicate that they were not included in model context.

If thinking is hidden, toggle it on with:

- `/thinking`

### If you want to reuse the omitted thinking

You can manually copy relevant portions of the omitted thinking into your next user message.

This is intentional: Overcode avoids silently feeding partial thinking back into the prompt, but still lets you recover it when you choose.
