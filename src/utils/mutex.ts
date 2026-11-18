/**
 * Mutex asincrono basato su promise (coda FIFO).
 * Garantisce che una sola sezione critica alla volta sia in esecuzione.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  /** Numero di acquisizioni in corso o in coda. */
  private pending = 0;

  /** true se il lock e' preso o ci sono richieste in coda. */
  get isLocked(): boolean {
    return this.pending > 0;
  }

  /**
   * Acquisisce il lock solo se e' libero e senza coda; altrimenti restituisce `null` senza attendere.
   */
  async tryAcquire(): Promise<(() => void) | null> {
    if (this.pending > 0) return null;
    return this.acquire();
  }

  /**
   * Acquisisce il lock. Restituisce la funzione di rilascio (idempotente).
   */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.pending++;
    this.tail = prev.then(() => next);
    return prev.then(() => {
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.pending--;
          release();
        }
      };
    });
  }

  /**
   * Esegue `fn` in mutua esclusione; il lock viene sempre rilasciato (anche in caso di errore).
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
