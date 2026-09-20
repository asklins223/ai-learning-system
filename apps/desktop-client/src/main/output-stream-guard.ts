/**
 * 主进程输出流保护（2026-09-20）。
 *
 * 用户实测：应用开了一段时间后弹出一个阻塞整个应用的模态框——
 * "A JavaScript error occurred in the main process / Uncaught Exception: Error: write EIO"，
 * 栈的落点是 `WebFrameMain.send → console.error → Writable.write → Socket._write`。
 * 即：Electron 在向一个已经销毁的 frame 投递时用它内部的 console.error 记一条，
 * 而那一刻启动它的终端/管道已经不在（EIO = 读端已消失），于是**写日志这个动作本身**
 * 抛了错。stdout 的 'error' 无人接管，Node 把它升级成主进程未捕获异常，
 * Electron 再用模态框停住整个应用。
 *
 * 结论：主进程不该因为"没人看日志"而死。真正要看的现场仍然在启动终端里
 * （如果它还在的话）；这里只保证这条流坏掉之后，应用继续跑。
 */

export type ErrorableOutputStream = {
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * 就地吞掉输出流的写失败。
 *
 * 刻意不区分错误码，也不尝试"报告"：读端已经消失，任何报告都只能再写同一条断流
 * （往另一条流写还会在两条流都坏掉时来回弹，所以连兜底转发也不做）。
 * 日志可以丢，主进程不能停。
 */
export function guardProcessOutputStreams(...streams: readonly ErrorableOutputStream[]): void {
  for (const stream of streams) {
    stream.on('error', () => undefined)
  }
}
