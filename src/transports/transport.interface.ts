/**
 * Interfaccia per il trasporto di comunicazione con la stampante
 */

export interface ITransport {
  connect(): Promise<void>;
  write(data: Buffer): Promise<void>;
  read(timeoutMs: number): Promise<Buffer>;
  /** Scarta i byte ricevuti e non ancora consumati (risposte tardive). Opzionale per trasporti personalizzati. */
  flush?(): void;
  close(): Promise<void>;
  isConnected(): boolean;
}
