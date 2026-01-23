import { Context } from "../util/context"

export namespace ProviderRequestContext {
  type Value = {
    sessionID: string
  }

  const ctx = Context.create<Value>("provider-request")

  export function provide<R>(value: Value, fn: () => R) {
    return ctx.provide(value, fn)
  }

  export function get() {
    try {
      return ctx.use()
    } catch {
      return undefined
    }
  }
}
