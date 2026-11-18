import { BarcodeType } from '../types';

export const ESC = '\x1B';

/** Opzioni di `Esc.barcode`. */
export interface EscBarcodeOptions {
  /**
   * Interpretazione leggibile (HRI) sotto il codice, come `{hri:1}` / `{hri:0}` di `manageBarcode` del driver Java.
   * `true` -> `{hri:1}`, `false` -> `{hri:0}`, omesso -> nessun prefisso (la stampante usa il default `0`).
   */
  hri?: boolean;
}

/**
 * Utility per generare sequenze di escape compatibili OPOS / Custom
 */
export const Esc = {
  // Stili testo
  normal: (text: string) => `${ESC}|1C${text}`,
  doubleWidth: (text: string) => `${ESC}|2C${text}`,
  doubleHeight: (text: string) => `${ESC}|3C${text}`,
  condensed: (text: string) => `${ESC}|5C${text}`,
  bold: (text: string) => `${ESC}|6C${text}`,

  // Allineamento
  alignLeft: (text: string) => `${ESC}|lA${text}`,
  alignCenter: (text: string) => `${ESC}|cA${text}`,
  alignRight: (text: string) => `${ESC}|rA${text}`,

  // Avanzamento carta (Feed)
  feed: (lines: number = 1) => `${ESC}|${lines}F`,

  // Stampa logo / bitmap residente (indice a 3 cifre sul filo: 3017 / 3026)
  bitmap: (index: number = 1) => `${ESC}|${index}B`,

  // Barcode: `3023 0 tipo hri 5 lun3 dati` (`3025` nei trailer); `hri` aggiunge il prefisso `{hri:1}`/`{hri:0}`
  barcode: (type: BarcodeType, code: string, options?: EscBarcodeOptions) => {
    let tCode = '1';
    switch (type) {
      case 'EAN13': tCode = '1'; break;
      case 'EAN8': tCode = '2'; break;
      case 'ITF': tCode = '3'; break;
      case 'CODE39': tCode = '4'; break;
      case 'EAN128': tCode = '5'; break;
      case 'QRCODE': tCode = '6'; break;
      case 'GS1DATABAR': tCode = '7'; break;
      case 'PDF417': tCode = '8'; break;
    }
    let data = code;
    if (options?.hri !== undefined) data = (options.hri ? '{hri:1}' : '{hri:0}') + code;
    const len = data.length + 1; // lunghezza dati + 1 per il tipo
    return `${ESC}|${len}R${tCode}${data}`;
  }
};

/** Operazione grafica incontrata in una riga ESC (nell'ordine in cui compare). */
export type EscOp =
  | { kind: 'feed'; count: number }
  | { kind: 'bitmap'; index: number }
  | { kind: 'barcode'; type: string; data: string }
  | { kind: 'headerLogo'; digit: string };

export interface FormattedPrintLine {
  pitch: string; // '1'=normale, '2'=bold, '4'=doppia altezza, '5'=doppia larghezza, 'D'=condensato
  text: string;
  maxLen: number;
  /** Ultimo bitmap della riga (compatibilita'): vedi `ops` per l'ordine completo */
  bitmapIndex?: number;
  /** Ultimo barcode della riga (compatibilita'): vedi `ops` */
  barcode?: { type: string; data: string };
  /** Ultimo feed della riga (compatibilita'): vedi `ops` */
  feeds?: number;
  /** Tutte le operazioni B/F/R nell'ordine di comparsa: il driver Java le invia subito, PRIMA del testo */
  ops: EscOp[];
}

/**
 * Modalita' del filtro ESC (corrispondono a `FilterEscSeq`, `FilterEscSeqTrailerInvoice`,
 * `FilterEscSeqCustomerFatt` del driver Java):
 * - `normal`: tabella stili di `FilterEscSeq`;
 * - `trailer`: tabella di `FilterEscSeqTrailerInvoice` (P7/P8/P9 sempre cifra);
 * - `customer`: pitch sempre `C`, B/F/R scartati senza invio;
 * - `header`: tabelle di `FilterEscSeqPrnHeader` (righe di intestazione `6302`): C/P come da bytecode, `B` = logo `I01<cifra>`,
 *   F/R scartati senza invio.
 */
export type EscFilterMode = 'normal' | 'trailer' | 'customer' | 'header';

export interface EscParseOptions {
  mode?: EscFilterMode;
  /** true se e' aperto un documento non fiscale (influisce sugli stili `P7`/`P9` in modalita' normal) */
  nonFiscalOpen?: boolean;
  /** Pitch iniziale (solo modalita' `header`: terzo parametro di `FilterEscSeqPrnHeader`) */
  pitch?: string;
}

/**
 * Analizza una riga contenente sequenze escape e la scompone
 * nei parametri appropriati per la stampante Custom.
 *
 * Grammatica come `FilterEscSeq` del driver Java: dopo `ESC |` il primo carattere del parametro e' consumato
 * incondizionatamente, poi si leggono le cifre; il carattere seguente e' la lettera di comando
 * (A, B, C, F, P, R; le altre sono rimosse senza effetto). Il carattere di stile e' l'ultimo del parametro.
 */
export function parseEscSequenceLine(line: string, options: EscParseOptions = {}): FormattedPrintLine {
  const mode: EscFilterMode = options.mode ?? 'normal';
  let pitch = mode === 'customer' ? 'C' : mode === 'header' ? options.pitch ?? '1' : '1';
  let maxLen = 44;
  let align: 'left' | 'center' | 'right' = 'left';
  let text = '';
  let bitmapIndex: number | undefined;
  let barcode: { type: string; data: string } | undefined;
  let feeds: number | undefined;
  const ops: EscOp[] = [];

  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === 0x1b && line[i + 1] === '|') {
      i += 2;
      // primo carattere consumato incondizionatamente, poi le cifre
      let param = '';
      if (i < line.length) {
        param += line[i];
        i++;
      }
      while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        param += line[i];
        i++;
      }
      const cmd = line[i] || '';
      i++;
      const style = param.length > 0 ? param[param.length - 1] : '';

      switch (cmd) {
        case 'C': // Stile font
          if (mode === 'header') {
            // FilterEscSeqPrnHeader: 1->1/44, 2->5/22, 3->4/44, 5->3/44, 6->2/44, altri ('4' compreso) -> 1 (lunghezza invariata)
            if (style === '1') { pitch = '1'; maxLen = 44; }
            else if (style === '2') { pitch = '5'; maxLen = 22; }
            else if (style === '3') { pitch = '4'; maxLen = 44; }
            else if (style === '5') { pitch = '3'; maxLen = 44; }
            else if (style === '6') { pitch = '2'; maxLen = 44; }
            else pitch = '1';
            break;
          }
          if (mode === 'customer') {
            if (style === '2') maxLen = 22;
            else if (style === '1' || style === '3' || style === '5' || style === '6') maxLen = 44;
            break;
          }
          if (style === '1') { pitch = '1'; maxLen = 44; }
          else if (style === '2') { pitch = '5'; maxLen = 22; }
          else if (style === '3') { pitch = '4'; maxLen = 44; }
          else if (style === '5') { pitch = 'D'; maxLen = 60; }
          else if (style === '6') { pitch = '2'; maxLen = 44; }
          else pitch = '1'; // '4' e altri: pitch normale, lunghezza invariata
          break;
        case 'P': // Pitch esplicito
          if (mode === 'customer') break;
          if (mode === 'header') {
            // 1..6 -> stessa cifra (5 -> 22 colonne, altri 44), altri -> '1'
            if (style >= '1' && style <= '6') { pitch = style; maxLen = style === '5' ? 22 : 44; }
            else pitch = '1';
            break;
          }
          if (style >= '1' && style <= '6') {
            pitch = style;
            maxLen = style === '5' ? 22 : 44;
          } else if (style === '7' || style === '9') {
            pitch = mode === 'normal' && options.nonFiscalOpen ? '1' : style;
          } else if (style === '8') {
            pitch = '8';
          } else if (style === 'A' || style === 'Z') {
            pitch = style;
            maxLen = 44;
          } else if (style === 'B' || style === 'C') {
            pitch = style;
            maxLen = 66;
          } else if (style === 'D') {
            pitch = 'D';
            maxLen = 60;
          } else {
            pitch = '1';
          }
          break;
        case 'A': // Allineamento
          if (param === 'c' || style === 'c') align = 'center';
          else if (param === 'r' || style === 'r') align = 'right';
          else align = 'left';
          break;
        case 'F': { // Feeds
          const n = parseInt(param, 10);
          feeds = isNaN(n) ? 1 : n;
          if (mode !== 'customer' && mode !== 'header') ops.push({ kind: 'feed', count: feeds });
          break;
        }
        case 'B': { // Bitmap (0 -> 1, come Java)
          const n = parseInt(param, 10);
          bitmapIndex = isNaN(n) || n === 0 ? 1 : n;
          if (mode === 'header') { ops.push({ kind: 'headerLogo', digit: param.charAt(0) }); break; }
          if (mode !== 'customer') ops.push({ kind: 'bitmap', index: bitmapIndex });
          break;
        }
        case 'R': { // Barcode: la lunghezza comprende il carattere tipo
          const barcodeLen = parseInt(param, 10);
          const rawBarcode = isNaN(barcodeLen) ? '' : line.substring(i, i + barcodeLen);
          if (!isNaN(barcodeLen)) i += barcodeLen;
          if (rawBarcode.length > 0) {
            barcode = { type: rawBarcode[0], data: rawBarcode.substring(1) };
            if (mode !== 'customer' && mode !== 'header') ops.push({ kind: 'barcode', type: barcode.type, data: barcode.data });
          }
          break;
        }
      }
    } else {
      text += line[i];
      i++;
    }
  }

  // Applica allineamento se specificato
  let processedText = text;
  if (align === 'center' && processedText.length < maxLen) {
    const spaces = Math.floor((maxLen - processedText.length) / 2);
    processedText = ' '.repeat(spaces) + processedText;
  } else if (align === 'right' && processedText.length < maxLen) {
    const spaces = maxLen - processedText.length;
    processedText = ' '.repeat(spaces) + processedText;
  }

  return {
    pitch,
    text: processedText,
    maxLen,
    bitmapIndex,
    barcode,
    feeds,
    ops
  };
}
