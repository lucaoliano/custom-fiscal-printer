import * as net from 'net';
import { ITransport } from './transport.interface';
import { CustomConnectionError, CustomTimeoutError } from '../errors';
import { FrameReader } from './frame-buffer';

/** Intervallo del keep-alive TCP: rileva un peer sparito (cavo staccato, stampante spenta) senza attendere un comando. */
const KEEP_ALIVE_MS = 10_000;

export class TcpTransport implements ITransport {
  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private connected: boolean = false;
  /** Connessione in corso: chiamate concorrenti a `connect()` condividono lo stesso tentativo. */
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number = 9100,
    private readonly defaultTimeoutMs: number = 8000
  ) {}

  connect(): Promise<void> {
    if (this.connected && this.socket) {
      return Promise.resolve();
    }
    this.connecting ??= this.dial().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const reader = new FrameReader();
      this.socket = socket;
      this.reader = reader;
      // Gli eventi di un socket ormai sostituito non devono toccare lo stato di quello corrente.
      const isCurrent = () => this.socket === socket;

      socket.setNoDelay(true);
      socket.setKeepAlive(true, KEEP_ALIVE_MS);

      const connectTimer = setTimeout(() => {
        socket.destroy();
        reject(new CustomTimeoutError(`Timeout connessione TCP a ${this.host}:${this.port}`, this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);

      socket.on('data', (chunk: Buffer) => {
        reader.feed(chunk);
      });

      socket.on('error', (err: Error) => {
        clearTimeout(connectTimer);
        if (isCurrent()) this.connected = false;
        reader.failAll(err);
        reject(err);
      });

      socket.on('close', () => {
        clearTimeout(connectTimer);
        if (isCurrent()) {
          this.connected = false;
          this.socket = null;
        }
        reader.failAll(new CustomConnectionError('Connessione TCP chiusa'));
        reject(new CustomConnectionError('Connessione TCP chiusa prima del completamento'));
      });

      socket.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        this.connected = true;
        resolve();
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    const socket = this.socket;
    if (!this.connected || !socket) {
      throw new CustomConnectionError('Socket TCP non connesso');
    }

    return new Promise((resolve, reject) => {
      // Con un peer morto la callback di write può non arrivare mai: il socket va chiuso, non solo il timer.
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CustomTimeoutError('Timeout scrittura dati TCP verso la stampante', this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);
      socket.write(data, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Legge fino a ricevere un frame completo delimitato da ETX (0x03) o timeout
   */
  async read(timeoutMs: number = this.defaultTimeoutMs): Promise<Buffer> {
    if (!this.connected || !this.socket) {
      throw new CustomConnectionError('Socket TCP non connesso');
    }

    return this.reader.read(
      timeoutMs,
      () => new CustomTimeoutError('Timeout lettura dati TCP dalla stampante', timeoutMs)
    );
  }

  /** Scarta i byte ricevuti e non ancora consumati. */
  flush(): void {
    this.reader.flush();
  }

  async close(): Promise<void> {
    this.reader.failAll(new CustomConnectionError('Trasporto TCP chiuso'));
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      socket.end();
      socket.destroy();
    }
    this.reader.flush();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
