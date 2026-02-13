import { expect, test } from "bun:test"
import { computeTrimExcess } from "../../src/session/maintenance"

test("computeTrimExcess adds headroom for non-forced, non-recovering overage", () => {
  const target = 80_000
  const estimate = 82_000
  const base = estimate - target

  const excess = computeTrimExcess({
    usable: 100_000,
    estimate,
    target,
    forced: false,
    recovering: false,
    aggressive: false,
    min: 0,
  })

  expect(excess).toBeGreaterThan(base)
})

test("computeTrimExcess adds no headroom when forced", () => {
  const target = 80_000
  const estimate = 110_000
  const base = estimate - target

  const excess = computeTrimExcess({
    usable: 100_000,
    estimate,
    target,
    forced: true,
    recovering: false,
    aggressive: false,
    min: 0,
  })

  expect(excess).toBe(base)
})

test("computeTrimExcess adds no headroom when recovering", () => {
  const target = 80_000
  const estimate = 110_000
  const base = estimate - target

  const excess = computeTrimExcess({
    usable: 100_000,
    estimate,
    target,
    forced: false,
    recovering: true,
    aggressive: false,
    min: 0,
  })

  expect(excess).toBe(base)
})

test("computeTrimExcess headroom is bounded (min -> pct -> max)", () => {
  const base = 5_000
  const headroom = (target: number) =>
    computeTrimExcess({
      usable: 1_000_000,
      estimate: target + base,
      target,
      forced: false,
      recovering: false,
      aggressive: false,
      min: 0,
    }) - base

  const small = headroom(1_000)
  const mid = headroom(100_000)
  const huge = headroom(1_000_000)
  const huge2 = headroom(2_000_000)

  expect(small).toBeGreaterThan(0)
  expect(mid).toBeGreaterThan(small)
  expect(huge).toBeGreaterThanOrEqual(mid)
  expect(huge2).toBe(huge)
})
