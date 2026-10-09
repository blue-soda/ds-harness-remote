import { CodexRemoteDomain } from '../packages/plugin/src/codex/domain.js'
import { SafeLogger } from '../packages/plugin/src/logging.js'

const binary = process.argv[2]
const logger = new SafeLogger({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never)
const show = (label, domain) => console.log('  ' + label.padEnd(22) + JSON.stringify(domain.status()))

const enabled = { enabled: true, binary } as never

console.log('  enabled=true')
const domain = new CodexRemoteDomain(enabled, logger)
await domain.start()
show('start →', domain)
await domain.restart()
show('restart →', domain)
await domain.restart()
show('restart again →', domain)
await domain.close()
show('close →', domain)

console.log('  enabled=false')
const disabledDomain = new CodexRemoteDomain({ enabled: false, binary } as never, logger)
await disabledDomain.start()
show('start →', disabledDomain)
await disabledDomain.restart()
show('restart →', disabledDomain)
await disabledDomain.close()
process.exit(0)
