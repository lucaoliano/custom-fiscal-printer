import { ITransport } from './transport.interface';
import { CustomTimeoutError } from '../errors';
import { FrameReader } from './frame-buffer';

export class SerialTransport implements ITransport {
  private port: any = null;
  private reader = new FrameReader();
  private connected: boolean = false;

  constructor(
    private readonly path: string,
    private readonly baudRate: number = 19200,
    private readonly dataBits: 7 | 8 = 8,
    private readonly parity: 'none' | 'odd' | 'even' = 'none',
    private readonly stopBits: 1 | 2 = 1,
    private readonly defaultTimeoutMs: number = 8000
  ) {}

  async connect(): Promise<void> {
    let SerialPortClass: any;
    try {
      // Caricamento dinamico di serialport
      // @ts-ignore
      const serialPortModule = await import('serialport');
      SerialPortClass = serialPortModule.SerialPort || serialPortModule.default?.SerialPort;
    } catch {
      throw new Error(
        'Il modulo "serialport" non è installato. Per comunicare tramite porta seriale/USB, installalo con: npm install serialport'
      );
    }

    return new Promise((resolve, reject) => {
      this.reader = new FrameReader();
      const reader = this.reader;

      this.port = new SerialPortClass({
        path: this.path,
        baudRate: this.baudRate,
        dataBits: this.dataBits,
        parity: this.parity,
        stopBits: this.stopBits,
        autoOpen: false
      });

      this.port.open((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        this.connected = true;
        resolve();
      });

      this.port.on('data', (chunk: Buffer) => {
        reader.feed(chunk);
      });

      this.port.on('error', (err: Error) => {
        this.connected = false;
        // L'errore non viene ingoiato: rifiuta le letture pendenti (e la connect se ancora in corso)
        reader.failAll(err);
        reject(err);
      });

      this.port.on('close', () => {
        this.connected = false;
        reader.failAll(new Error('Porta seriale chiusa'));
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    if (!this.connected || !this.port) {
      throw new Error('Porta seriale non aperta');
    }

    return new Promise((resolve, reject) => {
      this.port.write(data, (err: Error | null) => {
        if (err) reject(err);
        else this.port.drain((drainErr: Error | null) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
  }

  async read(timeoutMs: number = this.defaultTimeoutMs): Promise<Buffer> {
    if (!this.connected || !this.port) {
      throw new Error('Porta seriale non aperta');
    }

    return this.reader.read(
      timeoutMs,
      () => new CustomTimeoutError('Timeout lettura dati seriali dalla stampante', timeoutMs)
    );
  }

  /** Scarta i byte ricevuti e non ancora consumati. */
  flush(): void {
    this.reader.flush();
  }

  async close(): Promise<void> {
    this.reader.failAll(new Error('Trasporto seriale chiuso'));
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => {
        this.port.close(() => resolve());
      });
    }
    this.port = null;
    this.connected = false;
    this.reader.flush();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
