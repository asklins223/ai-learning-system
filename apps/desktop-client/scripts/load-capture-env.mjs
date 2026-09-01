import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')

// Keep capture scripts reproducible locally while allowing CI or an explicit
// shell environment to take precedence over the repository defaults.
loadDotenv({
  path: resolve(appRoot, '../../.env'),
  override: false,
})
