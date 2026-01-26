#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const { binaries } = await import("./build.ts")
{
  const platform = process.platform === "win32" ? "windows" : process.platform
  const prefix = `${pkg.name}-${platform}-${process.arch}`
  const name = Object.keys(binaries).find((key) => key === prefix || key.startsWith(prefix + "-"))
  if (!name) {
    throw new Error(`unable to find build output for ${prefix}`)
  }
  console.log(`smoke test: running dist/${name}/bin/overcode --version`)
  await $`./dist/${name}/bin/overcode --version`
}

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      bin: {
        overcode: "./bin/overcode",
      },
      version: Script.version,
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tags = [Script.channel]
const dry = process.env.NPM_PUBLISH_DRY_RUN === "true"

const tasks = Object.entries(binaries).map(async ([name]) => {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  for (const tag of tags) {
    await (
      dry
        ? $`npm publish *.tgz --access public --tag ${tag} --dry-run`.cwd(`./dist/${name}`)
        : $`npm publish *.tgz --access public --tag ${tag}`.cwd(`./dist/${name}`)
    )
  }
})
await Promise.all(tasks)
for (const tag of tags) {
  await $`cd ./dist/${pkg.name} && bun pm pack`
  await (
    dry
      ? $`cd ./dist/${pkg.name} && npm publish *.tgz --access public --tag ${tag} --dry-run`
      : $`cd ./dist/${pkg.name} && npm publish *.tgz --access public --tag ${tag}`
  )
}
