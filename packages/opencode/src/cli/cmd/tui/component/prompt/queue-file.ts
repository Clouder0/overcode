import path from "path"
import { Global } from "@/global"

export function promptQueueFilePath(input?: { state?: string; pid?: number }) {
  const state = input?.state ?? Global.Path.state
  const pid = input?.pid ?? process.pid
  return path.join(state, `prompt-queue.${pid}.jsonl`)
}
