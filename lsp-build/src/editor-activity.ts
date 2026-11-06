/** Page visibility alone misses CSS-hidden parent iframes. IntersectionObserver
 * also accounts for clipping/hiding in the embedding document. */
export class EditorActivity {
  private intersecting = typeof IntersectionObserver === 'undefined'
  private last = false
  private listeners = new Set<(visible: boolean) => void>()
  private observer: IntersectionObserver | null = null
  private update = () => {
    const visible = this.visible
    if (visible === this.last) return
    this.last = visible
    for (const listener of this.listeners) listener(visible)
  }
  constructor(private readonly element: HTMLElement) {
    element.ownerDocument.addEventListener('visibilitychange', this.update)
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(([entry]) => { this.intersecting = entry.isIntersecting && entry.intersectionRatio > 0; this.update() })
      this.observer.observe(element)
    }
    this.last = this.visible
  }
  get visible() { return !this.element.ownerDocument.hidden && this.intersecting }
  onChange(listener: (visible: boolean) => void) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) } }
  whenVisible(): Promise<void> {
    if (this.visible) return Promise.resolve()
    return new Promise((resolve) => { const listener = this.onChange((visible) => { if (visible) { listener.dispose(); resolve() } }) })
  }
  dispose() { this.observer?.disconnect(); this.listeners.clear(); this.element.ownerDocument.removeEventListener('visibilitychange', this.update) }
}
