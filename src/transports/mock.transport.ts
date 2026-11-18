import { ITransport } from './transport.interface';
import { buildFrame, parseRequest } from '../protocol/frame';

export type MockHandler = (command: string, counter: number) => { error?: number; data?: string };

export class MockTransport implements ITransport {
  private connected: boolean = false;
  private responseQueue: Buffer[] = [];
  public sentFrames: Buffer[] = [];
  public sentCommands: string[] = [];
  private customHandler: MockHandler | null = null;
  /** Contatore dell'ultima richiesta ricevuta: le risposte lo riecheggiano. */
  private lastCounter: number = 1;

  constructor(handler?: MockHandler) {
    if (handler) {
      this.customHandler = handler;
    }
  }

  setHandler(handler: MockHandler) {
    this.customHandler = handler;
  }

  queueResponse(rawBuffer: Buffer) {
    this.responseQueue.push(rawBuffer);
  }

  queueCommandResponse(command: string, counter: number, data: string = '', errorCode?: number) {
    const payload = errorCode ? `ERR${errorCode.toString().padStart(2, '0')}` : `0000${data}`;
    const frame = buildFrame(payload, counter);
    this.responseQueue.push(frame);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async write(data: Buffer): Promise<void> {
    if (!this.connected) {
      throw new Error('Mock transport non connesso');
    }

    this.sentFrames.push(data);
    const parsed = parseRequest(data);
    const cmd = parsed.command || '';
    this.lastCounter = parsed.counter;
    this.sentCommands.push(cmd);

    // Se c'è un handler personalizzato, genera risposta automatica
    if (this.customHandler) {
      const res = this.customHandler(cmd, parsed.counter);
      this.queueCommandResponse(cmd, parsed.counter, res.data || '', res.error);
    } else if (this.responseQueue.length === 0) {
      // Risposta generica positiva: 4 byte di stato '0000' + data vuota
      this.queueCommandResponse(cmd, parsed.counter, '');
    }
  }

  async read(timeoutMs: number = 1000): Promise<Buffer> {
    if (!this.connected) {
      throw new Error('Mock transport non connesso');
    }

    if (this.responseQueue.length > 0) {
      return this.responseQueue.shift()!;
    }

    // Se vuota, genera risposta positiva che riecheggia il contatore dell'ultima richiesta
    return buildFrame('0000', this.lastCounter);
  }

  /** Il mock non bufferizza byte di rete: le risposte accodate dai test restano disponibili. */
  flush(): void {}

  async close(): Promise<void> {
    this.connected = false;
    this.responseQueue = [];
    this.sentFrames = [];
    this.sentCommands = [];
  }

  isConnected(): boolean {
    return this.connected;
  }
}
