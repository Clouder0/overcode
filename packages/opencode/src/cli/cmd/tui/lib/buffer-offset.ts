export type OffsetPosition = {
  row: number
  col: number
}

export type OffsetToPosition = (offset: number) => OffsetPosition | null

export function getMaxOffset(offsetToPosition: OffsetToPosition) {
  let low = 0
  let high = 1

  while (offsetToPosition(high)) {
    low = high
    high *= 2
  }

  while (low + 1 < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (offsetToPosition(mid)) {
      low = mid
    } else {
      high = mid
    }
  }

  return low
}

export function getBufferEndOffset(editBuffer: { offsetToPosition: OffsetToPosition }) {
  return getMaxOffset((offset) => editBuffer.offsetToPosition(offset))
}
