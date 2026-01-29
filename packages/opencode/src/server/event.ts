import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export const Event = {
  Connected: BusEvent.define("server.connected", z.object({})),
  Heartbeat: BusEvent.define("server.heartbeat", z.object({})),
  Disposed: BusEvent.define("global.disposed", z.object({})),
}
