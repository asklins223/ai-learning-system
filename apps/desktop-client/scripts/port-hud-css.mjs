/*
 * Ports the approved desktop-pages-v3 mockup stylesheet into the client.
 *
 * The mockup is the spatial contract for every business page, so the mockup's
 * own CSS is reused rather than re-derived: this script prefixes each selector
 * with the `.hud-surface` scope and renames the mockup's generic tokens onto
 * that scope, so nothing leaks into the existing room/task styling.
 *
 * Usage: node scripts/port-hud-css.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const mockupPath = resolve(appRoot, '../../.impeccable/review/desktop-pages-v3/mockup.html')
const outPath = resolve(appRoot, 'src/renderer/src/components/hud/hud-pages.css')

const SCOPE = '.hud-surface'

const html = await readFile(mockupPath, 'utf8')
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1])
if (!styles.length) throw new Error('mockup.html has no <style> block')
const source = styles.join('\n')

const DROP = [
  /^\s*html\s*,\s*body\s*,\s*#app\s*$/,
  /^\s*html\s*$/,
  /^\s*body\s*$/,
  /^\s*button\s*,\s*input\s*,\s*textarea\s*$/,
  /^\s*button\s*$/,
]

// The mockup references the review board's own asset tree; the client ships the
// same rasters under `public/assets/approved-v3` and `public/assets/learning-room`.
const ASSET_REWRITES = [
  [/url\("\.\.\/desktop-pages-v2\/assets\/environments\//g, 'url("/assets/approved-v3/environments/'],
  [/url\("\.\.\/home-v2-lighthouse-layer-sources-v1\/lighthouse-night-clean\.png"\)/g, 'url("/assets/learning-room/v1/layers/home-v2/lighthouse/lighthouse-night-d0-v1.png")'],
  [/url\("\.\.\/home-v2-lighthouse-day-v2\/home-v2-lighthouse-day-v2\.png"\)/g, 'url("/assets/learning-room/v1/layers/home-v2/lighthouse/lighthouse-day-d0-v1.png")'],
]

function isDropped(selector) {
  return DROP.some((pattern) => pattern.test(selector))
}

// Classes the mockup puts on `.scene` itself (page identity, theme, navigation
// and companion-side state) must compound with the scope, not descend from it.
const SCENE_STATE_PREFIXES = [
  '.night',
  '.bg-',
  '.page-',
  '.nav-collapsed',
  '.comp-left',
  '.no-comp',
  '.space-first',
  '.space-returning',
]

function isSceneState(compound) {
  return SCENE_STATE_PREFIXES.some((prefix) => compound.startsWith(prefix))
}

function scopeSelector(selector) {
  const trimmed = selector.trim()
  if (!trimmed) return null
  if (isDropped(trimmed)) return null
  if (trimmed === '*') return `${SCOPE}, ${SCOPE} *`
  if (trimmed === ':root') return SCOPE
  if (trimmed === '.scene') return SCOPE
  if (trimmed.startsWith('.scene')) return SCOPE + trimmed.slice('.scene'.length)

  return trimmed
    .split(',')
    .map((part) => {
      const piece = part.trim()
      if (!piece) return null
      if (piece.startsWith(SCOPE)) return piece
      const firstCompound = piece.split(/\s+/)[0]
      if (isSceneState(firstCompound)) return `${SCOPE}${piece}`
      return `${SCOPE} ${piece}`
    })
    .filter(Boolean)
    .join(', ')
}

/** Walks a flat CSS block and rewrites declaration-level selectors. */
function transformBlock(css, insideKeyframes = false) {
  let out = ''
  let index = 0
  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) {
      out += css.slice(index)
      break
    }
    const prelude = css.slice(index, open)
    const trimmedPrelude = prelude.trim()

    // Find the matching closing brace for this block.
    let depth = 1
    let cursor = open + 1
    while (cursor < css.length && depth > 0) {
      const char = css[cursor]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      cursor += 1
    }
    const body = css.slice(open + 1, cursor - 1)

    const leadingWhitespace = prelude.slice(0, prelude.length - prelude.trimStart().length)
    const isAtRule = trimmedPrelude.startsWith('@')

    if (isAtRule) {
      const name = trimmedPrelude.slice(1).split(/[\s({]/)[0].toLowerCase()
      if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
        out += `${leadingWhitespace}${trimmedPrelude}{${transformBlock(body)}}`
      } else if (name === 'keyframes' || name === 'font-face' || name.startsWith('-webkit-keyframes')) {
        out += `${leadingWhitespace}${trimmedPrelude}{${body}}`
      } else {
        out += `${leadingWhitespace}${trimmedPrelude}{${body}}`
      }
    } else {
      if (isDropped(trimmedPrelude)) {
        index = cursor
        continue
      }
      const rewritten = trimmedPrelude
        .split(',')
        .map((selector) => scopeSelector(selector))
        .filter(Boolean)
      out += rewritten.length
        ? `${leadingWhitespace}${rewritten.join(', ')}{${body}}`
        : ''
    }
    index = cursor
  }
  return out
}

// The mockup names its tokens generically (`--ink`, `--paper`, `--line`), which
// would shadow the client's own room tokens if the scope ever wrapped them.
// Every ported token therefore moves onto the `--hud-` namespace.
const TOKEN_RENAMES = [
  'line-strong',
  'paper-light',
  'paper-deep',
  'shadow-small',
  'ease-drawer',
  'ease-out',
  'ink',
  'soft',
  'paper',
  'line',
  'clay',
  'green',
  'blue',
  'star',
  'gold',
  'red',
  'shadow',
]

function renameTokens(css) {
  return TOKEN_RENAMES.reduce((accumulated, token) => {
    const pattern = new RegExp(`--${token}(?![\\w-])`, 'g')
    return accumulated.replace(pattern, `--hud-${token}`)
  }, css)
}

function rewriteAssets(css) {
  return ASSET_REWRITES.reduce((accumulated, [pattern, replacement]) => accumulated.replace(pattern, replacement), css)
}

const header = `/*
 * GENERATED FILE - do not edit by hand.
 * Source: .impeccable/review/desktop-pages-v3/mockup.html
 * Regenerate with: node apps/desktop-client/scripts/port-hud-css.mjs
 *
 * THESIS: the approved V3.1 mockups are the spatial contract for every
 * business page, so their stylesheet is ported verbatim under the
 * \`.hud-surface\` scope instead of being re-derived by hand.
 * OWN-WORLD: warm paper, cloth, mint/cream/peach Animal Crossing HUD cards on
 * the registered room plates.
 * STORY: entering a destination shows real working content immediately.
 */

`

const transformed = renameTokens(rewriteAssets(transformBlock(source)))
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, `${header}${transformed.trim()}\n`, 'utf8')
console.log(`ported ${outPath}`)
