export type LiveStatusTone = 'info' | 'success' | 'warning' | 'error';

export interface LiveStatusState {
  text: string;
  detail?: string;
  startedAt: number;
  tone?: LiveStatusTone;
  progress?: number;
}

type Subscriber = (state: LiveStatusState) => void;

export class LiveStatusTracker {
  private base: LiveStatusState | null = null;
  private overrides = new Map<string, LiveStatusState>();
  private subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    const current = this.currentState();
    if (current) {
      subscriber(current);
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  setBase(text: string, options?: { detail?: string }): void {
    const keepStart = this.base && this.base.text === text ? this.base.startedAt : Date.now();
    this.base = { text, detail: options?.detail, startedAt: keepStart };
    this.emit();
  }

  pushOverride(id: string, text: string, options?: { detail?: string; tone?: LiveStatusTone }): () => void {
    const existing = this.overrides.get(id);
    const startedAt = existing && existing.text === text ? existing.startedAt : Date.now();
    this.overrides.set(id, { text, detail: options?.detail, tone: options?.tone, startedAt });
    this.emit();
    return () => this.clearOverride(id);
  }

  clearOverride(id: string): void {
    this.overrides.delete(id);
    this.emit();
  }

  private currentState(): LiveStatusState | null {
    if (this.overrides.size) {
      const last = Array.from(this.overrides.values()).pop();
      if (last) return last;
    }
    return this.base;
  }

  private emit(): void {
    const state = this.currentState();
    if (!state) return;
    for (const sub of this.subscribers) {
      try {
        sub(state);
      } catch {
        // ignore subscriber errors
      }
    }
  }
}
