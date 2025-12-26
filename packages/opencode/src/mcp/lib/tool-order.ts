export function sanitizeMcpName(input: string) {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function compareStrings(a: string, b: string) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export function compareMcpNames(a: string, b: string) {
  const as = sanitizeMcpName(a)
  const bs = sanitizeMcpName(b)

  const diff = compareStrings(as, bs)
  if (diff !== 0) return diff

  return compareStrings(a, b)
}

export function stableMcpToolOrder<T extends { name: string }>(tools: T[]) {
  const result = tools.slice()
  result.sort((a, b) => compareMcpNames(a.name, b.name))
  return result
}

export function mcpToolKey(clientName: string, toolName: string) {
  return `${sanitizeMcpName(clientName)}_${sanitizeMcpName(toolName)}`
}
