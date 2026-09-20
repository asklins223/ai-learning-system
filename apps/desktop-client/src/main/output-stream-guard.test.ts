import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { guardProcessOutputStreams } from './output-stream-guard'

/**
 * 这条弹窗的复现路径：stdout 的读端消失（终端关掉、管道被回收）之后，
 * 任何一次 console 写入都会让流 emit 'error'。没有监听者时 Node 直接把它抛成
 * 未捕获异常，Electron 就用模态框停住应用。EventEmitter 在这里正好复刻了这条
 * 语义：没有 'error' 监听者的 `emit('error')` 就是抛出。
 */

function outputFailure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('main-process output streams', () => {
  it('keeps a disconnected stdout from becoming an uncaught exception', () => {
    const stdout = new EventEmitter()
    const failure = outputFailure('write EIO', 'EIO')

    // 保护之前：这正是用户看到的那次崩溃。
    expect(() => stdout.emit('error', failure)).toThrow(failure)

    guardProcessOutputStreams(stdout)
    expect(() => stdout.emit('error', failure)).not.toThrow()
  })

  it('contains every write failure, not only the observed EIO', () => {
    const stderr = new EventEmitter()
    guardProcessOutputStreams(stderr)

    expect(() => stderr.emit('error', outputFailure('write EPIPE', 'EPIPE'))).not.toThrow()
    expect(() => stderr.emit('error', new Error('write ENOSPC'))).not.toThrow()
  })

  it('guards every stream it is given, not just the first', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    guardProcessOutputStreams(stdout, stderr)

    expect(() => stdout.emit('error', outputFailure('write EIO', 'EIO'))).not.toThrow()
    expect(() => stderr.emit('error', outputFailure('write EIO', 'EIO'))).not.toThrow()
  })
})
