import { CustomFiscalError, CustomProtocolError } from '../errors';

export interface ParsedFrame {
  complete: boolean;
  counter?: number;
  ident?: string;
  isError: boolean;
  errorCode?: number;
  statusBytes?: string;
  data: string;
  rawString: string;
  remainingBuffer?: Buffer;
  /** Codice errore ignorato in un contesto noto (vedi handleCustomError del driver Java); isError è false. */
  ignoredErrorCode?: number;
  /** Esito della verifica del checksum (presente solo sui frame completi). */
  checksumValid?: boolean;
}

/**
 * Calcola il checksum a 2 cifre (modulo 100) secondo la specifica Custom.
 * Somma tutti i byte (0..255) del payload in codifica latin1 (ISO-8859-1).
 */
export function calculateChecksum(payload: string): string {
  const buf = Buffer.from(payload, 'latin1');
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i];
  }
  const modulo = sum % 100;
  return modulo.toString().padStart(2, '0');
}

/**
 * Costruisce il buffer binario del frame da inviare alla stampante.
 * Formato: STX (0x02) + Cnt(2) + Ident('0') + Comando + Cks(2) + ETX(0x03) + NUL(0x00)
 */
export function buildFrame(command: string, counter: number, ident: string = '0'): Buffer {
  // Il payload non deve contenere caratteri fuori da latin1 né byte di controllo (STX, ETX, ESC, ...):
  // altrimenti il frame verrebbe troncato o interpretato male dalla stampante.
  const encoded = Buffer.from(command, 'latin1');
  for (let i = 0; i < command.length; i++) {
    if (command.charCodeAt(i) > 0xff) {
      throw new CustomProtocolError(`Comando con carattere non codificabile in latin1 alla posizione ${i}`, command);
    }
  }
  for (const b of encoded) {
    if (b < 0x20) {
      throw new CustomProtocolError(
        `Comando contenente il byte di controllo 0x${b.toString(16).padStart(2, '0')}`,
        command
      );
    }
  }
  const cntStr = (counter % 100).toString().padStart(2, '0');
  const innerPayload = cntStr + ident + command;
  const cks = calculateChecksum(innerPayload);

  return Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from(innerPayload + cks, 'latin1'),
    Buffer.from([0x03, 0x00])
  ]);
}

/**
 * Analizza un buffer di richiesta (inviato dal client alla stampante).
 * Estrae direttamente il comando senza rimuovere i byte di stato.
 */
export function parseRequest(buffer: Buffer): { counter: number; ident: string; command: string } {
  const stxIndex = buffer.indexOf(0x02);
  const etxIndex = buffer.indexOf(0x03, stxIndex);
  if (stxIndex === -1 || etxIndex === -1) {
    return { counter: 0, ident: '0', command: '' };
  }
  const frameBytes = buffer.subarray(stxIndex, etxIndex + 1);
  const cntStr = frameBytes.subarray(1, 3).toString('latin1');
  const counter = parseInt(cntStr, 10);
  const ident = frameBytes.subarray(3, 4).toString('latin1');
  const command = frameBytes.subarray(4, frameBytes.length - 3).toString('latin1');
  return { counter, ident, command };
}

/**
 * Analizza un buffer ricevuto dalla stampante Custom.
 */
export function parseResponse(buffer: Buffer): ParsedFrame {
  const stxIndex = buffer.indexOf(0x02);
  if (stxIndex === -1) {
    return { complete: false, isError: false, data: '', rawString: '' };
  }

  const etxIndex = buffer.indexOf(0x03, stxIndex);
  if (etxIndex === -1) {
    return { complete: false, isError: false, data: '', rawString: '' };
  }

  // Frame completo estratto tra STX ed ETX
  const frameBytes = buffer.subarray(stxIndex, etxIndex + 1);
  const rawString = frameBytes.toString('latin1');
  const remainingBuffer = buffer.subarray(etxIndex + 1);

  // Minimo: STX(1) + Cnt(2) + Ident(1) + Cks(2) + ETX(1) = 7 byte
  if (frameBytes.length < 7) {
    throw new CustomProtocolError('Frame ricevuto troppo corto', frameBytes);
  }

  const cntStr = frameBytes.subarray(1, 3).toString('latin1');
  const counter = parseInt(cntStr, 10);
  const ident = frameBytes.subarray(3, 4).toString('latin1');

  // Payload centrale escluso STX, Cnt, Ident e Cks, ETX
  const cksReceived = frameBytes.subarray(frameBytes.length - 3, frameBytes.length - 1).toString('latin1');
  const innerForCks = frameBytes.subarray(1, frameBytes.length - 3).toString('latin1');

  // Verifica Checksum: l'esito viene restituito al chiamante, che applica la ChecksumPolicy
  const checksumValid = cksReceived === calculateChecksum(innerForCks);

  // Payload senza STX, Cnt, Ident e senza Cks, ETX
  const payload = frameBytes.subarray(4, frameBytes.length - 3).toString('latin1');

  // Controllo errore: verifica se inizia con ER o ERR
  if (payload.startsWith('ER')) {
    const match = payload.match(/^ER(?:R)?(\d+)/);
    const errorCode = match ? parseInt(match[1], 10) : 99;
    return {
      complete: true,
      counter,
      ident,
      isError: true,
      errorCode,
      data: payload,
      rawString,
      remainingBuffer,
      checksumValid
    };
  }

  // In caso di risposta normale con successo:
  // I primi 4 caratteri sono byte di stato/echo stampante,
  // i restanti sono i dati veri e propri (se presenti)
  let statusBytes = '';
  let data = payload;

  if (payload.length >= 4) {
    statusBytes = payload.substring(0, 4);
    data = payload.substring(4);
  }

  return {
    complete: true,
    counter,
    ident,
    isError: false,
    statusBytes,
    data,
    rawString,
    remainingBuffer,
    checksumValid
  };
}
