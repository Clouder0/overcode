export function computeTrimExcess(input: {
  usable: number
  estimate: number
  target: number
  forced?: boolean
  recovering?: boolean
  aggressive?: boolean
  min?: number
}) {
  const forced = input.forced === true
  const recovering = input.recovering === true
  const aggressive = input.aggressive === true

  const over = input.estimate - input.target
  const base = over > 0 ? over : 0
  const signal = typeof input.min === "number" && input.min > 0 ? input.min : 0

  // Add some extra slack in the common path to avoid repeatedly trimming/compacting
  // on tiny overages from estimation jitter.
  const headroom = (() => {
    if (base <= 0) return 0
    if (forced) return 0
    if (recovering) return 0

    const min = 250
    const pct = 0.02
    const max = 4_000
    return Math.min(max, Math.max(min, Math.floor(input.target * pct)))
  })()

  const forcedMin = forced ? Math.max(500, Math.floor(input.target * 0.05)) : 0
  const baseline = forced ? Math.max(base, forcedMin) : base + headroom

  const floor =
    recovering && base > 0
      ? Math.min(30_000, Math.max(2_000, Math.floor(input.usable * (aggressive ? 0.08 : 0.04))))
      : 0

  return Math.max(baseline, signal, floor)
}
