import { describe, expect, it } from 'vitest'
import {
  createAssetResponsePlan,
  mimeTypeForPath,
  parseSingleByteRange
} from './asset-response'

describe('single byte range parsing', () => {
  it('parses bounded, open-ended, and suffix byte ranges', () => {
    expect(parseSingleByteRange('bytes=10-19', 100)).toEqual({
      kind: 'range',
      range: { start: 10, end: 19 }
    })
    expect(parseSingleByteRange('bytes=90-', 100)).toEqual({
      kind: 'range',
      range: { start: 90, end: 99 }
    })
    expect(parseSingleByteRange('bytes=-10', 100)).toEqual({
      kind: 'range',
      range: { start: 90, end: 99 }
    })
  })

  it('clamps ranges at both ends of the representation', () => {
    expect(parseSingleByteRange('bytes=95-200', 100)).toEqual({
      kind: 'range',
      range: { start: 95, end: 99 }
    })
    expect(parseSingleByteRange('bytes=-200', 100)).toEqual({
      kind: 'range',
      range: { start: 0, end: 99 }
    })
  })

  it.each([
    ['bytes=100-', 100],
    ['bytes=20-10', 100],
    ['bytes=-0', 100],
    ['bytes=0-1,4-5', 100],
    ['items=0-10', 100],
    ['bytes=-', 100],
    ['bytes=0-0', 0]
  ])('rejects an invalid or unsatisfiable range: %s', (header, size) => {
    expect(parseSingleByteRange(header, size)).toEqual({ kind: 'unsatisfiable' })
  })
})

describe('asset response planning', () => {
  it('returns full GET metadata and a stream range', () => {
    expect(createAssetResponsePlan('GET', 1024, 'video/mp4', null)).toEqual({
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Length': '1024'
      },
      bodyRange: { start: 0, end: 1023 }
    })
  })

  it('returns no body for HEAD and ignores Range as required by HTTP', () => {
    expect(createAssetResponsePlan('HEAD', 1024, 'video/mp4', 'bytes=0-99')).toEqual({
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/mp4',
        'Content-Length': '1024'
      },
      bodyRange: null
    })
  })

  it('returns correct partial-content metadata', () => {
    expect(createAssetResponsePlan('GET', 1024, 'video/webm', 'bytes=100-299')).toEqual({
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'video/webm',
        'Content-Length': '200',
        'Content-Range': 'bytes 100-299/1024'
      },
      bodyRange: { start: 100, end: 299 }
    })
  })

  it('returns an empty 200 response plan for an empty file', () => {
    expect(createAssetResponsePlan('GET', 0, 'text/plain', null)).toEqual({
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'text/plain',
        'Content-Length': '0'
      },
      bodyRange: null
    })
  })

  it('returns a standards-shaped 416 response', () => {
    expect(createAssetResponsePlan('GET', 1024, 'audio/mp4', 'bytes=1024-')).toEqual({
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/mp4',
        'Content-Length': '0',
        'Content-Range': 'bytes */1024'
      },
      bodyRange: null
    })
  })
})

describe('asset MIME types', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.WEBM', 'video/webm'],
    ['poster.webp', 'image/webp'],
    ['mask.svg', 'image/svg+xml; charset=utf-8'],
    ['manifest.json', 'application/json; charset=utf-8'],
    ['captions.vtt', 'text/vtt; charset=utf-8'],
    ['ambience.m4a', 'audio/mp4']
  ])('maps %s to %s', (filePath, mimeType) => {
    expect(mimeTypeForPath(filePath)).toBe(mimeType)
  })

  it('falls back to binary for unknown extensions', () => {
    expect(mimeTypeForPath('asset.unknown')).toBe('application/octet-stream')
  })
})
