export function key(serverID: string, root: string) {
  return `${serverID}\0${root}`
}
