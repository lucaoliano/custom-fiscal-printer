import * as net from 'net';
import { ITransport } from './transport.interface';
import { CustomTimeoutError } from '../errors';
import { FrameReader } from './frame-buffer';

export class TcpTransport implements ITransport {
  private socket: net.Socket | null = null;
  private reader = new FrameReader();
  private connected: boolean = false;

  constructor(
    private readonly host: string,
    private readonly port: number = 9100,
    private readonly defaultTimeoutMs: number = 8000
  ) {}

  async connect(): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.reader = new FrameReader();
      const reader = this.reader;

      const connectTimer = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
        }
        reject(new CustomTimeoutError(`Timeout connessione TCP a ${this.host}:${this.port}`, this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => {
        reader.feed(chunk);
      });

      this.socket.on('error', (err: Error) => {
        clearTimeout(connectTimer);
        this.connected = false;
        reader.failAll(err);
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        reader.failAll(new Error('Connessione TCP chiusa'));
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    if (!this.connected || !this.socket) {
      throw new Error('Socket TCP non connesso');
    }

    return new Promise((resolve, reject) => {
      this.socket!.write(data, (err) => {
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
      throw new Error('Socket TCP non connesso');
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
    this.reader.failAll(new Error('Trasporto TCP chiuso'));
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.reader.flush();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
