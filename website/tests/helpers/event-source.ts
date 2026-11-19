/** In-memory transport only; the production React stream hook runs unmodified. */
export class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    super();
    TestEventSource.instances.push(this);
  }

  open() {
    this.onopen?.(new Event('open'));
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  emit(name: string, payload: unknown) {
    this.raw(name, JSON.stringify(payload));
  }

  // Allow queued events after close so generation/terminal guards can be tested.
  raw(name: string, data: string) {
    this.dispatchEvent(new MessageEvent(name, { data }));
  }

  close() {
    this.closed = true;
  }
}
