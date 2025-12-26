export function sortPaths(paths: string[]) {
  const result = paths.slice()
  result.sort((a, b) => a.localeCompare(b))
  return result
}

export function sortEntries<T>(entries: Array<[string, T]>) {
  const result = entries.slice()
  result.sort(([a], [b]) => a.localeCompare(b))
  return result
}
