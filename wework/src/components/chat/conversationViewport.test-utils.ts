export class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = []
  targets = new Set<Element>()
  readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ControlledResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  disconnect() {
    this.targets.clear()
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  static notify(target: Element, height = target.scrollHeight) {
    for (const observer of this.instances) {
      if (observer.targets.has(target)) {
        observer.callback(
          [{ target, contentRect: { height } } as ResizeObserverEntry],
          observer as unknown as ResizeObserver
        )
      }
    }
  }
}
