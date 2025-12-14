import type z from "zod"

export namespace JobRegistry {
  export interface Definition<
    TParams extends z.ZodType = z.ZodType,
    TInput extends z.ZodType = z.ZodType,
    TOutput extends z.ZodType = z.ZodType,
  > {
    name: string
    description: string | (() => Promise<string>)
    params: TParams
    input?: TInput
    output?: TOutput
    start(ctx: JobContext<TParams, TInput, TOutput>): Promise<void>
  }

  export interface JobContext<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType> {
    jobID: string
    sessionID: string
    params: z.infer<TParams>
    onInput(callback: (input: z.infer<TInput>) => void): () => void
    onSignal(callback: (signal: "abort") => void): () => void
    emit(output: z.infer<TOutput>): Promise<void>
    notify(output: z.infer<TOutput>): Promise<void>
    complete(output?: z.infer<TOutput>): Promise<void>
    fail(error: string): Promise<void>
    setMetadata(meta: Record<string, unknown>): Promise<void>
  }

  const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

  // Global registry - job definitions are global, not per-instance
  const registry = new Map<string, Definition>()

  export function define<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType>(
    name: string,
    config: Omit<Definition<TParams, TInput, TOutput>, "name">,
  ): Definition<TParams, TInput, TOutput> {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid job name "${name}": must match ${NAME_PATTERN}`)
    }

    if (registry.has(name)) {
      // Return existing definition if already registered (for hot reloading)
      return registry.get(name) as Definition<TParams, TInput, TOutput>
    }

    const definition: Definition<TParams, TInput, TOutput> = {
      name,
      ...config,
    }
    registry.set(name, definition as Definition)
    return definition
  }

  export function get(name: string): Definition | undefined {
    return registry.get(name)
  }

  export function list(): Definition[] {
    return Array.from(registry.values())
  }

  // For testing only - clears all registered definitions
  export function _clear(): void {
    registry.clear()
  }
}
