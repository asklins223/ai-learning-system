import { extname } from 'node:path'

export interface ByteRange {
  readonly start: number
  readonly end: number
}

export interface AssetResponsePlan {
  readonly status: 200 | 206 | 416
  readonly headers: Readonly<Record<string, string>>
  readonly bodyRange: ByteRange | null
}

type ParsedRange =
  | { readonly kind: 'range'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' }

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Parses the one byte-range form supported by the local asset protocol.
 * Invalid, multipart, and out-of-bounds ranges are deliberately treated as
 * unsatisfiable so callers can return a deterministic 416 response.
 */
export function parseSingleByteRange(header: string, size: number): ParsedRange {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'unsatisfiable' }

  const match = /^bytes\s*=\s*([^\s,]+)\s*$/i.exec(header.trim())
  if (!match || size === 0) return { kind: 'unsatisfiable' }

  const rangeMatch = /^(\d*)-(\d*)$/.exec(match[1])
  if (!rangeMatch) return { kind: 'unsatisfiable' }

  const [, startText, endText] = rangeMatch
  if (startText === '' && endText === '') return { kind: 'unsatisfiable' }

  if (startText === '') {
    const suffixLength = parseNonNegativeInteger(endText)
    if (suffixLength === null || suffixLength === 0) return { kind: 'unsatisfiable' }

    return {
      kind: 'range',
      range: {
        start: Math.max(size - suffixLength, 0),
        end: size - 1
      }
    }
  }

  const start = parseNonNegativeInteger(startText)
  if (start === null || start >= size) return { kind: 'unsatisfiable' }

  if (endText === '') {
    return { kind: 'range', range: { start, end: size - 1 } }
  }

  const requestedEnd = parseNonNegativeInteger(endText)
  if (requestedEnd === null || requestedEnd < start) return { kind: 'unsatisfiable' }

  return {
    kind: 'range',
    range: { start, end: Math.min(requestedEnd, size - 1) }
  }
}

export function mimeTypeForPath(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function createAssetResponsePlan(
  method: 'GET' | 'HEAD',
  size: number,
  mimeType: string,
  rangeHeader: string | null
): AssetResponsePlan {
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mimeType
  }

  // RFC 9110 defines Range for GET. A HEAD response reports the metadata of
  // the corresponding full GET and never opens a file stream.
  if (method === 'HEAD' || rangeHeader === null) {
    return {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(size)
      },
      bodyRange: method === 'GET' && size > 0 ? { start: 0, end: size - 1 } : null
    }
  }

  const parsedRange = parseSingleByteRange(rangeHeader, size)

  if (parsedRange.kind === 'unsatisfiable') {
    return {
      status: 416,
      headers: {
        ...baseHeaders,
        'Content-Length': '0',
        'Content-Range': `bytes */${size}`
      },
      bodyRange: null
    }
  }

  const { start, end } = parsedRange.range

  return {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`
    },
    bodyRange: parsedRange.range
  }
}
