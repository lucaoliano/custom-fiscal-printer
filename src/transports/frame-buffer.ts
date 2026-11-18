import { CustomProtocolError } from '../errors';

/** Dimensione massima dell'accumulatore di ricezione (64 KiB). */
export const MAX_FRAME_BUFFER = 64 * 1024;

/**
 * Estrae il primo frame completo STX..ETX dal buffer.
 * - i byte prima dell'STX vengono scartati;
 * - l'ETX viene cercato DOPO l'STX.
 * Restituisce il frame (se completo) e il buffer residuo.
 */
export function extractFrame(buffer: Buffer): { frame: Buffer | null; rest: Buffer } {
  const stx = buffer.indexOf(0x02);
  if (stx === -1) {
    // Nessun STX: tutto il contenuto è rumore
    return { frame: null, rest: Buffer.alloc(0) };
  }
  const etx = buffer.indexOf(0x03, stx);
  if (etx === -1) {
    return { frame: null, rest: buffer.subarray(stx) };
  }
  return { frame: buffer.subarray(stx, etx + 1), rest: buffer.subarray(etx + 1) };
}

/**
 * Accumulatore di byte con estrazione frame e limite di dimensione.
 */
export class FrameBuffer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxSize: number = MAX_FRAME_BUFFER) {}

  /**
   * Aggiunge dati. Se il limite viene superato svuota il buffer e lancia CustomProtocolError.
   */
  push(chunk: Buffer): void {
    const merged = Buffer.concat([this.buf, chunk]);
    // Scarta subito il rumore prima dell'STX mantenendo i frame completi
    const stx = merged.indexOf(0x02);
    this.buf = stx === -1 ? Buffer.alloc(0) : merged.subarray(stx);
    if (this.buf.length > this.maxSize) {
      const size = this.buf.length;
      this.buf = Buffer.alloc(0);
      throw new CustomProtocolError(`Buffer di ricezione oltre il limite (${size} > ${this.maxSize} byte)`);
    }
  }

  /** Estrae il prossimo frame completo, o null. */
  take(): Buffer | null {
    const { frame, rest } = extractFrame(this.buf);
    this.buf = rest;
    return frame;
  }

  clear(): void {
    this.buf = Buffer.alloc(0);
  }

  get length(): number {
    return this.buf.length;
  }
}

/**
 * Lettura con timeout su un FrameBuffer: gestione condivisa da trasporti TCP e seriale.
 * Le letture pendenti vengono rifiutate subito su chiusura/errore (failAll) e hanno i timer ripuliti.
 */
export class FrameReader {
  private readonly frames = new FrameBuffer();
  private pending: Array<{ check: () => void; fail: (e: Error) => void }> = [];

  /** Da chiamare ad ogni chunk ricevuto. Errori di overflow rifiutano le letture pendenti. */
  feed(chunk: Buffer): void {
    try {
      this.frames.push(chunk);
    } catch (e) {
      this.failAll(e as Error);
      return;
    }
    for (const p of [...this.pending]) p.check();
  }

  /** Scarta i byte bufferizzati. */
  flush(): void {
    this.frames.clear();
  }

  /** Rifiuta immediatamente tutte le letture pendenti. */
  failAll(err: Error): void {
    const list = this.pending;
    this.pending = [];
    for (const p of list) p.fail(err);
  }

  read(timeoutMs: number, makeTimeoutError: () => Error): Promise<Buffer> {
    const existing = this.frames.take();
    if (existing) return Promise.resolve(existing);

    return new Promise<Buffer>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const entry = {
        check: () => {
          const frame = this.frames.take();
          if (frame) {
            cleanUp();
            resolve(frame);
          }
        },
        fail: (e: Error) => {
          cleanUp();
          reject(e);
        }
      };
      const cleanUp = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const idx = this.pending.indexOf(entry);
        if (idx !== -1) this.pending.splice(idx, 1);
      };
      timer = setTimeout(() => {
        cleanUp();
        reject(makeTimeoutError());
      }, timeoutMs);
      this.pending.push(entry);
    });
  }
}
