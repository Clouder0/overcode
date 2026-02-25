import { Resource } from "sst"
import { defineConfig } from "drizzle-kit"

const raw = process.env.DRIZZLE_SSL_REJECT_UNAUTHORIZED?.toLowerCase()
const rejectUnauthorized = raw ? !(raw === "0" || raw === "false") : true

export default defineConfig({
  out: "./migrations/",
  strict: true,
  schema: ["./src/**/*.sql.ts"],
  verbose: true,
  dialect: "mysql",
  dbCredentials: {
    database: Resource.Database.database,
    host: Resource.Database.host,
    user: Resource.Database.username,
    password: Resource.Database.password,
    port: Resource.Database.port,
    ssl: {
      rejectUnauthorized,
    },
  },
})
