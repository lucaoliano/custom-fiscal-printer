import { ITransport } from './transport.interface';
import { CustomConnectionError, CustomTimeoutError } from '../errors';
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
      const reader = new FrameReader();
      this.reader = reader;

      const port = new SerialPortClass({
        path: this.path,
        baudRate: this.baudRate,
        dataBits: this.dataBits,
        parity: this.parity,
        stopBits: this.stopBits,
        autoOpen: false
      });
      this.port = port;
      // Gli eventi di una porta ormai sostituita non devono toccare lo stato di quella corrente.
      const isCurrent = () => this.port === port;

      port.open((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        this.connected = true;
        resolve();
      });

      port.on('data', (chunk: Buffer) => {
        reader.feed(chunk);
      });

      port.on('error', (err: Error) => {
        if (isCurrent()) this.connected = false;
        // L'errore non viene ingoiato: rifiuta le letture pendenti (e la connect se ancora in corso)
        reader.failAll(err);
        reject(err);
      });

      port.on('close', () => {
        if (isCurrent()) this.connected = false;
        reader.failAll(new CustomConnectionError('Porta seriale chiusa'));
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    const port = this.port;
    if (!this.connected || !port) {
      throw new CustomConnectionError('Porta seriale non aperta');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CustomTimeoutError('Timeout scrittura dati seriali verso la stampante', this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);
      const done = (err?: Error | null) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      port.write(data, (err: Error | null) => {
        if (err) done(err);
        else port.drain((drainErr: Error | null) => done(drainErr));
      });
    });
  }

  async read(timeoutMs: number = this.defaultTimeoutMs): Promise<Buffer> {
    if (!this.connected || !this.port) {
      throw new CustomConnectionError('Porta seriale non aperta');
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
    this.reader.failAll(new CustomConnectionError('Trasporto seriale chiuso'));
    const port = this.port;
    this.port = null;
    this.connected = false;
    if (port && port.isOpen) {
      await new Promise<void>((resolve) => {
        port.close(() => resolve());
      });
    }
    this.reader.flush();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
