import { RotatingLog } from '../runtime/rotating-log.js'

const EARLY_LINE_LIMIT = 2_000
const PARTIAL_LINE_FLUSH_MS = 250

type LogStream = 'stdout' | 'stderr'

interface LogLine {
  stream: LogStream
  text: string
}

export interface MainProcessOutputStream {
  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
}

/**
 * Mirrors main process stdout and stderr into the desktop log directory.
 *
 * The Electron main process reports startup progress and startup failures only to its
 * stdio streams. A packaged app started from a desktop shortcut has no attached console,
 * so a stalled or failed launch leaves no evidence on disk. Lines are buffered in memory
 * until {@link MainProcessLog.persistTo} learns the log directory and then appended with
 * rotation and credential redaction, so everything printed from process start onwards
 * survives. Recording never blocks the caller and degrades to plain stdio if the log file
 * cannot be written.
 */
export class MainProcessLog {
  private sink: RotatingLog | null = null
  private buffered: LogLine[] = []
  private droppedLines = 0
  private partial: Record<LogStream, string> = { stdout: '', stderr: '' }
  private partialTimer: NodeJS.Timeout | null = null
  private installed = false
  private disabled = false

  install(
    stdout: MainProcessOutputStream = process.stdout,
    stderr: MainProcessOutputStream = process.stderr
  ): void {
    if (this.installed) return
    this.installed = true
    stdout.write = this.mirror('stdout', stdout)
    stderr.write = this.mirror('stderr', stderr)
  }

  persistTo(path: string): void {
    if (this.sink || this.disabled) return
    this.sink = new RotatingLog({ path })
    this.flushPartialLines()
    const buffered = this.buffered
    this.buffered = []
    for (const line of buffered) this.append(line)
    if (this.droppedLines > 0) {
      this.append({ stream: 'stderr', text: `dropped ${this.droppedLines} buffered lines` })
      this.droppedLines = 0
    }
  }

  async flush(): Promise<void> {
    this.flushPartialLines()
    await this.sink?.flush().catch(() => this.disableRecording())
  }

  private mirror(
    stream: LogStream,
    target: MainProcessOutputStream
  ): MainProcessOutputStream['write'] {
    const original = target.write.bind(target) as (...args: unknown[]) => boolean
    return ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      this.capture(stream, chunk)
      return original(chunk, ...rest)
    }) as MainProcessOutputStream['write']
  }

  private capture(stream: LogStream, chunk: string | Uint8Array): void {
    if (this.disabled) return
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const segments = `${this.partial[stream]}${text}`.split('\n')
    this.partial[stream] = segments.pop() ?? ''
    for (const segment of segments) this.enqueue(stream, segment)
    this.schedulePartialLineFlush()
  }

  private schedulePartialLineFlush(): void {
    if (this.partialTimer) return
    if (!this.partial.stdout && !this.partial.stderr) return
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null
      this.flushPartialLines()
    }, PARTIAL_LINE_FLUSH_MS)
    this.partialTimer.unref()
  }

  private flushPartialLines(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = this.partial[stream]
      this.partial[stream] = ''
      if (text) this.enqueue(stream, text)
    }
  }

  private enqueue(stream: LogStream, text: string): void {
    if (this.disabled) return
    const line = { stream, text }
    if (this.sink) {
      this.append(line)
      return
    }
    if (this.buffered.length >= EARLY_LINE_LIMIT) {
      this.buffered.shift()
      this.droppedLines += 1
    }
    this.buffered.push(line)
  }

  private append(line: LogLine): void {
    const sink = this.sink
    if (!sink) return
    void sink.write(line.stream, line.text).catch(() => this.disableRecording())
  }

  private disableRecording(): void {
    this.disabled = true
    this.sink = null
    this.buffered = []
    this.droppedLines = 0
    this.partial = { stdout: '', stderr: '' }
    if (this.partialTimer) clearTimeout(this.partialTimer)
    this.partialTimer = null
  }
}

let activeLog: MainProcessLog | null = null

export function mainProcessLog(): MainProcessLog {
  activeLog ??= new MainProcessLog()
  return activeLog
}

/**
 * Starts mirroring main process stdout and stderr. Install this before any other module
 * can print startup diagnostics.
 */
export function installMainProcessLogCapture(): void {
  mainProcessLog().install()
}
