export function twice(input: { now: number; last: number; window: number }): { hit: boolean; next: number } {
  const within = input.last > 0 && input.now - input.last <= input.window
  if (within) return { hit: true, next: 0 }
  return { hit: false, next: input.now }
}
