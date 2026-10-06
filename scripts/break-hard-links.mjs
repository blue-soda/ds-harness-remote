// Break hard links inside a package before publishing it.
//
// npm's packer stores two entries that share an inode as a tar hard link, and the
// registry refuses a tarball that contains one:
//
//   npm error 415 Unsupported Media Type - Hard link is not allowed
//
// pnpm links package files from its store, so a package that is also installed into a
// DSH profile can share inodes with that copy. Rewriting every file the package would
// publish gives each entry a fresh inode, which is what the registry needs.
//
// Usage: node scripts/break-hard-links.mjs [package-dir]
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const packageRoot = resolve(process.argv[2] ?? 'packages/plugin')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const listed = manifest.files ?? []

if (listed.length === 0) {
  console.error(`  ${packageRoot}/package.json declares no "files" list; nothing to do`)
  process.exit(1)
}

const collected = []
const walk = path => {
  const info = statSync(path)
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry))
    return
  }
  collected.push({ path, links: info.nlink })
}
for (const entry of listed) {
  const path = join(packageRoot, entry)
  if (existsSync(path)) walk(path)
}

let rewritten = 0
for (const file of collected) {
  if (file.links < 2) continue
  const staging = `${file.path}.hardlink-staging`
  copyFileSync(file.path, staging)
  unlinkSync(file.path)
  renameSync(staging, file.path)
  rewritten += 1
}

const shared = collected.filter(file => {
  try { return statSync(file.path).nlink > 1 } catch { return false }
})
console.log(`  ${packageRoot}: ${collected.length} published files, ${rewritten} rewritten, ${shared.length} still shared`)
for (const file of shared.slice(0, 10)) console.log(`    still shared: ${file.path}`)
process.exit(shared.length === 0 ? 0 : 1)
