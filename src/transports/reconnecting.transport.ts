import { ITransport } from './transport.interface';
import { CustomTimeoutError } from '../errors';

export interface ReconnectOptions {
  /** Attesa iniziale tra due tentativi, in ms (default: 500; raddoppia a ogni tentativo, con jitter). */
  baseDelayMs?: number;
  /** Attesa massima tra due tentativi, in ms (default: 15000). */
  maxDelayMs?: number;
  /** Tentativi per ogni riconnessione prima di arrendersi (default: 5). */
  attempts?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Decorator di `ITransport` che riapre il canale quando è caduto o quando una lettura è scaduta.
 *
 * Regola di sicurezza: si riconnette solo PRIMA di scrivere un comando, mai nel mezzo di uno scambio e mai
 * rigiocando un comando già inviato. Dopo un timeout di lettura il canale è considerato sospetto (peer sparito,
 * risposte in ritardo): il comando successivo riparte da una connessione nuova e senza byte residui.
 */
export class ReconnectingTransport implements ITransport {
  private connecting: Promise<void> | null = null;
  private stale = false;
  private closedByUser = false;
  /** Canale logico aperto con `connect()`: resta vero anche se il socket sotto è caduto (si riapre da solo). */
  private opened = false;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly attempts: number;

  /**
   * @param inner Trasporto reale (TCP, seriale, ...).
   * @param onReconnect Chiamata dopo una riconnessione riuscita che sostituisce un canale caduto o sospetto
   *   (non alla prima connessione): lo stato del documento sulla stampante va riletto.
   */
  constructor(
    private readonly inner: ITransport,
    options: ReconnectOptions = {},
    private readonly onReconnect?: () => void
  ) {
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.attempts = Math.max(1, options.attempts ?? 5);
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return this.ensure(false).then(() => {
      this.opened = true;
    });
  }

  private ensure(isReconnect: boolean): Promise<void> {
    if (this.inner.isConnected() && !this.stale) return Promise.resolve();
    this.connecting ??= this.dial(isReconnect || this.stale).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async dial(replacing: boolean): Promise<void> {
    let delay = this.baseDelayMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.inner.close().catch(() => undefined); // scarta il canale morto e i byte in ritardo
        await this.inner.connect();
        this.stale = false;
        if (replacing) this.onReconnect?.();
        return;
      } catch (e) {
        if (this.closedByUser || attempt >= this.attempts) throw e;
        await sleep(delay * (0.5 + Math.random() / 2));
        delay = Math.min(delay * 2, this.maxDelayMs);
      }
    }
  }

  async write(data: Buffer): Promise<void> {
    if (this.closedByUser) throw new Error('Trasporto chiuso');
    await this.ensure(true);
    return this.inner.write(data);
  }

  async read(timeoutMs: number): Promise<Buffer> {
    try {
      return await this.inner.read(timeoutMs);
    } catch (e) {
      if (e instanceof CustomTimeoutError) this.stale = true;
      throw e;
    }
  }

  flush(): void {
    this.inner.flush?.();
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    this.opened = false;
    this.stale = false;
    await this.inner.close();
  }

  /** true dopo `connect()` finché non si chiama `close()`: un socket caduto si riapre al comando successivo. */
  isConnected(): boolean {
    return this.opened;
  }
}
