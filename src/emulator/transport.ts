import { CustomConnectionError, CustomTimeoutError } from '../errors';
import { buildFrame, parseRequest } from '../protocol/frame';
import { ITransport } from '../transports/transport.interface';
import { EmulatedPrinter, EmulatorReply } from './emulator';

/** Frame di risposta per un `EmulatorReply`: ERRnn oppure `0000` + dati. */
export function replyFrame(reply: EmulatorReply, counter: number): Buffer {
  const payload = reply.error !== undefined ? `ERR${String(reply.error).padStart(2, '0')}` : `0000${reply.data ?? ''}`;
  return buildFrame(payload, counter);
}

export interface EmulatorTransportOptions {
  /**
   * false (default): silenzi e ritardi oltre il timeout del client lo fanno scadere subito, senza attendere davvero.
   * true: attende i tempi reali.
   */
  realTime?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Trasporto in processo verso un `EmulatedPrinter`: nessun socket, utile nei test unitari di chi usa la libreria.
 * Rispetta i guasti iniettati (connessione che cade, risposta troncata, silenzio, ritardo).
 */
export class EmulatorTransport implements ITransport {
  private open = false;
  private inbox: Buffer[] = [];
  private peerClosed = false;
  private delayed: { ms: number; frame: Buffer } | null = null;
  private silent = false;
  /** Comandi ricevuti da questa connessione. */
  readonly sentCommands: string[] = [];

  constructor(
    readonly printer: EmulatedPrinter,
    private readonly options: EmulatorTransportOptions = {}
  ) {}

  async connect(): Promise<void> {
    this.open = true;
    this.peerClosed = false;
    this.inbox = [];
    this.delayed = null;
    this.silent = false;
  }

  async write(data: Buffer): Promise<void> {
    if (!this.open) throw new CustomConnectionError('Trasporto dell’emulatore non connesso');
    const request = parseRequest(data);
    this.sentCommands.push(request.command);
    const reply = this.printer.handle(request.command);
    const frame = replyFrame(reply, request.counter);
    const delivery = reply.delivery ?? 'normal';
    if (delivery === 'normal') this.inbox.push(frame);
    else if (delivery === 'close') this.peerClosed = true;
    else if (delivery === 'truncate') {
      this.inbox.push(frame.subarray(0, Math.ceil(frame.length / 2)));
      this.peerClosed = true;
    } else if (delivery === 'silence') this.silent = true;
    else this.delayed = { ms: delivery.delayMs, frame };
  }

  async read(timeoutMs: number): Promise<Buffer> {
    if (!this.open) throw new CustomConnectionError('Trasporto dell’emulatore non connesso');
    const timeout = async (): Promise<never> => {
      if (this.options.realTime) await sleep(timeoutMs);
      throw new CustomTimeoutError('Timeout lettura dall’emulatore', timeoutMs);
    };
    if (this.inbox.length > 0) return this.inbox.shift()!;
    if (this.delayed) {
      const { ms, frame } = this.delayed;
      if (ms > timeoutMs) return timeout();
      this.delayed = null;
      if (this.options.realTime) await sleep(ms);
      return frame;
    }
    if (this.peerClosed) {
      this.open = false;
      throw new CustomConnectionError('Connessione chiusa dalla stampante');
    }
    void this.silent;
    return timeout();
  }

  flush(): void {
    this.inbox = [];
  }

  async close(): Promise<void> {
    this.open = false;
    this.inbox = [];
  }

  isConnected(): boolean {
    return this.open;
  }
}
