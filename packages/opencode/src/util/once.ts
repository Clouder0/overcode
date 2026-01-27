export namespace Once {
  const key = Symbol.for("opencode.once")

  type State = {
    seen: Set<string>
  }

  function state(): State {
    const existing = (globalThis as any)[key] as State | undefined
    if (existing) return existing
    const next: State = { seen: new Set<string>() }
    ;(globalThis as any)[key] = next
    return next
  }

  export function run(id: string, fn: () => void) {
    const s = state()
    if (s.seen.has(id)) return
    s.seen.add(id)
    fn()
  }
}
