import { AutomationError, type AutomationCapability } from '../../shared/automation'

/** All desktop side effects share a queue; stopping invalidates queued work too. */
export class AutomationGate {
  private generation = 0
  private pending = 0
  private tail: Promise<unknown> = Promise.resolve()
  private grants = new Map<string, number>()
  constructor(private readonly now = Date.now) {}
  get activeSessions(): number {
    for (const [key, expires] of this.grants) if (expires <= this.now()) this.grants.delete(key)
    return this.grants.size
  }
  stop(): void { this.generation++; this.grants.clear() }
  async run<T>(capability: AutomationCapability, owner: string, signal: AbortSignal, consent: () => Promise<boolean>, work: () => Promise<T>): Promise<T> {
    if (this.pending >= 8) throw new AutomationError('BUSY', 'Automation queue is full; retry after the current operation')
    const generation = this.generation
    const check = (): void => {
      signal.throwIfAborted()
      if (generation !== this.generation) throw new AutomationError('STOPPED', 'Automation was stopped; start a new operation to request authorization')
    }
    this.pending++
    const task = this.tail.catch(() => undefined).then(async () => {
      check()
      const key = `${capability}:${owner}`
      if ((this.grants.get(key) ?? 0) <= this.now()) {
        if (this.activeSessions >= 128) throw new AutomationError('BUSY', 'Too many active automation sessions; stop automation before granting another')
        if (!await consent()) throw new AutomationError('DENIED', 'The user declined automation access')
        check()
        this.grants.set(key, this.now() + 30 * 60_000)
      }
      check()
      return work()
    }).finally(() => { this.pending-- })
    this.tail = task
    return task
  }
}
