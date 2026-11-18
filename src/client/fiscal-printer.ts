import {
  ChecksumPolicy,
  ConnectionOptions,
  ErrorPolicy,
  PrinterLogger,
  PrinterCapabilities,
  PrinterOptions,
  FiscalItem,
  FiscalPayment,
  FiscalReceiptOptions,
  BeginReceiptResult,
  DocumentEmissionResult,
  PrinterStatusUpdateEvent,
  InvoiceOptions,
  InvoiceReceiptOptions,
  ItemVoid,
  ItemAdjustment,
  NonFiscalOptions,
  PrinterStatus,
  RefundOptions,
  RtDocumentOptions,
  RTStatus,
  VoidOptions
} from '../types';
import { ITransport } from '../transports/transport.interface';
import { TcpTransport } from '../transports/tcp.transport';
import { SerialTransport } from '../transports/serial.transport';
import { MockTransport } from '../transports/mock.transport';
import { buildFrame, ParsedFrame, parseResponse } from '../protocol/frame';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import {
  CustomFiscalError,
  CustomOperationNotAllowedError,
  CustomProtocolError,
  CustomTimeoutError
} from '../errors';
import { Mutex } from '../utils/mutex';
import {
  formatDateDDMMYY,
  formatDepartment,
  formatDescription,
  formatDynamicDescription,
  formatNumberPad,
  formatPrice,
  formatQty,
  formatQuantity,
  formatSinglePrice,
  formatVat,
  sanitizeText
} from '../utils/formatters';
import { EscFilterMode, parseEscSequenceLine } from '../protocol/esc-sequences';

/** Comandi su cui il driver Java propaga SEMPRE l'errore 5: vendite, pagamenti, non pagato. */
const ERR05_ALWAYS_RAISED_PREFIXES = ['3301', '3004', '3007', '3005'];

/**
 * Port fedele di `ProtCustom.handleCustomError` del driver JavaPOS ufficiale (verificato sul bytecode):
 * restituisce true se il driver Java NON propaga l'errore `code` per il comando `command`.
 * - ERR05: ignorato su tutti i comandi tranne quelli che iniziano con 3301 / 3004 / 3007 / 3005;
 * - ERR03: ignorato su tutti i comandi tranne quelli che contengono 7102A / 7102R
 *   o iniziano con 3301 / 71023;
 * - ERR05 / ERR56 / ERR57 / ERR85 sui comandi esatti 30160 e 30161.
 * (La regola Java sul codice 214 riguarda un codice JPOS, non Custom, ed è irraggiungibile.)
 */
export function isIgnoredByJavaDriver(code: number, command: string): boolean {
  if (code === 5 && !ERR05_ALWAYS_RAISED_PREFIXES.some((p) => command.startsWith(p))) {
    return true;
  }
  if (
    code === 3 &&
    !command.includes('7102A') &&
    !command.includes('7102R') &&
    !command.startsWith('3301') &&
    !command.startsWith('71023')
  ) {
    return true;
  }
  if ((code === 5 || code === 56 || code === 57 || code === 85) && (command === '30160' || command === '30161')) {
    return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Valida il codice lotteria: esattamente 8 caratteri alfanumerici (restituito maiuscolo). */
function normalizeLotteryCode(code: string): string {
  const clean = sanitizeText(String(code), 'Codice lotteria').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(clean)) {
    throw new RangeError('Codice lotteria: devono essere esattamente 8 caratteri alfanumerici');
  }
  return clean;
}

function assertIntRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name}: intero ${min}..${max} richiesto (ricevuto ${value})`);
  }
}

/**
 * `formattaQuantita` del driver Java: stringa numerica -> intero -> testo, riempito a sinistra con '0' fino a 5 cifre
 * (oltre 5 cifre si tengono le PRIME 5); non numerica o vuota -> `00000`.
 */
export function formatJavaPad5(value: string): string {
  const n = /^\d+$/.test(value) ? BigInt(value).toString() : '0';
  return n.length > 5 ? n.substring(0, 5) : n.padStart(5, '0');
}

/** `formattaDescrizioneLen3Digit` del driver Java: lunghezza reale a 3 cifre + testo troncato a `maxLen`. */
function formatLen3Description(text: string, maxLen: number): string {
  const t = sanitizeText(text).substring(0, maxLen);
  return t.length.toString().padStart(3, '0') + t;
}

/** `splitStr` del driver Java: token separati da CR/LF (le righe vuote sono scartate). */
function splitLines(text: string): string[] {
  return (text ?? '').split(/[\r\n]+/).filter((l) => l.length > 0);
}

function toInt(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

const XML_CRLF = '\r\n';

/**
 * XML di `directIO("1510XML")` (bytecode `directIO`, offset 2648-2859). `d` = dati della risposta (Java: ACK + dati,
 * quindi `substring(i, j)` di Java == `d.substring(i - 1, j - 1)`). Il driver consegna il testo senza il primo
 * carattere (`obj = resp.substring(1)`, che elimina lo spazio iniziale della costante).
 */
function rtConnectionXml(d: string): string {
  const x =
    ' <?xml version="1.0" encoding="UTF-8"?>' + XML_CRLF +
    '<Stato_Connessione_RT ' + XML_CRLF +
    'STATO_CMD = "' + d.substring(0, 1) + '"' + XML_CRLF +
    'DESC.OP = "' + d.substring(1, 21).trim() + '"' + XML_CRLF +
    'APPL.ERR = "' + d.substring(21, 24) + '"' + XML_CRLF +
    'HTTP.ERR = "' + d.substring(24, 27) + '"' + XML_CRLF +
    'XML.ERR = "' + d.substring(27, 30) + '"/>';
  return x.substring(1);
}

/** XML di `directIO("1511XML")` (offset 2867-3384): DEMO/NEXTTICKETRT/VATSPLIT/INACTIVITYPERIOD = "0" se la risposta e' corta. */
function rtLogicalXml(d: string): string {
  const r = 'x' + d; // indici come in Java (risposta = ACK + dati)
  const opt = (min: number, a: number, b: number) => (r.length >= min ? r.substring(a, b) : '0');
  const demo = opt(35, 34, 35);
  const nextTicket = opt(36, 35, 36);
  const vatSplit = opt(37, 36, 37);
  const inactivity = opt(38, 37, 38);
  const x =
    ' <?xml version="1.0" encoding="UTF-8"?>' + XML_CRLF +
    '<Stato_logico_RT ' + XML_CRLF +
    'SERIAL_RT = "' + r.substring(1, 2) + '"' + XML_CRLF +
    'MATR_RT = "' + r.substring(2, 13) + '"' + XML_CRLF +
    'MATR_83 = "' + r.substring(13, 23) + '"' + XML_CRLF +
    'CHIAVE_PRI = "' + r.substring(24, 25) + '"' + XML_CRLF +
    'CENSIMENTO = "' + r.substring(24, 25) + '"' + XML_CRLF +
    'ATTIVAZIONE = "' + r.substring(25, 26) + '"' + XML_CRLF +
    'IN_SERVIZIO = "' + r.substring(26, 27) + '"' + XML_CRLF +
    'DATA_IN_SERVIZIO = "' + r.substring(27, 33) + '"' + XML_CRLF +
    'SIMULAZIONE = "' + r.substring(33, 34) + '"' + XML_CRLF +
    'DEMO = "' + demo + '"' + XML_CRLF +
    'NEXTTICKETRT = "' + nextTicket + '"' + XML_CRLF +
    'VATSPLIT = "' + vatSplit + '"' + XML_CRLF +
    'INACTIVITYPERIOD = "' + inactivity + '"' + XML_CRLF +
    '/>';
  return x.substring(1);
}

/** Risposta di `directIO("<monitorServices />")` (offset 3452-3546): `<services Z=. invoices=. lottery=. Zbackup=. fwdownload=. />`. */
function monitorServicesXml(d: string): string {
  const r = 'x' + d;
  const x =
    ' <services Z=' + r.substring(1, 2) +
    ' invoices=' + r.substring(2, 3) +
    '  lottery=' + r.substring(3, 4) +
    ' Zbackup=' + r.substring(4, 5) +
    '  fwdownload=' + r.substring(5, 6) +
    ' />';
  return x.substring(1);
}

/** Timeout (ms) dei comandi diretti, come `getCmdTimeout` del driver Java (secondi * 1000). */
export function getCmdTimeoutMs(command: string): number {
  const p = command.substring(0, 4);
  if (p === '8001' || p === '8002' || p === '8003' || p === '8005') return 1800000;
  if (p === '9102' || p === '3023') return 15000;
  if (command.indexOf('8006') === 0) return 180000;
  return 10000;
}

/** Capacita' di default del driver Java prima dell'identificazione (costruttore di FiscalPrinterService). */
function defaultCapabilities(): PrinterCapabilities {
  return {
    model: '',
    subModel: '',
    rxPrinter: false,
    rxPrinterTiny: false,
    printerArch: 1,
    descriptionLength: 22,
    descriptionLengthPayment: 22,
    messageLength: 32,
    messageLength42: 44,
    numHeaderLines: 6,
    rtInService: false,
    rtMode: 2,
    trainingMode: false
  };
}

/**
 * Cifra di esito (0/1/2) delle risposte a `7101R`/`7101A`: in Java la risposta e' "ACK + 1 cifra"
 * (lunghezza 2), quindi qui i dati devono essere di esattamente 1 carattere numerico.
 */
function singleDigit(data: string): number | null {
  return data.length === 1 && data >= '0' && data <= '9' ? parseInt(data, 10) : null;
}

/**
 * Driver e Client TypeScript per Stampanti Fiscali Custom S.p.A.
 * 
 * Gestisce l'intera gamma di stampanti fiscali Custom (Kube II F, Q3X F, Big Plus, Fusion, ecc.),
 * operando nativamente con il Protocollo Custom a pacchetti STX/ETX.
 * 
 * Supporta:
 * - Registratore Telematico (RT) III Generazione
 * - Documento Commerciale di Vendita (Scontrino Fiscale)
 * - Gestione Codice Lotteria degli Scontrini e Codice Fiscale
 * - Documenti Commerciali di Reso (DOC_RESO) e Annullo (DOC_ANNULLO)
 * - Fattura Fiscale Semplificata RT
 * - Chiusura Fiscale Giornaliera Z-Report con trasmissione telematica ad Agenzia delle Entrate
 * - Documenti Gestionali / Non Fiscali con formattazione testo OPOS / ESC e Barcode
 * - Cassetto rendiresto e Display cliente integrato a 2 righe
 * - Giornale di Fondo Elettronico (DGFE) e Tabella aliquote IVA
 * 
 * @example
 * ```typescript
 * const printer = new CustomFiscalPrinter({
 *   type: 'tcp',
 *   host: '192.168.0.1',
 *   port: 9100
 * });
 * await printer.connect();
 * await printer.beginFiscalReceipt();
 * await printer.printRecItem({ description: 'Caffè', priceInCents: 120 });
 * await printer.printRecTotal({ amountInCents: 120, description: 'Contanti' });
 * await printer.endFiscalReceipt();
 * await printer.disconnect();
 * ```
 */
export interface CustomFiscalPrinter {
  on(event: 'statusUpdate', listener: (e: PrinterStatusUpdateEvent) => void): this;
  once(event: 'statusUpdate', listener: (e: PrinterStatusUpdateEvent) => void): this;
  off(event: 'statusUpdate', listener: (e: PrinterStatusUpdateEvent) => void): this;
  emit(event: 'statusUpdate', e: PrinterStatusUpdateEvent): boolean;
}

/** Documento commerciale RT di reso/annullo in corso (`RTDocType`/`RTDocZNum`/... del driver Java). */
interface RtDocState {
  /** 1 = reso (`7101R`), 2 = annullo (`7101A`) */
  type: 1 | 2;
  zNum: string;
  ticketNum: string;
  /** DDMMYY */
  ticketDate: string;
  deviceId: string;
  noPreview: boolean;
}

/** Codici `StatusUpdateEvent` del driver Java. */
const STATUS_EVENT_NAMES: Record<number, string> = {
  11: 'COVER_OPEN',
  12: 'COVER_OK',
  21: 'JRN_EMPTY',
  22: 'JRN_NEAREMPTY',
  23: 'JRN_PAPEROK',
  24: 'REC_EMPTY',
  25: 'REC_NEAREMPTY',
  26: 'REC_PAPEROK'
};

export class CustomFiscalPrinter extends EventEmitter {
  private transport: ITransport;
  private counter: number = 1;
  /** Serializza write+read sul canale (una sola richiesta in volo alla volta). */
  private readonly wireMutex = new Mutex();
  /** Lock di transazione: tiene fuori i comandi esterni mentre una sequenza è in corso. */
  private readonly txMutex = new Mutex();
  /** Rileva se il flusso asincrono corrente è dentro una transazione/operazione atomica di questa istanza. */
  private readonly txContext = new AsyncLocalStorage<true>();
  /** Lunghezza descrizione articolo: 22 di default, 44 sulle stampanti RX dopo `identify()` (come Java). */
  public descriptionLength: number = 22;
  private caps: PrinterCapabilities = defaultCapabilities();
  private identified = false;
  /** Ultimo stato "giornata aperta" letto con `1010` (come `DayOpened` del driver Java). */
  private dayOpenedCache = false;
  private readonly autoIdentify: boolean;
  private readonly headerLineDelayMs: number;
  private readonly deleteEmptyHeaderLines: boolean;
  private readonly errorPolicy: ErrorPolicy;
  private readonly checksumPolicy: ChecksumPolicy;
  private readonly logger?: PrinterLogger;
  private readonly pendingOperationDelayMs: number;
  private readonly checkTotal: boolean;
  private readonly stateChecks: boolean;
  private readonly identifyOnConnect: boolean;
  private readonly statusPollIntervalMs: number;
  private pollTimer?: NodeJS.Timeout;
  /** Contatore di sospensioni del polling (`bUpdateStatus = false` di Java). */
  private pollPaused = 0;
  private pollBusy = false;
  /** Ciclo di polling in corso: `disconnect` lo attende (come `close()` di Java con `bUpdateStatusIsRun`). */
  private pollInflight?: Promise<void>;
  /** Stati precedenti dei sensori (`CoverOpenOldStatus`, `RecEmptyOldStatus`, ... di Java; all'inizio false). */
  private oldSensors = { cover: false, recEmpty: false, recNear: false, jrnEmpty: false, jrnNear: false };
  /** Documento RT di reso/annullo impostato con `directIO -95010/-95011`, consumato dal prossimo `beginFiscalReceipt`. */
  private pendingRtDoc?: RtDocState;
  /** Documento RT di reso/annullo del documento corrente (`RTDocType != 0`). */
  private rtDoc?: RtDocState;

  // --- Stato del documento (come FiscalTicket / NFTicket / payFlag / bRestoStep... del driver Java) ---
  private fiscalOpen = false;
  private nonFiscalOpen = false;
  private payFlag = false;
  /** `bRestoStep`: true/false letto da 1012 dopo il pagamento; undefined = non noto (nessuna risposta utile) */
  private restoStep: boolean | undefined = undefined;
  private onlyCut = false;
  /** `PrinterState` del driver Java: 1 libero, 2 vendita, 3 pagamento, 4 chiusura, 9 documento non fiscale */
  private printerState = 1;
  private emptyTicket = true;
  /** `resetLottery` di Java: codice lotteria accettato (`3019` senza ERR) da azzerare con `301900` in `resetPrinter`. */
  private resetLotteryFlag = false;
  private trainingActive = false;
  private invoiceCtx?: { number: string; taxId: string; customerLines: string[]; printCustomerInfo: boolean };
  private refundReceipt = false;
  private recMessageBuffer = '';
  private preLineText = '';
  private postLineText = '';
  private posId = '';
  private cashierId = '';
  private refundNumber = '';
  private refundLine1 = '';
  private refundLine2 = '';
  private beginTrailerLines: string[] = [];
  /** `m_csPseudoLotteryCode` del driver Java: UNICO stato del codice lotteria in attesa (directIO -95012, printRecTaxID, opzioni). */
  private pseudoLottery = '';
  /** `m_csFiscalCode` del driver Java: codice fiscale in attesa (printRecTaxID), inviato con `3010B` da beginFiscalReceipt. */
  private fiscalCodeField = '';
  private printHeaderFlag = true;

  /**
   * Crea una nuova istanza del client per la stampante fiscale Custom.
   *
   * @param optionsOrTransport Opzioni di connessione (TCP, Seriale o Mock) oppure un'istanza personalizzata di ITransport.
   * @param printerOptions Opzioni di comportamento: politica errori, verifica checksum, logger.
   */
  constructor(optionsOrTransport: ConnectionOptions | ITransport, printerOptions: PrinterOptions = {}) {
    super();
    this.errorPolicy = printerOptions.errorPolicy ?? 'java';
    this.checksumPolicy = printerOptions.checksumPolicy ?? 'warn';
    this.logger = printerOptions.logger;
    this.pendingOperationDelayMs = printerOptions.pendingOperationDelayMs ?? 2000;
    this.autoIdentify = printerOptions.autoIdentify ?? true;
    this.identifyOnConnect = this.autoIdentify && (printerOptions.identifyOnConnect ?? true);
    const sp = printerOptions.statusPolling;
    // Java avvia SEMPRE CheckStatusThread in open(): il polling e' attivo di default (disattivabile con `false`)
    this.statusPollIntervalMs = sp === false ? 0 : typeof sp === 'object' ? sp.intervalMs ?? 2000 : 2000;
    this.checkTotal = printerOptions.checkTotal ?? true; // open() di Java: CheckTotal = true
    this.stateChecks = printerOptions.documentStateChecks ?? true;
    this.headerLineDelayMs = printerOptions.headerLineDelayMs ?? 1200;
    this.deleteEmptyHeaderLines = printerOptions.deleteEmptyHeaderLines ?? false;
    if ('connect' in optionsOrTransport && typeof (optionsOrTransport as ITransport).connect === 'function') {
      this.transport = optionsOrTransport as ITransport;
    } else {
      const opts = optionsOrTransport as ConnectionOptions;
      switch (opts.type) {
        case 'tcp':
          this.transport = new TcpTransport(
            opts.host,
            opts.port ?? 9100,
            opts.timeout ?? 8000
          );
          break;
        case 'serial':
          this.transport = new SerialTransport(
            opts.path,
            opts.baudRate ?? 19200,
            opts.dataBits ?? 8,
            opts.parity ?? 'none',
            opts.stopBits ?? 1,
            opts.timeout ?? 8000
          );
          break;
        case 'mock':
          this.transport = new MockTransport();
          break;
        default:
          throw new Error('Tipo di connessione non valido');
      }
    }
  }

  // --- GESTIONE CONNESSIONE ---

  /**
   * Apre il canale di comunicazione (socket TCP o porta seriale) con la stampante.
   * 
   * @throws {CustomTimeoutError} Se la connessione scade dopo il timeout configurato.
   */
  async connect(): Promise<void> {
    await this.transport.connect();
    try {
      // come open() di Java: ReadPrinterModel + ReadRTLogicalStatus (+ UpdatePrinterStaus(true) se il polling e' attivo)
      // Sequenza di open() di Java: setModoBuffer(false) = `30160` (8 s; fallimento -> open fallisce), ReadPrinterModel,
      // ReadRTLogicalStatus, UpdatePrinterStaus(true), bUpdateStatus = true, avvio CheckStatusThread
      if (this.identifyOnConnect && !this.identified) {
        await this.executeCommand('30160', 8000);
        try {
          await this.identify();
        } catch (e) {
          if (!(e instanceof CustomFiscalError)) throw e;
          this.logger?.warn?.('Identificazione stampante fallita, uso i valori di default', { error: e.message });
          this.identified = true;
        }
      }
      if (this.statusPollIntervalMs > 0) {
        await this.updatePrinterStatus(true);
        this.startStatusPolling();
      }
    } catch (e) {
      this.stopStatusPolling();
      await this.transport.close().catch(() => undefined);
      throw e;
    }
  }

  /**
   * Chiude il canale di comunicazione con la stampante rilasciando le risorse di rete o seriali.
   */
  async disconnect(): Promise<void> {
    this.stopStatusPolling();
    if (this.pollInflight) await this.pollInflight.catch(() => undefined);
    await this.transport.close();
    this.resetDocumentState();
    this.fiscalCodeField = '';
    this.pseudoLottery = '';
    // alla riconnessione (anche a un'altra stampante) la rilevazione va rifatta
    if (this.identified) {
      this.identified = false;
      this.caps = defaultCapabilities();
      this.descriptionLength = this.caps.descriptionLength;
    }
  }

  /**
   * Restituisce true se la stampante è attualmente connessa.
   */
  isConnected(): boolean {
    return this.transport.isConnected();
  }

  // --- MONITORAGGIO SENSORI (CheckStatusThread / UpdatePrinterStaus del driver Java) ---

  private startStatusPolling(): void {
    this.stopStatusPolling();
    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, this.statusPollIntervalMs);
    this.pollTimer.unref?.();
  }

  private stopStatusPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.oldSensors = { cover: false, recEmpty: false, recNear: false, jrnEmpty: false, jrnNear: false };
  }

  /** Sospende il polling per la durata di `fn` (come `bUpdateStatus = false` ... `true` di Java). */
  private async withPollingPaused<T>(fn: () => Promise<T>): Promise<T> {
    this.pollPaused++;
    try {
      return await fn();
    } finally {
      this.pollPaused--;
    }
  }

  /** Un ciclo del thread di controllo: mai in parallelo ad altri comandi, errori ingoiati come in Java. */
  private pollTick(): Promise<void> {
    const p = this.pollTickImpl();
    this.pollInflight = p;
    void p.finally(() => {
      if (this.pollInflight === p) this.pollInflight = undefined;
    });
    return p;
  }

  private async pollTickImpl(): Promise<void> {
    if (this.pollPaused > 0 || this.pollBusy || !this.transport.isConnected()) return;
    this.pollBusy = true;
    try {
      const release = await this.txMutex.tryAcquire();
      if (!release) return; // comando/transazione in corso: salta questo ciclo
      try {
        if (this.pollPaused > 0 || !this.transport.isConnected()) return;
        await this.txContext.run(true, () => this.updatePrinterStatus(false));
      } finally {
        release();
      }
    } catch (e) {
      this.logger?.warn?.('Polling stato stampante fallito', { error: (e as Error).message });
    } finally {
      this.pollBusy = false;
    }
  }

  /**
   * Port di `UpdatePrinterStaus(boolean force)`: legge `1109` (8 s) e confronta con lo stato precedente.
   * Emette `'statusUpdate'` solo alle transizioni (o sempre, con `force`): cover 11/12; carta scontrino
   * 24 (esaurita) / 25 (quasi esaurita) / 26 (ok); giornale 21 / 22 / 23. Risposte con meno di 1 carattere: nessun evento.
   */
  private async updatePrinterStatus(force: boolean): Promise<void> {
    const res = await this.executeCommand('1109', 8000);
    const d = res.data;
    if (d.length < 1) return;
    const cur = { ...this.oldSensors };
    cur.cover = d.charAt(0) === '1';
    if (d.length > 1) cur.recEmpty = d.charAt(1) === '1';
    if (d.length > 2) {
      cur.recNear = d.charAt(2) === '1';
      cur.jrnEmpty = d.length > 3 && d.charAt(3) === '1';
      cur.jrnNear = d.length > 4 && d.charAt(4) === '1';
    }
    const old = this.oldSensors;
    const status: PrinterStatus = {
      coverOpen: d.length > 0 && d.charAt(0) === '1',
      paperEmpty: d.length > 1 && d.charAt(1) === '1',
      paperNearEnd: d.length > 2 && d.charAt(2) === '1',
      journalEmpty: d.length > 3 && d.charAt(3) === '1',
      journalNearEnd: d.length > 4 && d.charAt(4) === '1',
      rawStatus: d
    };
    const fire = (code: number) => {
      try {
        this.emit('statusUpdate', { code, name: STATUS_EVENT_NAMES[code], status });
      } catch (e) {
        this.logger?.warn?.('Listener statusUpdate ha lanciato un errore', { error: (e as Error).message });
      }
    };
    if (old.cover !== cur.cover || force) fire(cur.cover ? 11 : 12);
    if (old.recEmpty !== cur.recEmpty || old.recNear !== cur.recNear || force) {
      if (cur.recEmpty || cur.recNear) {
        if (cur.recEmpty) fire(24);
        if (cur.recNear) fire(25);
      } else {
        fire(26);
      }
    }
    if (old.jrnEmpty !== cur.jrnEmpty || old.jrnNear !== cur.jrnNear || force) {
      if (cur.jrnEmpty || cur.jrnNear) {
        if (cur.jrnNear) fire(22);
        if (cur.jrnEmpty) fire(21);
      } else {
        fire(23);
      }
    }
    this.oldSensors = cur;
  }

  // --- ESECUZIONE COMANDI PROTOCOLLO ---

  /**
   * Invia un comando a basso livello nel protocollo Custom (STX + Cnt + Ident + Cmd + Cks + ETX),
   * attende la risposta, verifica il checksum ed estrae i dati.
   * 
   * Gestisce automaticamente l'interrogazione dell'errore esteso (`1015`) in caso di risposta `ERR99`.
   * 
   * @param command Stringa del comando Custom (es. "1109", "300408Contanti000000100")
   * @param timeoutMs Timeout massimo di attesa risposta in millisecondi (default 8000)
   * @returns ParsedFrame contenente stato ed eventuale payload dati
   * @throws {CustomFiscalError} Se la stampante risponde con un codice di errore ERxx/ERRxx
   * @throws {CustomTimeoutError} Se la stampante non risponde entro il tempo limite
   */
  async executeCommand(command: string, timeoutMs: number = 8000): Promise<ParsedFrame> {
    return this.atomic(() => this.wireMutex.runExclusive(() => this.executeCommandLocked(command, timeoutMs)));
  }

  /**
   * Esegue una sequenza di comandi in modo esclusivo: finché la transazione è in corso, i comandi
   * emessi dall'esterno (altre chiamate sulla stessa istanza) restano in attesa. I comandi emessi
   * dentro `fn` (tramite `tx`, o anche tramite l'istanza stessa nello stesso flusso asincrono) procedono.
   * Il lock viene rilasciato anche se `fn` lancia un errore. Le chiamate annidate non vanno in deadlock.
   *
   * @example
   * ```typescript
   * await printer.transaction(async (tx) => {
   *   await tx.beginFiscalReceipt();
   *   await tx.printRecItem({ description: 'Caffè', priceInCents: 120 });
   *   await tx.printRecTotal({ amountInCents: 120 });
   *   await tx.endFiscalReceipt();
   * });
   * ```
   */
  async transaction<T>(fn: (tx: CustomFiscalPrinter) => Promise<T>): Promise<T> {
    return this.atomic(() => fn(this));
  }

  /**
   * Esegue `fn` tenendo il lock di transazione (rientrante nello stesso flusso asincrono).
   * Usato dai metodi pubblici composti da più comandi, che non devono essere interlacciati.
   */
  private async atomic<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txContext.getStore()) {
      return fn();
    }
    const release = await this.txMutex.acquire();
    try {
      return await this.txContext.run(true, fn);
    } finally {
      release();
    }
  }

  private nextCounter(): number {
    const current = this.counter;
    this.counter = (this.counter % 99) + 1;
    return current;
  }

  /**
   * Singolo scambio richiesta/risposta (da chiamare sotto wireMutex).
   * Scarta i byte residui, invia il frame e legge fino a trovare la risposta con lo stesso contatore:
   * i frame con contatore diverso (risposte tardive di comandi andati in timeout) vengono ignorati
   * entro il timeout residuo. Non ritenta mai la scrittura.
   */
  private async exchange(command: string, timeoutMs: number): Promise<ParsedFrame> {
    const sentCounter = this.nextCounter();
    const frame = buildFrame(command, sentCounter);

    this.transport.flush?.();
    this.logger?.debug?.(`TX ${frame.toString('hex')}`, { command, counter: sentCounter });
    await this.transport.write(frame);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CustomTimeoutError('Timeout in attesa della risposta della stampante', timeoutMs, command);
      }
      let raw: Buffer;
      try {
        raw = await this.transport.read(remaining);
      } catch (e) {
        if (e instanceof CustomTimeoutError && !e.command) {
          throw new CustomTimeoutError(e.message, timeoutMs, command);
        }
        throw e;
      }
      this.logger?.debug?.(`RX ${raw.toString('hex')}`, { command });
      const parsed = parseResponse(raw);
      if (!parsed.complete) continue;
      if (parsed.counter !== sentCounter) {
        // risposta obsoleta (es. arrivata dopo un timeout): scarta e continua a leggere
        this.logger?.warn?.('Scartata risposta con contatore inatteso', {
          command,
          expected: sentCounter,
          received: parsed.counter
        });
        continue;
      }
      if (parsed.checksumValid === false && this.checksumPolicy !== 'off') {
        if (this.checksumPolicy === 'strict') {
          throw new CustomProtocolError(`Checksum della risposta non valido (comando ${command})`, raw);
        }
        this.logger?.warn?.('Checksum della risposta non valido', { command, frame: raw.toString('hex') });
      }
      return parsed;
    }
  }

  private async executeCommandLocked(command: string, timeoutMs: number): Promise<ParsedFrame> {
    const parsed = await this.exchange(command, timeoutMs);

    if (parsed.isError) {
      let extendedCode: number | undefined;

      // Se l'errore è 99 (errore esteso), interroghiamo la stampante con il comando 1015 (sempre sotto lo stesso lock)
      if (parsed.errorCode === 99) {
        try {
          const parsedExt = await this.exchange('1015', 3000);
          // Il driver Java accetta la risposta a 1015 anche in formato "ERRxxx" (codice esteso a 3 cifre)
          if (parsedExt.data) {
            const extNum = parseInt(parsedExt.data.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(extNum)) extendedCode = extNum;
          }
        } catch {
          // Ignora fallimento lettura errore esteso
        }
      }

      const code = parsed.errorCode || 99;
      if (this.errorPolicy === 'java' && isIgnoredByJavaDriver(code, command)) {
        // Come handleCustomError del driver Java: in questi contesti l'errore non viene propagato
        this.logger?.warn?.(`Errore ${code} ignorato (comportamento driver Java)`, { command, code });
        return { ...parsed, isError: false, data: '', ignoredErrorCode: code };
      }

      throw new CustomFiscalError(code, parsed.data, command, extendedCode);
    }

    return parsed;
  }

  // --- STATO E DIAGNOSTICA ---

  /**
   * Legge lo stato hardware dei sensori della stampante (carta finita, carta quasi finita, coperchio aperto).
   * 
   * Comando Custom: `1109`
   * 
   * @returns Oggetto PrinterStatus con i flag dei sensori.
   */
  async getPrinterStatus(): Promise<PrinterStatus> {
    const res = await this.executeCommand('1109');
    const data = res.data;

    return {
      coverOpen: data.length > 0 && data.charAt(0) === '1',
      paperEmpty: data.length > 1 && data.charAt(1) === '1',
      paperNearEnd: data.length > 2 && data.charAt(2) === '1',
      journalEmpty: data.length > 3 && data.charAt(3) === '1',
      journalNearEnd: data.length > 4 && data.charAt(4) === '1',
      rawStatus: data
    };
  }

  /**
   * Legge lo stato logico del Registratore Telematico (RT).
   * 
   * Comando Custom: `1511` (timeout 10 s, come `ReadRTLogicalStatus` del driver Java).
   *
   * Layout della risposta (identico a `directIO("1511XML")` del driver Java, offset Java - 1):
   * SERIAL_RT [0], MATR_RT [1..11], MATR_83 [12..21], CHIAVE_PRI/CENSIMENTO [23], ATTIVAZIONE [24],
   * IN_SERVIZIO [25], DATA_IN_SERVIZIO [26..31], SIMULAZIONE [32], DEMO [33], NEXTTICKETRT [34],
   * VATSPLIT [35], INACTIVITYPERIOD [36].
   * Come in Java, una risposta ERR03/ERR05 (o un errore 3/5) significa "non e' un RT".
   * 
   * @returns Oggetto RTStatus con `inService` (RT in servizio), `trainingMode` e tutti i campi 1511.
   */
  async getRTStatus(): Promise<RTStatus> {
    let data = '';
    try {
      const res = await this.executeCommand('1511', 10000);
      // ERR03/ERR05 ignorati dalla policy 'java': ReadRTLogicalStatus restituisce false
      if (res.ignoredErrorCode === 3 || res.ignoredErrorCode === 5) data = '';
      else data = res.data;
    } catch (e) {
      if (!(e instanceof CustomFiscalError) || (e.code !== 3 && e.code !== 5)) throw e;
    }

    // scambioDati di Java restituisce ACK + dati: substring(i, j) di Java == data.substring(i - 1, j - 1)
    const field = (from: number, to: number, fallback = '0') =>
      data.length >= to ? data.substring(from, to) : fallback;
    const isRT = data.length >= 26;
    const inService = isRT && data.charAt(25) === '1';

    return {
      isRT,
      inService,
      rtMode: isRT ? (inService ? 3 : 2) : 0,
      trainingMode: data.length >= 34 && data.charAt(33) === '1',
      serialRt: field(0, 1, ''),
      matrRt: field(1, 12, ''),
      matr83: field(12, 22, ''),
      chiavePri: field(23, 24),
      censimento: field(23, 24),
      attivazione: field(24, 25, ''),
      dataInServizio: field(26, 32, ''),
      simulazione: field(32, 33, ''),
      nextTicketRt: field(34, 35),
      vatSplit: field(35, 36),
      inactivityPeriod: field(36, 37),
      rawStatus: data
    };
  }

  /**
   * Rileva modello e stato RT della stampante come fa `open()` del driver Java
   * (`ReadPrinterModel` + `ReadRTLogicalStatus`) e ne memorizza le capacita':
   * - `1013`: se contiene la stringa modello "NCR 130A" -> RX, descrizioni a 44 colonne (imposta RXPrinter; il flag
   *   statico `NCR130A` di Java invece non e' mai true: ramo NCR130A = codice morto nel driver Java);
   * - altrimenti `1014`: codice modello/sottomodello (`RXPrinter`, `PrinterArch`, lunghezze righe);
   * - `1511`: RT in servizio -> `rtMode` 3 (altrimenti 2).
   * Aggiorna anche `descriptionLength`. Viene invocata automaticamente, una sola volta, alla prima
   * operazione che dipende dalle capacita' (salvo `autoIdentify: false`); puo' essere richiamata
   * esplicitamente per ripetere la rilevazione.
   */
  async identify(): Promise<PrinterCapabilities> {
    return this.atomic(async () => {
      const caps = defaultCapabilities();
      await this.readPrinterModel(caps);
      const rt = await this.getRTStatus();
      if (rt.isRT) {
        caps.rtInService = rt.inService;
        caps.rtMode = rt.inService ? 3 : 2;
      }
      caps.trainingMode = rt.trainingMode;
      this.caps = caps;
      this.descriptionLength = caps.descriptionLength;
      this.identified = true;
      return { ...caps };
    });
  }

  /** Capacita' correnti (valori di default finche' non e' avvenuta l'identificazione). */
  getCapabilities(): PrinterCapabilities {
    return { ...this.caps };
  }

  /** Identificazione lazy: errori della stampante (ERRxx) lasciano i default; errori di canale si propagano. */
  private async ensureIdentified(): Promise<void> {
    if (this.identified || !this.autoIdentify) return;
    try {
      await this.identify();
    } catch (e) {
      if (!(e instanceof CustomFiscalError)) throw e;
      this.logger?.warn?.('Identificazione stampante fallita, uso i valori di default', { error: e.message });
      this.identified = true;
    }
  }

  /** Port di `ReadPrinterModel` del driver Java (verificato sul bytecode). */
  private async readPrinterModel(caps: PrinterCapabilities): Promise<void> {
    const r13 = await this.executeCommand('1013', 10000);
    if (r13.data.indexOf('NCR 130A') !== -1) {
      caps.rxPrinter = true;
      caps.descriptionLength = 44;
      caps.messageLength42 = 56;
      caps.numHeaderLines = 9;
      return;
    }

    let col32 = false;
    const r14 = await this.executeCommand('1014', 10000);
    const d = r14.data;
    if (d.length >= 4) {
      const hex = (n: number) => (n >>> 0).toString(16).toUpperCase();
      const b = (i: number) => d.charCodeAt(i) - 48;
      const model = hex(b(0) * 16 + b(1));
      const sub = hex(b(2) * 16 + b(3));
      caps.model = model;
      caps.subModel = sub;

      const arch3 =
        (model === '18' && sub === 'A1') ||
        (model === '16' && sub === '1') ||
        model === '1F' ||
        (model === '15' && sub === '1') ||
        (model === '1>' && sub === '1') ||
        (model === '1<' && sub === '1') ||
        model === '1C' ||
        (model === '20' && sub === '1') ||
        (model === '21' && sub === '1') ||
        model === '1E';
      if (arch3) {
        caps.printerArch = 3;
        caps.rxPrinter = true;
        if ((model === '15' || model === '1C' || model === '1>') && sub === '1') col32 = true;
        if (model === '20' && sub === '1') caps.rxPrinterTiny = true;
      }
      if (
        (model === '8' && sub === '1') ||
        (model === '1' && sub === '31') ||
        (model === '1' && sub === '1')
      ) {
        caps.printerArch = 2;
      }
    }

    if (caps.rxPrinter && !col32) {
      caps.messageLength42 = 44;
      caps.messageLength = 44;
      caps.numHeaderLines = 9;
      caps.descriptionLengthPayment = 22;
      caps.descriptionLength = 44;
    } else {
      caps.messageLength42 = 42;
      caps.messageLength = 32;
      caps.numHeaderLines = 9;
    }
  }

  /**
   * Legge il modello della stampante.
   * 
   * Comando Custom: `1014`
   */
  async getPrinterModel(): Promise<string> {
    const res = await this.executeCommand('1014', 10000);
    return res.data;
  }

  /**
   * Legge la versione del firmware installato a bordo macchina.
   * 
   * Comando Custom: `1013`
   */
  async getFirmwareVersion(): Promise<string> {
    const res = await this.executeCommand('1013', 10000);
    return res.data;
  }

  /**
   * Legge la matricola fiscale univoca della stampante (es. STMTE110306).
   * 
   * Comando Custom: `1008`
   */
  async getSerialNumber(): Promise<string> {
    // Java (getData PRINTER_ID): con RT in servizio `1511` data[1..12); altrimenti data[12..22).
    // `1008` non e' usato da Java per la matricola: resta come ripiego se `1511` non e' disponibile.
    try {
      const rt = await this.getRTStatus();
      if (rt.isRT) return rt.inService ? rt.matrRt : rt.matr83;
    } catch (e) {
      if (!(e instanceof CustomFiscalError)) throw e;
    }
    const res = await this.executeCommand('1008', getCmdTimeoutMs('1008'));
    return res.data;
  }

  /**
   * Legge la data e l'ora attuali memorizzate nel chip RTC (Real Time Clock) della stampante.
   * 
   * Comando Custom: `1001`. Restituisce `ddMMyyyyHHmm` (12 cifre, secolo fisso "20" come il driver Java; prima della
   * versione parity-2 restituiva la risposta grezza `DDMMYYhhmm`).
   */
  async getDate(): Promise<string> {
    const res = await this.executeCommand('1001', getCmdTimeoutMs('1001'));
    const d = res.data;
    // Java: DDMM + "20" + YY + hhmm = "ddMMyyyyHHmm" (come l'input di setDate); risposta corta: grezza
    if (d.length >= 10) return d.substring(0, 2) + d.substring(2, 4) + '20' + d.substring(4, 6) + d.substring(6, 8) + d.substring(8, 10);
    return d;
  }

  /**
   * Imposta data e ora della stampante fiscale.
   * 
   * Comando Custom: `2001` + ggMM + aaHHmm (10 caratteri, senza secondi: come `setDate` del driver Java,
   * che riceve "ddMMyyyyHHmm" e invia `substring(0,4)` + `substring(6,12)`).
   * Se la stampante risponde '1' (data troppo distante) il driver Java invia di nuovo lo stesso comando
   * per confermare (l'eccezione 114/219 "Date too far, send again to confirm" appartiene al ramo NCR130A: codice morto nel driver Java, flag sempre false).
   * 
   * @param date Data e ora da impostare (Date oppure stringa "ddMMyyyyHHmm")
   */
  async setDate(date: Date | string): Promise<void> {
    let ddMMyyyyHHmm: string;
    if (typeof date === 'string') {
      if (!/^\d{12}$/.test(date)) {
        throw new RangeError('Data: formato richiesto ddMMyyyyHHmm (12 cifre)');
      }
      ddMMyyyyHHmm = date;
    } else {
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        throw new RangeError('Data non valida');
      }
      const p2 = (n: number) => n.toString().padStart(2, '0');
      ddMMyyyyHHmm =
        p2(date.getDate()) +
        p2(date.getMonth() + 1) +
        date.getFullYear().toString().padStart(4, '0') +
        p2(date.getHours()) +
        p2(date.getMinutes());
    }
    const cmd = `2001${ddMMyyyyHHmm.substring(0, 4)}${ddMMyyyyHHmm.substring(6, 12)}`;
    await this.atomic(async () => {
      await this.assertPrinterReady('setDate');
      const res = await this.executeCommand(cmd);
      if (res.data.charAt(0) === '1') {
        await this.executeCommand(cmd); // conferma
      }
    });
  }

  /**
   * Resetta lo stato del documento corrente, annullando eventuali transazioni rimaste aperte.
   * 
   * Comando Custom: `71020`
   */
  async reset(): Promise<void> {
    await this.executeCommand('71020');
  }

  // --- SCONTRINO FISCALE / DOCUMENTO COMMERCIALE RT ---

  /**
   * Inizia l'emissione di uno Scontrino Fiscale / Documento Commerciale Online RT
   * (port di `beginFiscalReceipt` del driver Java, verificato sul bytecode).
   *
   * Sequenza: controllo giornata/stato RT (`1010`, se la giornata e' aperta `1511`), sincronizzazione dello stato
   * documento (`1011`/`1012`, `riempiVarStatoStep`), errore 114/207 se un documento e' gia' aperto; poi, SOLO con
   * RT in servizio, `71020` + `71021`; codice lotteria `3019` (non per i documenti RT di reso/annullo);
   * con `refund: true` e RT non in servizio `7102600000`; fattura semplificata (`71023`/`71029`/`7103`) oppure
   * documento RT `7101R`/`7101A` (`rtDocument`); infine codice fiscale `3010B` e righe di intestazione `3002`.
   *
   * @param options Opzioni scontrino:
   *  - `lotteryCode`: Codice Lotteria degli Scontrini (8 caratteri alfanumerici).
   *  - `fiscalCode`: Codice Fiscale del cliente per la detrazione fiscale.
   *  - `headerLines`: Array di righe di intestazione addizionali (supportano stili ESC).
   *  - `rtDocument`: reso/annullo RT eseguito dentro l'apertura (il reso lascia il documento aperto).
   * @returns `documentOpen`: false se un annullo RT e' stato completato dalla stampante.
   */
  async beginFiscalReceipt(options?: FiscalReceiptOptions): Promise<BeginReceiptResult> {
    return this.atomic(() => this.beginFiscalReceiptImpl(options));
  }

  /** Converte le opzioni (o `directIO -95010/-95011`) nello stato `RTDocType`/`RTDocZNum`/... di Java. */
  private buildRtDoc(o: RtDocumentOptions): RtDocState {
    return {
      type: o.type === 'refund' ? 1 : 2,
      zNum: formatNumberPad(o.docRef.zReport, 4),
      ticketNum: formatNumberPad(o.docRef.ticketNumber, 4),
      ticketDate: formatDateDDMMYY(o.docRef.date),
      deviceId: String(o.deviceSerial ?? ''),
      noPreview: o.noPreview === true
    };
  }

  /** `ReadRTLogicalStatus` di Java: aggiorna `RTMode`/addestramento da `1511`; false se ERR03/ERR05 (non e' un RT). */
  private async readRTLogicalStatus(): Promise<boolean> {
    let res: ParsedFrame;
    try {
      res = await this.executeCommand('1511', 10000);
    } catch (e) {
      if (e instanceof CustomFiscalError && (e.code === 3 || e.code === 5)) return false;
      throw e;
    }
    if (res.ignoredErrorCode === 3 || res.ignoredErrorCode === 5) return false;
    const d = res.data;
    if (d.length >= 26) {
      const inService = d.charAt(25) === '1';
      this.caps.rtInService = inService;
      this.caps.rtMode = inService ? 3 : 2;
    }
    if (d.length >= 34) {
      this.caps.trainingMode = d.charAt(33) === '1';
      this.trainingActive = this.caps.trainingMode;
    }
    return true;
  }

  private async beginFiscalReceiptImpl(options?: FiscalReceiptOptions): Promise<BeginReceiptResult> {
    // Validazione preventiva (prima di inviare qualsiasi comando)
    if (options?.lotteryCode) normalizeLotteryCode(options.lotteryCode);
    if (options?.fiscalCode) formatDynamicDescription(options.fiscalCode.trim(), 24);
    for (const line of options?.headerLines ?? []) {
      const p = parseEscSequenceLine(line);
      formatDynamicDescription(p.text, p.maxLen === 60 ? 60 : 44);
    }
    const inv = options?.invoice ? this.validateInvoice(options.invoice) : undefined;
    const optRtDoc = options?.rtDocument ? this.buildRtDoc(options.rtDocument) : undefined;

    this.guardNoNonFiscal('beginFiscalReceipt');
    await this.ensureIdentified();

    // Documento RT impostato con directIO -95010/-95011 (RTDocType): consumato da questa apertura
    const pendingRt = this.pendingRtDoc;
    this.pendingRtDoc = undefined;
    // Le opzioni TS equivalgono a printRecTaxID/directIO -95012 eseguiti prima dell'apertura: scrivono lo stato unico
    const optLottery = options?.rtDocument?.lotteryCode ?? options?.lotteryCode;
    if (optLottery) this.pseudoLottery = normalizeLotteryCode(optLottery);
    if (options?.fiscalCode) this.fiscalCodeField = options.fiscalCode;

    // Controllo giornata / stato RT (`RTMode != 1`, sempre vero: RTMode vale 2 o 3). Polling sospeso (bUpdateStatus).
    await this.withPollingPaused(async () => {
      if (!this.dayOpenedCache) {
        await this.getDayOpened();
        if (this.dayOpenedCache) await this.readRTLogicalStatus();
      }
    });
    // riempiVarStatoStep(true, true): allinea FiscalTicket / NFTicket / PrinterState da 1011 e 1012
    await this.refreshStep(true, true);
    this.guardNoNonFiscal('beginFiscalReceipt');
    if (this.stateChecks && this.fiscalOpen) {
      this.stateError('beginFiscalReceipt', 'scontrino fiscale gia\' aperto');
    }

    this.resetDocumentState();
    this.fiscalOpen = true;
    const rt = this.caps.rtMode === 3;
    // Come directIO -95010/-95011 (no-op con RTMode != 3) il documento RT ha effetto solo con RT in servizio
    let rtDoc = optRtDoc ?? pendingRt;
    if (rtDoc && !rt) {
      this.logger?.warn?.('Documento RT di reso/annullo ignorato: RT non in servizio (RTMode != 3), come il driver Java');
      rtDoc = undefined;
    }
    this.rtDoc = rtDoc;
    let rtDocumentEmitted: boolean | undefined;
    try {
      // 1. Reset transazione precedente + 2. abilita scontrino RT: solo con RT in servizio (RTMode == 3)
      if (rt) {
        await this.executeCommand('71020');
        await this.executeCommand('71021');
      }

      // 3. Codice lotteria: non per i documenti di reso/annullo RT (FiscalReceiptType 3 / RTDocType 1,2)
      // Java (beginFiscalReceipt @338-447): se FiscalReceiptType != 3 e RTDocType non e' 1/2 e m_csPseudoLotteryCode non e'
      // vuoto invia `3019` + descrizione dinamica (42), poi azzera il campo; per i documenti RT il campo resta (7101 lo usa).
      if (!rtDoc) {
        if (this.pseudoLottery.length > 0) {
          const res = await this.sendLottery(this.pseudoLottery);
          // resetLottery = true solo se la risposta non contiene alcun "ERR" (codice accettato)
          if (res.ignoredErrorCode === undefined && !res.isError) this.resetLotteryFlag = true;
        }
        this.pseudoLottery = '';
      }

      this.refundReceipt = options?.refund === true;
      this.beginTrailerLines = [...(options?.trailerLines ?? [])];

      if (this.refundReceipt && !rt) {
        // FiscalReceiptType 7 (reso) senza RT in servizio: 7102600000 (10 s) e poi direttamente il tail
        await this.executeCommand('7102600000', 10000);
      } else if (inv) {
        // 4. Fattura semplificata (FiscalReceiptType 6)
        const num = inv.number;
        if (num.startsWith('§')) {
          await this.executeCommand(`71029${formatJavaPad5(num.substring(1))}`, 10000);
        } else {
          await this.executeCommand(`71023${formatJavaPad5(num)}`, 10000);
        }
        if (inv.taxId.startsWith('@')) {
          await this.executeCommand(`7103${formatJavaPad5(inv.taxId)}`, 10000);
        }
        this.invoiceCtx = { ...inv, printCustomerInfo: true };
      } else if (rtDoc) {
        const r = await this.performRtDocument(rtDoc);
        rtDocumentEmitted = r.performed;
        if (r.completed) {
          // annullo completato dalla stampante (PERFORM = 1): documento chiuso, nessun tail
          this.resetDocumentState();
          return { documentOpen: false, rtDocumentEmitted };
        }
      }

      // 5. Codice fiscale cliente per detrazioni fiscali (`m_csFiscalCode`, 3010B)
      if (this.fiscalCodeField.length > 0) {
        await this.executeCommand(`3010B${formatDynamicDescription(this.fiscalCodeField, 24)}`);
      }
      this.fiscalCodeField = '';
      this.printerState = 2;
      this.emptyTicket = true;

      // 6. Eventuali righe di intestazione aggiuntive (FilterEscSeq con prefisso 3002)
      for (const line of options?.headerLines ?? []) {
        await this.sendEscLine(line, '3002', 'normal');
      }
      return { documentOpen: true, ...(rtDoc ? { rtDocumentEmitted } : {}) };
    } catch (e) {
      this.resetDocumentState();
      throw e;
    }
  }

  /**
   * Flusso `7101R`/`7101A` dentro `beginFiscalReceipt` (bytecode offset 922-1953).
   * Reso: ASK con modalita' sempre `0`; risposta 2 = errore; 0/1 = PERFORM con `8` (noPreview) o `1`; altre cifre = nessun PERFORM.
   * Annullo: ASK `8` (noPreview) o `0`; 2 = errore; qualunque altra cifra = PERFORM `1`; PERFORM = 1 -> documento chiuso.
   * Risposte senza cifra: ERR03/ERR05 = errore (JPOS 106 "Operation not allowed"), altrimenti si prosegue.
   */
  private async performRtDocument(doc: RtDocState): Promise<{ performed: boolean; completed: boolean }> {
    const cmdName = doc.type === 1 ? '7101R' : '7101A';
    const serialDesc = formatDynamicDescription(doc.deviceId, 11); // deviceIdDesc
    const lotteryDesc = this.lotteryCodeDesc(); // LotteryCodeDesc (da m_csPseudoLotteryCode)
    const base = `${cmdName}${doc.zNum}${doc.ticketNum}${doc.ticketDate}`;
    const reject = (): never => {
      throw new CustomOperationNotAllowedError('Operazione non consentita', cmdName);
    };
    const run = (mode: string) => this.executeCommand(`${base}${mode}${serialDesc}${lotteryDesc}`, 90000);

    const ask = await run(doc.type === 1 ? '0' : doc.noPreview ? '8' : '0');
    const askDigit = singleDigit(ask.data);
    if (askDigit === null) {
      this.assertNoIgnoredRejection(ask.ignoredErrorCode, cmdName);
      this.logger?.warn?.(`${cmdName}: risposta ASK inattesa: nessun PERFORM (come driver Java)`);
      return { performed: false, completed: false };
    }
    if (askDigit === 2) reject();
    if (doc.type === 1 && askDigit !== 0 && askDigit !== 1) {
      this.logger?.warn?.(`${cmdName}: cifra ASK inattesa (${askDigit}): nessun PERFORM (come driver Java)`);
      return { performed: false, completed: false };
    }

    const perform = await run(doc.type === 1 ? (doc.noPreview ? '8' : '1') : '1');
    const performDigit = singleDigit(perform.data);
    if (performDigit === null) {
      this.assertNoIgnoredRejection(perform.ignoredErrorCode, cmdName);
      return { performed: true, completed: false };
    }
    if (performDigit === 2) reject();
    if (doc.type === 2 && performDigit === 1) {
      this.payFlag = false;
      this.restoStep = false;
      return { performed: true, completed: true };
    }
    return { performed: true, completed: false };
  }

  /** Valida i dati fattura come `beginFiscalReceipt` (tipo 6) del driver Java: errori = JPOS 106 (RangeError). */
  private validateInvoice(inv: InvoiceReceiptOptions): { number: string; taxId: string; customerLines: string[] } {
    const number = String(inv.number ?? '');
    const taxId = String(inv.taxId ?? '');
    if (number.length === 0) throw new RangeError('Numero fattura: formato errato (vuoto)');
    if (taxId.length === 0) throw new RangeError('Conto IVA: formato errato (vuoto)');
    if (number.indexOf('$') !== -1) throw new RangeError('Numero fattura: carattere $ non consentito');
    let n = number;
    if (n.startsWith('§')) {
      if (n.length > 6) n = n.substring(0, 7);
      if (n.length === 1) throw new RangeError('Numero fattura: formato errato');
    } else if (n.length > 5) {
      n = n.substring(0, 6);
    }
    const customerLines = (inv.customerLines ?? []).map((l) => sanitizeText(l, 'Riga cliente'));
    sanitizeText(taxId, 'Conto IVA');
    return { number: n, taxId, customerLines };
  }

  private async sendLottery(clean: string): Promise<ParsedFrame> {
    return this.executeCommand(`3019${formatDynamicDescription(clean, 42)}`);
  }

  /**
   * Imposta il Codice Lotteria degli Scontrini del cliente (8 caratteri alfanumerici).
   * Comando Custom: `3019` + descrizione dinamica (max 42).
   */
  async setLotteryCode(lotteryCode: string): Promise<void> {
    // Equivale a directIO -95012 (memorizza il codice e invia subito `3019`); validazione 8 alfanumerici = input TS
    const clean = normalizeLotteryCode(lotteryCode);
    await this.directIONumeric(-95012, [clean.length], clean);
  }

  /** `LotteryCodeDesc` di Java: `""` se nessun codice, altrimenti lunghezza a 2 cifre + codice (senza troncamenti). */
  private lotteryCodeDesc(): string {
    const l = this.pseudoLottery.length;
    if (l === 0) return '';
    return (l < 10 ? '0' + l : '' + l) + this.pseudoLottery;
  }

  /**
   * Imposta il Codice Fiscale del cliente per scontrino parlante / detrazione sanitaria.
   * Comando Custom: `3010B` + descrizione dinamica (max 24).
   */
  async setFiscalCode(fiscalCode: string): Promise<void> {
    const desc = formatDynamicDescription(sanitizeText(fiscalCode, 'Codice fiscale').trim().toUpperCase(), 24);
    await this.executeCommand(`3010B${desc}`);
  }

  // --- STATO DOCUMENTO E CONTROLLI (checkFiscalDocOpened & C. del driver Java) ---

  private resetDocumentState(): void {
    this.fiscalOpen = false;
    this.nonFiscalOpen = false;
    this.payFlag = false;
    this.restoStep = undefined;
    this.onlyCut = false;
    this.printerState = 1;
    this.emptyTicket = true;
    this.resetLotteryFlag = false;
    this.invoiceCtx = undefined;
    this.refundReceipt = false;
    this.recMessageBuffer = '';
    this.beginTrailerLines = [];
    this.rtDoc = undefined;
    this.pendingRtDoc = undefined;
  }

  /** JPOS_E_EXTENDED / JPOS_EFPTR_WRONG_STATE (114/207). */
  private stateError(what: string, msg: string): never {
    throw new CustomOperationNotAllowedError(`${what}: ${msg}`, undefined, 114, 207);
  }

  /** `checkNonFiscalDocOpened`: errore se e' aperto un documento NON fiscale. */
  private guardNoNonFiscal(what: string): void {
    if (this.stateChecks && this.nonFiscalOpen) this.stateError(what, 'documento non fiscale aperto');
  }
  /** `checkFiscalDocOpened`: errore se e' aperto uno scontrino fiscale. */
  private guardNoFiscal(what: string): void {
    if (this.stateChecks && this.fiscalOpen) this.stateError(what, 'scontrino fiscale aperto');
  }
  /** `checkFiscalDocNotOpened`: errore se NON e' aperto uno scontrino fiscale. */
  private guardFiscalOpen(what: string): void {
    if (this.stateChecks && !this.fiscalOpen) this.stateError(what, 'scontrino fiscale non aperto');
  }

  /** Stato del documento corrente (come i flag FiscalTicket / NFTicket / payFlag del driver Java). */
  getDocumentState(): { fiscalOpen: boolean; nonFiscalOpen: boolean; paymentStarted: boolean; printerState: number } {
    return {
      fiscalOpen: this.fiscalOpen,
      nonFiscalOpen: this.nonFiscalOpen,
      paymentStarted: this.payFlag,
      printerState: this.printerState
    };
  }

  /**
   * Port di `riempiVarStatoStep(boolean a, boolean b)` (bytecode verificato). Legge `1011` (8 s) e, se la risposta
   * ha almeno 2 caratteri di dati: `data[1] == '1'` = documento non fiscale aperto (stato 9, fine); altrimenti
   * stato 1, non fiscale chiuso e, se `a` oppure nessuno scontrino fiscale era noto come aperto, il flag
   * scontrino fiscale (`FiscalTicket`) viene allineato a `data[0] != '0'`; con `data[0] == '0'` lo stato resta 1 e,
   * se `!b`, la procedura termina. Poi legge `1012` e imposta stato/fase (`bRestoStep`, `bOnlyCut`).
   * Risposte vuote o troppo corte (< 2 caratteri di dati) terminano senza leggere `1012`. (Il ramo NCR130A con `checkNFTicket` e' codice morto nel driver Java: flag sempre false, non portato per scelta.)
   */
  private async refreshStep(a: boolean = true, b: boolean = true): Promise<void> {
    const r11 = await this.executeCommand('1011');
    if (r11.data.length < 2) return; // Java: resp.length() <= 2 -> fine, senza leggere 1012
    if (r11.data.charAt(1) === '1') {
      this.nonFiscalOpen = true;
      this.printerState = 9;
      return;
    }
    this.nonFiscalOpen = false;
    this.printerState = 1;
    if (!this.fiscalOpen || a) {
      if (r11.data.charAt(0) === '0') {
        this.fiscalOpen = false;
        this.printerState = 1;
        if (!b) return;
      } else {
        this.fiscalOpen = true;
      }
    }
    const r12 = await this.executeCommand('1012');
    switch (r12.data.charAt(0)) {
      case '0': this.printerState = this.fiscalOpen ? 2 : 1; break;
      case '1': this.printerState = 2; break;
      case '2': this.printerState = 3; break;
      case '3': case '4': this.restoStep = true; this.printerState = 4; break;
      case '5': case '6': this.printerState = 4; this.onlyCut = true; this.restoStep = true; break;
      case '7': this.printerState = 4; break;
      default: break;
    }
  }

  /**
   * `riempiVarStatoFiscal` (comando `1010`): giornata aperta (`data[7] != '1'`), documento non fiscale aperto
   * (`data[8] == '1'`), addestramento (`data[10] == '1'`).
   */
  async getFiscalState(): Promise<{ dayOpened: boolean; nonFiscalDocOpen: boolean; trainingMode: boolean; rawStatus: string }> {
    const res = await this.executeCommand('1010');
    const d = res.data;
    if (d.length >= 2) {
      this.dayOpenedCache = d.charAt(7) !== '1';
      if (d.charAt(8) === '1') {
        this.nonFiscalOpen = true;
        this.printerState = 9;
      }
      this.trainingActive = d.charAt(10) === '1';
    }
    return {
      dayOpened: this.dayOpenedCache,
      nonFiscalDocOpen: d.charAt(8) === '1',
      trainingMode: this.trainingActive,
      rawStatus: d
    };
  }

  /** `riempiVarStatoPrinter` + controllo di setDate/setHeaderLine: coperchio aperto o carta finita -> stato errato (207). */
  private async assertPrinterReady(what: string): Promise<void> {
    const st = await this.getPrinterStatus();
    if (st.coverOpen || st.paperEmpty) {
      this.stateError(what, st.coverOpen ? 'coperchio aperto' : 'carta esaurita');
    }
  }

  // --- PreLine / PostLine ---

  /** Righe stampate PRIMA della prossima operazione di vendita (proprieta' `PreLine` del driver Java; consumata e azzerata). */
  setPreLine(text: string): void {
    this.preLineText = text ?? '';
  }
  /** Righe stampate DOPO la prossima operazione di vendita (proprieta' `PostLine` del driver Java; consumata e azzerata). */
  setPostLine(text: string): void {
    this.postLineText = text ?? '';
  }

  private extraLinePrefix(flag: boolean, post: boolean): string {
    if (!post) return this.payFlag ? (this.restoStep ? '3010' : '3008') : '3002';
    return flag ? (this.restoStep ? '3010' : '3008') : this.payFlag ? '3010' : '3002';
  }

  private async sendExtraLines(text: string, prefix: string): Promise<void> {
    for (const line of splitLines(text)) {
      const long = line.length > this.caps.messageLength;
      const pitch = long ? '3' : '1';
      const desc = formatDynamicDescription(line, long ? this.caps.messageLength42 : this.caps.messageLength);
      await this.executeCommand(`${prefix}${pitch}${desc}`, 10000);
    }
  }

  private async preLine(): Promise<void> {
    const t = this.preLineText;
    if (!t) return;
    await this.ensureIdentified();
    try {
      await this.sendExtraLines(t, this.extraLinePrefix(false, false));
    } finally {
      this.preLineText = '';
    }
  }

  private async postLine(flag: boolean): Promise<void> {
    const t = this.postLineText;
    if (!t) return;
    await this.ensureIdentified();
    try {
      await this.sendExtraLines(t, this.extraLinePrefix(flag, true));
    } finally {
      this.postLineText = '';
    }
  }

  // --- Filtro sequenze ESC ---

  /** `manageBarcode` del driver Java: `cmd + '0' + tipo + hri + '5' + lunghezza(3) + dati` (tetto 248, 190 per `3025`). */
  private async manageBarcode(type: string, rawData: string, cmd: string): Promise<void> {
    let data = sanitizeText(rawData, 'Dati barcode');
    let hri = '0';
    let strip = false;
    if (data.indexOf('{hri:1}') !== -1 || data.indexOf('{HRI:1}') !== -1) { hri = '2'; strip = true; }
    if (data.indexOf('{hri:0}') !== -1 || data.indexOf('{HRI:0}') !== -1) { hri = '0'; strip = true; }
    if (strip) data = data.substring(7);
    if (!(type >= '1' && type <= '9' && type.length === 1)) return; // tipo non valido: Java non invia nulla
    const cap = cmd === '3025' ? 190 : 248;
    await this.executeCommand(`${cmd}0${type}${hri}5${formatLen3Description(data, cap)}`);
  }

  /** Invia una riga con sequenze ESC (`FilterEscSeq` / `FilterEscSeqTrailerInvoice` / `FilterEscSeqCustomerFatt`). */
  private async sendEscLine(line: string, prefix: string, mode: EscFilterMode): Promise<void> {
    const p = parseEscSequenceLine(line, { mode, nonFiscalOpen: this.nonFiscalOpen });
    if (mode !== 'normal' || p.ops.some((o) => o.kind === 'feed')) await this.ensureIdentified();
    for (const op of p.ops) {
      if (op.kind === 'feed') {
        for (let i = 0; i < op.count; i++) {
          await this.executeCommand(`${prefix}1${formatDynamicDescription(' ', this.caps.messageLength)}`);
        }
      } else if (op.kind === 'bitmap') {
        const idx = op.index < 10 ? `00${op.index}` : `0${op.index}`;
        await this.executeCommand(`${mode === 'trailer' ? '3026' : '3017'}${idx}`);
      } else if (op.kind === 'barcode') {
        await this.manageBarcode(op.type, op.data, mode === 'trailer' ? '3025' : '3023');
      }
    }
    if (p.text.length === 0) return;
    if (mode === 'customer') {
      await this.executeCommand(`${prefix}C${formatDynamicDescription(p.text, this.caps.messageLength)}`);
    } else if (mode === 'trailer') {
      const desc =
        p.maxLen === 60 ? formatDynamicDescription(p.text, 60) : formatDynamicDescription(p.text, this.caps.messageLength42);
      await this.executeCommand(`${prefix}${p.maxLen === 60 ? 'D' : p.pitch}${desc}`);
    } else {
      await this.executeCommand(`${prefix}${p.pitch}${formatDynamicDescription(p.text, p.maxLen)}`);
    }
  }

  /** `PrintCustomerInfo`: righe cliente `3010C` + `CF/P.IVA:<conto>` (non per conti IVA che iniziano con `@`). */
  private async printCustomerInfoImpl(): Promise<void> {
    const inv = this.invoiceCtx;
    if (!inv) return;
    await this.ensureIdentified();
    try {
      if (!inv.taxId.startsWith('@')) {
        for (const l of inv.customerLines) await this.sendEscLine(l, '3010', 'customer');
        if (inv.taxId.length > 0) {
          await this.executeCommand(
            `3010C${formatDynamicDescription('CF/P.IVA:' + inv.taxId, this.caps.messageLength)}`,
            10000
          );
        }
      }
    } finally {
      inv.printCustomerInfo = false;
    }
  }

  /** Stampa i dati cliente della fattura (`PrintCustomerInfo`): chiamato automaticamente al primo pagamento. */
  async printCustomerInfo(): Promise<void> {
    await this.atomic(() => this.printCustomerInfoImpl());
  }

  /**
   * Registra la vendita di un articolo/servizio sullo scontrino fiscale RT.
   *
   * Come nel driver Java, solo se la quantità è diversa da 1 viene stampata la riga di dettaglio
   * `Qty [Unità ]x Prezzo` con il comando `3002` (timeout 10 s). PreLine/PostLine come Java.
   * Comando Custom RT: `33011` + Qty(9) + Reparto(3) + Descrizione + Prezzo unitario(9) + IVA(1 cifra). Timeout 10 s.
   * Reparto e IVA sono alternativi (vatInfo 10000..10029 del driver Java).
   *
   * @throws {RangeError} Reparto fuori 0..29, reparto e aliquota insieme, quantità/importi non validi.
   * @throws {CustomOperationNotAllowedError} Scontrino non aperto (114/207).
   */
  async printRecItem(item: FiscalItem): Promise<void> {
    const qty = item.quantity ?? 1;
    const priceCents = item.priceInCents;
    const { dept, vat } = this.resolveDeptVat(item.department, item.vatRate, 'articolo');

    if (qty !== 1 && item.unitPriceInCents === undefined) {
      throw new RangeError('unitPriceInCents è obbligatorio quando quantity !== 1');
    }
    const unitPrice = item.unitPriceInCents ?? priceCents;

    const strQty = formatQuantity(qty);
    const qtyTimes1000 = parseInt(strQty, 10);
    if (qtyTimes1000 !== 1000 && String(qtyTimes1000).length > 6) {
      throw new RangeError(`Quantità: fuori intervallo (ricevuto ${qty})`);
    }
    const strPrice = formatPrice(unitPrice);
    formatPrice(priceCents);
    sanitizeText(item.description, 'Descrizione');

    return this.atomic(async () => {
      this.guardNoNonFiscal('printRecItem');
      this.guardFiscalOpen('printRecItem');
      await this.ensureIdentified();
      const desc = formatDescription(item.description, this.descriptionLength);
      await this.preLine();

      if (qtyTimes1000 !== 1000) {
        const unit = item.unitName ? `${sanitizeText(item.unitName, 'Unità di misura')} ` : '';
        const detailLine = `${formatQty(qtyTimes1000)} ${unit}x ${formatSinglePrice(unitPrice)}`;
        await this.executeCommand(`30021${formatDynamicDescription(detailLine, detailLine.length)}`, 10000);
      }

      const cmd = `33011${strQty}${formatDepartment(dept)}${desc}${strPrice}${vat}`;
      await this.executeCommand(cmd, 10000);
      this.emptyTicket = false;
      await this.postLine(false);
    });
  }

  /**
   * Risolve reparto/aliquota come il `vatInfo` del driver Java: 10000..10029 = reparto (aliquota 0),
   * altrimenti aliquota (reparto 0). Il reparto 0 equivale a "non indicato".
   */
  private resolveDeptVat(
    department: number | undefined,
    vatRate: number | undefined,
    what: string
  ): { dept: number; vat: string; hasDept: boolean } {
    const dept = department ?? 0;
    assertIntRange(dept, 0, 29, `Reparto (${what})`);
    if (dept > 0 && vatRate !== undefined) {
      throw new RangeError(`Reparto e aliquota IVA sono alternativi (${what}): indicarne uno solo`);
    }
    return { dept, vat: dept > 0 ? '0' : formatVat(vatRate ?? 1), hasDept: dept > 0 };
  }

  /**
   * Registra uno sconto o una maggiorazione su articolo sullo scontrino RT.
   * Comandi: `33013` (sconto) / `33012` (maggiorazione) + Qty `000001000` + Reparto(3) + Descrizione dinamica + Importo(9) + IVA.
   */
  async printRecItemAdjustment(adjustment: ItemAdjustment): Promise<void> {
    if (!Number.isInteger(adjustment.amountInCents) || adjustment.amountInCents <= 0) {
      throw new RangeError(`amountInCents deve essere un intero > 0 (ricevuto ${adjustment.amountInCents})`);
    }
    const { dept, vat, hasDept } = this.resolveDeptVat(adjustment.department, adjustment.vatRate, 'sconto/maggiorazione');
    const cmdCode = adjustment.type === 'DISCOUNT' ? '33013' : '33012';
    const strQty = formatPrice(1000);
    const strAmount = formatPrice(adjustment.amountInCents);
    formatDynamicDescription(adjustment.description, this.descriptionLength);

    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecItemAdjustment');
      this.guardFiscalOpen('printRecItemAdjustment');
      await this.ensureIdentified();
      const desc = formatDynamicDescription(adjustment.description, this.descriptionLength);
      const deptStr = hasDept ? formatDepartment(dept) : formatDepartment(this.caps.printerArch === 3 ? 0 : 1);
      await this.preLine();
      await this.executeCommand(`${cmdCode}${strQty}${deptStr}${desc}${strAmount}${vat}`);
      await this.postLine(false);
    });
  }

  /** Stampa il Subtotale (`3003`), con PreLine/PostLine. */
  async printRecSubtotal(): Promise<void> {
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecSubtotal');
      this.guardFiscalOpen('printRecSubtotal');
      await this.preLine();
      await this.executeCommand('3003');
      await this.postLine(false);
    });
  }

  /**
   * Registra il pagamento (`3004`, oppure `3007` con `paymentId`).
   *
   * Come Java: con `expectedTotalInCents` (non zero) e opzione `checkTotal` verifica `1003` (`data[37..46)`);
   * se diverso esegue `resetPrinter()` e lancia errore 212. Al primo pagamento di una fattura stampa i dati
   * cliente (`3010C`). Dopo il pagamento legge `1011`/`1012` (se la fase di resto non e' ancora nota) e stampa PostLine.
   */
  async printRecTotal(payment: FiscalPayment): Promise<void> {
    const descText = payment.description || 'Contanti';
    const strPrice = formatPrice(payment.amountInCents);

    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecTotal');
      this.guardFiscalOpen('printRecTotal');
      if (this.rtDoc) {
        // Documento RT di reso/annullo (RTDocType 1/2): Java non invia alcun pagamento, segna solo la fase
        // di chiusura (payFlag, PrinterState 4, bRestoStep) e termina; la chiusura e' `endFiscalReceipt`.
        this.payFlag = true;
        this.printerState = 4;
        this.restoStep = true;
        return;
      }
      await this.ensureIdentified();
      const expected = payment.expectedTotalInCents ?? 0;
      if (expected !== 0 && this.checkTotal && this.caps.printerArch !== 2) {
        const r = await this.executeCommand('1003');
        const cur = parseInt(r.data.substring(37, 46), 10);
        if (cur !== expected) {
          await this.resetPrinter();
          throw new CustomOperationNotAllowedError('Totale non corrispondente', '1003', 114, 212);
        }
      }
      if (this.invoiceCtx && !this.payFlag && this.invoiceCtx.printCustomerInfo) {
        await this.printCustomerInfoImpl();
      }

      if (payment.paymentId !== undefined && payment.paymentId > 0) {
        const paymentIndex = formatNumberPad(payment.paymentId, 2);
        const strDesc = formatDynamicDescription(descText, this.caps.descriptionLengthPayment);
        await this.executeCommand(`3007${paymentIndex}00${strDesc}${strPrice}`);
      } else {
        const strDesc = formatDynamicDescription(descText, this.caps.descriptionLengthPayment);
        await this.executeCommand(`3004${strDesc}${strPrice}`);
      }
      if (!this.restoStep) await this.refreshStep();
      await this.postLine(true);
      this.payFlag = true;
    });
  }

  /**
   * Chiude definitivamente lo scontrino fiscale RT (`endFiscalReceipt` del driver Java).
   *
   * Sequenza: righe reso `30101` (solo scontrino reso) -> dati cliente fattura (se non gia' stampati e RT non in
   * servizio) -> POS id / cassiere (`3024`+'1' con RT, altrimenti `3010`) -> `3010P12` numero reso -> righe di
   * cortesia (`3024`/`3026` logo/`3025` barcode) -> `3011` o `30112` (30 s) -> messaggi bufferizzati dopo il pagamento
   * (`3002`, o `3012` su stampanti non RX) -> `3013` (30 s). Con ERR05 sulla chiusura la procedura termina subito.
   *
   * @throws {CustomOperationNotAllowedError} Fuori sequenza: pagamento non registrato o resto non raggiunto (114/207).
   */
  async endFiscalReceipt(options?: { printDetails?: boolean; trailerLines?: string[] }): Promise<void> {
    return this.atomic(() => this.endFiscalReceiptImpl(options));
  }

  private async endFiscalReceiptImpl(options?: { printDetails?: boolean; trailerLines?: string[] }): Promise<void> {
    this.guardNoNonFiscal('endFiscalReceipt');
    if (this.stateChecks && (!this.payFlag || this.restoStep === false)) {
      this.stateError('endFiscalReceipt', 'lo stato della stampante non consente la chiusura');
    }
    const trailers = [...this.beginTrailerLines, ...(options?.trailerLines ?? [])];
    for (const line of trailers) {
      // validazione preventiva del testo
      const p = parseEscSequenceLine(line, { mode: 'trailer' });
      formatDynamicDescription(p.text, 60);
    }
    if (options?.printDetails !== false || trailers.length > 0) await this.ensureIdentified();
    await this.endTail(trailers, options?.printDetails !== false, false);
  }

  /** Parte comune a `endFiscalReceipt` e `endFiscalReceiptbyReset`. */
  private async endTail(trailers: string[], wantDetails: boolean, byReset: boolean): Promise<void> {
    const rt = this.caps.rtMode === 3;
    if (this.refundReceipt) {
      for (const l of [this.refundLine1, this.refundLine2]) {
        if (l.length > 0) await this.executeCommand(`30101${formatDynamicDescription(l, this.caps.messageLength)}`, 10000);
      }
      this.refundLine1 = '';
      this.refundLine2 = '';
    }
    if (this.invoiceCtx && !rt && !byReset && this.invoiceCtx.printCustomerInfo) await this.printCustomerInfoImpl();
    const idPrefix = rt ? '3024' : '3010';
    if (this.posId.length > 0) {
      await this.executeCommand(`${idPrefix}1${formatDynamicDescription(this.posId, this.caps.messageLength)}`, 10000);
    }
    if (this.cashierId.length > 0) {
      await this.executeCommand(`${idPrefix}1${formatDynamicDescription(this.cashierId, this.caps.messageLength)}`, 10000);
    }
    if (this.refundNumber.length > 0) {
      await this.executeCommand(`3010P12${this.refundNumber.padStart(12, '0')}`, 10000);
    }
    for (const line of trailers) await this.sendEscLine(line, '3024', 'trailer');

    this.fiscalOpen = false;
    const useDetails = !byReset && wantDetails && rt && this.caps.rxPrinter;
    const res = await this.executeCommand(useDetails ? '30112' : '3011', 30000);
    if (res.ignoredErrorCode === 5) {
      this.logger?.warn?.('ERR05 sulla chiusura scontrino: procedura interrotta (come driver Java)');
      this.payFlag = false;
      this.restoStep = undefined;
      return;
    }
    if (this.recMessageBuffer.length > 0) {
      const prefix = this.caps.printerArch === 3 ? '3002' : '3012';
      const msgs = splitLines(this.recMessageBuffer);
      this.recMessageBuffer = '';
      for (const l of msgs) await this.sendEscLine(l, prefix, 'normal');
    }
    await this.executeCommand('3013', 30000);
    this.resetDocumentState();
    // Java (endFiscalReceipt/endFiscalReceiptbyReset @596-608): azzera codice fiscale e lotteria in attesa, resetLottery = false
    this.fiscalCodeField = '';
    this.pseudoLottery = '';
  }

  /**
   * Annulla l'intero scontrino fiscale in corso PRIMA del pagamento.
   * Comando Custom: `30018` + descrizione dinamica (max `descriptionLength`) + `000000000`
   */
  async printRecVoid(description: string = 'ANNULLO'): Promise<void> {
    formatDynamicDescription(description, this.descriptionLength);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecVoid');
      await this.ensureIdentified();
      const desc = formatDynamicDescription(description, this.descriptionLength);
      await this.executeCommand(`30018${desc}000000000`);
      this.fiscalOpen = false;
      this.payFlag = false;
      this.restoStep = undefined;
      this.printerState = 1;
    });
  }

  // --- OPERAZIONI AGGIUNTIVE DI SCONTRINO (port di FiscalPrinterService) ---

  /** `vatInfo` Java: 10000..10030 = reparto (aliquota 0), altrimenti aliquota intera. */
  private splitVatInfo(vatInfo: number | undefined): { dept: number; vat: number } {
    const v = vatInfo ?? 0;
    if (v >= 10000 && v < 10031) return { dept: v - 10000, vat: 0 };
    return { dept: 1, vat: v };
  }

  /** Come `formattaVatInfo` (2 cifre; <=0 o >20 -> 1) */
  private vat2(vat: number): string {
    return (vat <= 0 || vat > 20 ? 1 : vat).toString().padStart(2, '0');
  }

  /**
   * Storno articolo RT (`printRecItemVoid`): `33014` + Qty(9) + Reparto(3) + Descrizione dinamica + Prezzo unitario(9) + IVA (intero).
   * Errore 114/207 se non e' ancora stato venduto nulla. Timeout 8 s.
   */
  async printRecItemVoid(item: ItemVoid): Promise<void> {
    const desc0 = sanitizeText(item.description, 'Descrizione');
    const qty = formatQuantity(item.quantity ?? 1);
    const unit = formatPrice(item.unitPriceInCents ? item.unitPriceInCents : item.priceInCents);
    formatPrice(item.priceInCents);
    const { dept, vat } = this.splitVatInfo(item.vatInfo);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecItemVoid');
      this.guardFiscalOpen('printRecItemVoid');
      if (this.stateChecks && this.emptyTicket) this.stateError('printRecItemVoid', 'nessun articolo registrato');
      await this.ensureIdentified();
      const desc = formatDynamicDescription(desc0, this.descriptionLength);
      await this.preLine();
      await this.executeCommand(`33014${qty}${formatDepartment(dept)}${desc}${unit}${vat}`);
      await this.postLine(false);
    });
  }

  /** Storno ultima riga (`printRecVoidItem`): `30014` + Descrizione dinamica + Importo(9). Timeout 8 s. */
  async printRecVoidItem(description: string, amountInCents: number): Promise<void> {
    sanitizeText(description, 'Descrizione');
    const price = formatPrice(amountInCents);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecVoidItem');
      this.guardFiscalOpen('printRecVoidItem');
      await this.ensureIdentified();
      const desc = formatDynamicDescription(description, this.descriptionLength);
      await this.preLine();
      await this.executeCommand(`30014${desc}${price}`);
      await this.postLine(false);
    });
  }

  /**
   * Reso/recupero su scontrino (`printRecRefund`). RT in servizio: `33014` + `000001000` + Reparto + Descrizione
   * (default "Recupero") + Importo + IVA, con errore 207 se nessun articolo; altrimenti `31019` + IVA(2) + Descrizione + Importo.
   */
  async printRecRefund(refund: { description?: string; amountInCents: number; vatInfo?: number }): Promise<void> {
    const price = formatPrice(refund.amountInCents);
    const text = sanitizeText(refund.description || 'Recupero', 'Descrizione');
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecRefund');
      this.guardFiscalOpen('printRecRefund');
      await this.ensureIdentified();
      const desc = formatDynamicDescription(text, this.descriptionLength);
      if (this.caps.rtMode === 3) {
        const { dept, vat } = this.splitVatInfo(refund.vatInfo);
        if (this.stateChecks && this.emptyTicket) this.stateError('printRecRefund', 'nessun articolo registrato');
        await this.preLine();
        await this.executeCommand(`33014${formatPrice(1000)}${formatDepartment(dept)}${desc}${price}${vat}`);
        await this.postLine(false);
      } else {
        await this.preLine();
        await this.executeCommand(`31019${this.vat2(refund.vatInfo ?? 1)}${desc}${price}`);
        await this.postLine(false);
        this.emptyTicket = false;
      }
    });
  }

  /** Non pagato (`printRecNotPaid`): `3005` + Descrizione (max descriptionLengthPayment) + Importo(9). Imposta la fase di pagamento. */
  async printRecNotPaid(description: string, amountInCents: number): Promise<void> {
    sanitizeText(description, 'Descrizione');
    const price = formatPrice(amountInCents);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecNotPaid');
      this.guardFiscalOpen('printRecNotPaid');
      await this.ensureIdentified();
      if (this.invoiceCtx && this.caps.rtMode === 3 && this.invoiceCtx.printCustomerInfo) {
        await this.printCustomerInfoImpl();
      }
      await this.preLine();
      await this.executeCommand(`3005${formatDynamicDescription(description, this.caps.descriptionLengthPayment)}${price}`);
      this.payFlag = true;
      if (!this.restoStep) await this.refreshStep();
      await this.postLine(true);
    });
  }

  /**
   * Sconto/maggiorazione su subtotale (`printRecSubtotalAdjustment`): `30013` (sconto) / `30012` (maggiorazione)
   * + Descrizione dinamica + Importo(9). Errore 207 se nessun articolo. Timeout 8 s.
   * (Il metodo Java di annullo `printRecSubtotalAdjustVoid` lancia JPOS 106: non esiste un equivalente.)
   */
  async printRecSubtotalAdjustment(kind: 'DISCOUNT' | 'MARKUP', description: string, amountInCents: number): Promise<void> {
    sanitizeText(description, 'Descrizione');
    const price = formatPrice(amountInCents);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecSubtotalAdjustment');
      this.guardFiscalOpen('printRecSubtotalAdjustment');
      if (this.stateChecks && this.emptyTicket) this.stateError('printRecSubtotalAdjustment', 'nessun articolo registrato');
      await this.ensureIdentified();
      await this.preLine();
      await this.executeCommand(
        `${kind === 'DISCOUNT' ? '30013' : '30012'}${formatDynamicDescription(description, this.descriptionLength)}${price}`
      );
      await this.postLine(false);
    });
  }

  /**
   * Annullo di rettifica articolo (`printRecItemAdjustmentVoid`): `31012` (sconto) / `31013` (maggiorazione)
   * + IVA(2 cifre; 10000..10030 -> reparto) + Descrizione dinamica + Importo(9). Errore 207 se nessun articolo. Timeout 8 s.
   */
  async printRecItemAdjustmentVoid(kind: 'DISCOUNT' | 'MARKUP', description: string, amountInCents: number, vatInfo: number = 1): Promise<void> {
    sanitizeText(description, 'Descrizione');
    const price = formatPrice(amountInCents);
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecItemAdjustmentVoid');
      this.guardFiscalOpen('printRecItemAdjustmentVoid');
      if (this.stateChecks && this.emptyTicket) this.stateError('printRecItemAdjustmentVoid', 'nessun articolo registrato');
      await this.ensureIdentified();
      const v = vatInfo >= 10000 && vatInfo < 10031 ? vatInfo - 10000 : vatInfo;
      await this.preLine();
      await this.executeCommand(
        `${kind === 'DISCOUNT' ? '31012' : '31013'}${this.vat2(v)}${formatDynamicDescription(description, this.descriptionLength)}${price}`
      );
      await this.postLine(false);
    });
  }

  /**
   * Messaggio sullo scontrino (`printRecMessage`): ogni riga (con sequenze ESC) come `3002`. Dopo l'inizio del
   * pagamento i messaggi sono bufferizzati e stampati dopo la chiusura (`3011`).
   */
  async printRecMessage(message: string): Promise<void> {
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecMessage');
      this.guardFiscalOpen('printRecMessage');
      await this.preLine();
      if (this.payFlag && message.length > 0) {
        this.recMessageBuffer += message + '\r\n';
      } else if (!this.payFlag) {
        for (const line of splitLines(message)) await this.sendEscLine(line, '3002', 'normal');
      }
      await this.postLine(false);
    });
  }

  /**
   * Imposta codice lotteria / codice fiscale (`printRecTaxID`): `id` e' "lotteria", "codice fiscale" oppure
   * "lotteria|codice fiscale". Legge `1012`; ERR03/ERR05 = non consentito. Fase 1/4 (o 0 con scontrino aperto): invio
   * immediato (`3019` / `3010B`); fase 0 senza scontrino: conservato per il prossimo `beginFiscalReceipt`.
   */
  async printRecTaxID(id: string): Promise<void> {
    const parts = this.splitStr2(sanitizeText(id, 'Identificativo'), '|');
    let lottery = '';
    let fiscal = '';
    if (parts.length === 1) {
      parts[0] = parts[0].trim();
      lottery = parts[0];
      if (lottery.length === 8) {
        lottery = parts[0];
      } else if (lottery.length === 11 || lottery.length === 16) {
        fiscal = lottery;
        lottery = '';
      }
    }
    if (parts.length >= 2) {
      parts[0] = parts[0].trim();
      parts[1] = parts[1].trim();
      // Java: `if (p[0].length > 0) lottery = p[0]; else if (p[1].length > 0) fiscal = p[1]` (il secondo e' ignorato se c'e' la lotteria)
      if (parts[0].length > 0) lottery = parts[0];
      else if (parts[1].length > 0) fiscal = parts[1];
    }
    await this.atomic(async () => {
      this.guardNoNonFiscal('printRecTaxID');
      this.pseudoLottery = '';
      this.fiscalCodeField = '';
      const r = await this.executeCommand('1012');
      if (r.ignoredErrorCode === 3 || r.ignoredErrorCode === 5) {
        throw new CustomOperationNotAllowedError('Operazione non consentita', '1012');
      }
      const state = parseInt(r.data.charAt(0), 10);
      if (lottery.length > 0) {
        this.pseudoLottery = lottery;
        if (state === 1 || state === 4 || (state === 0 && this.fiscalOpen)) {
          const res = await this.sendLottery(this.pseudoLottery);
          if (res.ignoredErrorCode === undefined && !res.isError) this.resetLotteryFlag = true;
        } else if (state !== 0) {
          this.stateError('printRecTaxID', 'wrong FPU STATE');
        }
      }
      if (fiscal.length > 0) {
        this.fiscalCodeField = fiscal;
        if (state === 1 || state === 4) {
          await this.executeCommand(`3010B${formatDynamicDescription(this.fiscalCodeField, 24)}`);
        } else if (state !== 0) {
          this.stateError('printRecTaxID', 'wrong FPU STATE');
        }
      }
      if (lottery.length === 0 && fiscal.length === 0) {
        this.pseudoLottery = '';
        this.fiscalCodeField = '';
      }
    });
  }

  /**
   * `splitStr2` di Java: `StringTokenizer` sul separatore (token vuoti scartati); se la stringa inizia col separatore ed e'
   * lunga > 2 viene anteposto uno spazio (primo token vuoto dopo il trim). Con stringhe di 2 caratteri che iniziano col
   * separatore Java va in ArrayIndexOutOfBounds: qui RangeError (DEVIATION a: crash Java).
   */
  private splitStr2(str: string, sep: string): string[] {
    let s = str;
    if (s.indexOf(sep) === 0 && s.length > 2) s = ' ' + s;
    const tokens = s.split(sep).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    if (s.indexOf(sep) === 0) throw new RangeError('printRecTaxID: formato non valido');
    return tokens;
  }

  /** `setPOSID`: legge `1010` e memorizza POS e cassiere, stampati a `endFiscalReceipt`. */
  async setPosId(posId: string, cashierId: string): Promise<void> {
    await this.atomic(async () => {
      await this.getFiscalState();
      this.posId = sanitizeText(posId, 'POS');
      this.cashierId = sanitizeText(cashierId, 'Cassiere');
    });
  }

  /**
   * Dati del reso (`directIO -35004` del driver Java): numero (stampato a fine scontrino con `3010P12`) e fino a due
   * righe aggiuntive (`30101`, solo scontrino aperto con `refund: true`).
   */
  setRefundInfo(info: { number?: number | string; line1?: string; line2?: string }): void {
    this.refundNumber = info.number === undefined ? '' : String(info.number);
    this.refundLine1 = info.line1 ?? '';
    this.refundLine2 = info.line2 ?? '';
  }

  /** `getNotPayed`: importo non pagato (`1003`, `data[46..56)`: il primo carattere e' scartato come in Java). */
  private async readNotPaid(): Promise<number> {
    const r = await this.executeCommand('1003', 10000);
    const n = parseInt(r.data.substring(47, 56), 10);
    return isNaN(n) ? 0 : n;
  }

  /**
   * `resetPrinter` del driver Java: riporta la stampante allo stato libero. Chiude un eventuale documento non fiscale
   * (`4004`), legge 1109/1011/1012/1010 e, secondo la fase: vendita -> `33018` (RT) o `310180100000000000` (timeout 15 s);
   * pagamento -> idem su RX, altrimenti paga il residuo con "PAGAMENTO PER ANNULLO"; chiusura -> solo taglio `3013` o
   * `310180100000000000`. Infine `71020`, `64301` se in addestramento, `301900` se il codice lotteria era stato ACCETTATO da `beginFiscalReceipt` (flag `resetLottery` di Java: vero solo se la risposta a `3019` non contiene alcun ERR).
   */
  async resetPrinter(): Promise<void> {
    await this.atomic(async () => {
      await this.ensureIdentified();
      if (this.nonFiscalOpen) await this.endNonFiscal();
      await this.getPrinterStatus();
      await this.refreshStep();
      await this.getFiscalState();
      const rt = this.caps.rtMode === 3;
      const rx = this.caps.rxPrinter;
      const abort = () => this.executeCommand(rt ? '33018' : '310180100000000000', 15000);
      switch (this.printerState) {
        case 2:
          await abort();
          if (!rx) await this.endFiscalReceiptByReset();
          break;
        case 3:
          if (rx) {
            await abort();
          } else {
            const rest = await this.readNotPaid();
            this.fiscalOpen = true;
            await this.printRecTotal({ amountInCents: rest, description: 'PAGAMENTO PER ANNULLO' });
          }
          break;
        case 4:
          if (rx) {
            if (this.onlyCut) await this.cutPaper();
            else await this.executeCommand('310180100000000000');
          } else if (this.onlyCut) await this.cutPaper();
          else await this.endFiscalReceiptByReset();
          this.onlyCut = false;
          break;
        case 9:
          await this.endNonFiscal();
          break;
        default:
          break;
      }
      this.nonFiscalOpen = false;
      this.fiscalOpen = false;
      await this.executeCommand('71020');
      const wasLottery = this.resetLotteryFlag;
      this.resetDocumentState();
      if (this.trainingActive) await this.endTraining();
      this.fiscalCodeField = '';
      this.pseudoLottery = '';
      if (wasLottery) await this.executeCommand('301900');
    });
  }

  /**
   * `endFiscalReceiptbyReset`: chiusura `3011` (30 s) usata dal reset sulle stampanti non RX. Come in Java invia le
   * righe reso `30101`, POS/cassiere, `3010P12` e le righe di cortesia (`3024`) gia' impostate, ma non stampa i dati
   * cliente della fattura ne' il riepilogo `30112`.
   */
  private async endFiscalReceiptByReset(): Promise<void> {
    await this.endTail([...this.beginTrailerLines], false, true);
  }

  /**
   * Esegue il taglio fisico della carta.
   * 
   * Comando Custom: `3013` (timeout 30 s, come Java)
   */
  async cutPaper(): Promise<void> {
    await this.executeCommand('3013', 30000);
  }

  // --- DOCUMENTI COMMERCIALI DI RESO E ANNULLO RT ---

  /**
   * Emette un Documento Commerciale di RESO RT (`DOC_RESO`) collegato a un precedente scontrino emesso.
   * 
   * Wrapper di `beginFiscalReceipt({ rtDocument: { type: 'refund', ... } })` (RTDocType 1 del driver Java):
   * dopo `71020`/`71021` ASK `7101R` con modalità sempre `0`, poi, se la stampante risponde 0 o 1, PERFORM con `8`
   * (`noPreview`) oppure `1`. Risposta 2 o ERR03/ERR05 = operazione non consentita.
   * IL DOCUMENTO RESTA APERTO (`documentOpen: true`): registrare gli articoli resi (`printRecItem`),
   * `printRecTotal` e chiudere con `endFiscalReceipt`. Ha effetto solo con RT in servizio. Riferimento a:
   * - Numero azzeramento Z (`ZZZZ`)
   * - Numero scontrino (`NNNN`)
   * - Data di emissione (`DDMMYY`)
   * - Matricola della stampante originale che ha emesso il documento
   * 
   * @param options Parametri del documento di reso
   * @throws {CustomOperationNotAllowedError} Se la stampante rifiuta il reso (risposta 2 o ERR03/ERR05).
   * @throws {CustomFiscalError} Se lo scontrino di riferimento non è valido o è già stato reso/annullato.
   */
  async printRefundReceipt(options: RefundOptions): Promise<DocumentEmissionResult> {
    return this.emitRtDocument('refund', options);
  }

  /**
   * Emette un Documento Commerciale di ANNULLO RT (`DOC_ANNULLO`) collegato a un precedente scontrino.
   *
   * Wrapper di `beginFiscalReceipt({ rtDocument: { type: 'void', ... } })`: ASK `7101A` (`0`, oppure `8` con
   * `noPreview`), poi PERFORM `1`. Se la stampante risponde 1 al PERFORM ha chiuso lei il documento
   * (`documentOpen: false`); altrimenti il documento resta aperto e va chiuso con `endFiscalReceipt`.
   * Uno stesso documento non e' annullabile due volte. Ha effetto solo con RT in servizio.
   *
   * @param options Parametri del documento da annullare
   * @throws {CustomOperationNotAllowedError} Se la stampante rifiuta l'annullo.
   * @throws {CustomFiscalError} Se il documento e' gia' stato annullato o non trovato.
   */
  async printVoidReceipt(options: VoidOptions): Promise<DocumentEmissionResult> {
    return this.emitRtDocument('void', options);
  }

  private async emitRtDocument(type: 'refund' | 'void', options: RefundOptions | VoidOptions): Promise<DocumentEmissionResult> {
    return this.atomic(async () => {
      // validazione preventiva prima di inviare comandi
      this.buildRtDoc({ type, ...options });
      await this.ensureIdentified();
      if (this.caps.rtMode !== 3) {
        return { emitted: false, documentOpen: false, reason: 'RT non in servizio (RTMode != 3): documento non emesso' };
      }
      const r = await this.beginFiscalReceiptImpl({ rtDocument: { type, ...options } });
      return {
        emitted: r.rtDocumentEmitted === true,
        documentOpen: r.documentOpen,
        ...(r.rtDocumentEmitted === true ? {} : { reason: 'risposta ASK inattesa: PERFORM non inviato' })
      };
    });
  }

  /**
   * Java ispeziona la risposta testuale ("ERR03"/"ERR05") dei comandi 7101x: con la policy `java` questi
   * errori sono ignorati da `handleCustomError` ma restano visibili (`ignoredErrorCode`) e il driver
   * li trasforma in "Operation not allowed".
   */
  private assertNoIgnoredRejection(ignoredErrorCode: number | undefined, command: string): void {
    if (ignoredErrorCode === 3 || ignoredErrorCode === 5) {
      throw new CustomOperationNotAllowedError('Operazione non consentita', command);
    }
  }

  // --- DOCUMENTO NON FISCALE (GESTIONALE) ---

  /**
   * Inizia un documento non fiscale / gestionale (es. promemoria, scontrino di cortesia, report interno).
   * 
   * Comandi Custom: `40011` e opzionale `4002` per l'intestazione grafica/testuale.
   * 
   * @param options Opzioni documento non fiscale:
   *  - `printHeader`: Se false, sopprime la stampa dell'intestazione (equivalente a PreLine = "NOHEADER").
   */
  async beginNonFiscal(options?: NonFiscalOptions): Promise<void> {
    return this.atomic(async () => {
      this.guardNoFiscal('beginNonFiscal');
      if (this.stateChecks && this.nonFiscalOpen) this.stateError('beginNonFiscal', 'documento non fiscale gia\' aperto');
      await this.executeCommand('40011');
      this.nonFiscalOpen = true;
      this.printerState = 9;
      if (options?.printHeader !== false && this.printHeaderFlag) {
        await this.executeCommand('4002');
      }
    });
  }

  /**
   * Stampa una riga nel documento non fiscale. Con uno scontrino fiscale aperto equivale a `printRecMessage`
   * (comandi `3002`), come `printNormal` del driver Java; senza alcun documento aperto lancia 114/207.
   *
   * Sequenze ESC (helper `Esc`): stili, allineamento, `Esc.feed(n)`, `Esc.bitmap(n)` (`3017` + indice a 3 cifre),
   * `Esc.barcode(tipo, codice, {hri})` (`3023` + `0` + tipo + hri + `5` + lunghezza a 3 cifre + dati).
   * Comando Custom: `4003` + pitch + descrizione dinamica (lunghezza reale, max 44).
   *
   * @param text Testo della riga con eventuali sequenze di escape.
   */
  async printNormal(text: string): Promise<void> {
    return this.atomic(async () => {
      if (this.fiscalOpen) {
        await this.printRecMessage(text);
        return;
      }
      if (this.stateChecks && !this.nonFiscalOpen) {
        this.stateError('printNormal', 'nessun documento aperto');
      }
      for (const line of splitLines(text)) {
        await this.sendEscLine(line, '4003', 'normal');
      }
    });
  }

  /**
   * Chiude il documento non fiscale corrente e taglia la carta.
   * Comando Custom: `4004`. Errore 114/207 se non e' aperto un documento non fiscale.
   */
  async endNonFiscal(): Promise<void> {
    await this.atomic(async () => {
      this.guardNoFiscal('endNonFiscal');
      if (this.stateChecks && !this.nonFiscalOpen) this.stateError('endNonFiscal', 'documento non fiscale non aperto');
      await this.executeCommand('4004');
      this.nonFiscalOpen = false;
      this.printerState = 1;
    });
  }

  // --- CHIUSURE FISCALI E REPORT ---

  /**
   * Esegue l'Azzeramento Fiscale Giornaliero (**Z-Report**) con contestuale
   * trasmissione telematica dei corrispettivi all'Agenzia delle Entrate per i modelli RT.
   * 
   * Attenzione: questa operazione chiude la giornata fiscale e trasmette i dati all'AdE.
   * Non può essere eseguita più di una volta nello stesso giorno fiscale senza vendite intermedie.
   * 
   * Comando Custom: `2002`
   */
  async printZReport(): Promise<void> {
    await this.atomic(async () => {
      this.guardNoNonFiscal('printZReport');
      this.guardNoFiscal('printZReport');
      // polling sospeso come `bUpdateStatus = false` di Java (ripristinato anche in caso di errore)
      await this.withPollingPaused(async () => {
        await this.executeCommand('2002', 180000); // Fino a 3 minuti per completamento e trasmissione
        await this.waitPendingOperation();
        this.dayOpenedCache = false; // `DayOpened = false` dopo lo Z di Java
      });
    });
  }

  /**
   * Attende il completamento delle operazioni pendenti della stampante (es. trasmissione RT dopo lo Z-report).
   * Port di `WaitPrinterPendigOperation` del driver Java: pausa di 2 s, poi comando `1513` (timeout 40 s),
   * ripetuto fino a 3 volte solo in caso di errore; al terzo errore l'eccezione viene propagata.
   *
   * Comando Custom: `1513`
   */
  async waitPendingOperation(): Promise<void> {
    await this.atomic(async () => {
      await sleep(this.pendingOperationDelayMs);
      for (let attempt = 1; ; attempt++) {
        try {
          await this.executeCommand('1513', 40000);
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
          this.logger?.warn?.(`Attesa operazioni pendenti (1513): tentativo ${attempt} fallito`, {
            error: (e as Error).message
          });
        }
      }
    });
  }

  /**
   * Esegue la Lettura Finanziaria (**X-Report**) senza azzerare i contatori giornalieri
   * e senza trasmettere all'Agenzia delle Entrate.
   * 
   * Comando Custom: `2003`
   */
  async printXReport(): Promise<void> {
    await this.atomic(async () => {
      this.guardNoNonFiscal('printXReport');
      this.guardNoFiscal('printXReport');
      await this.withPollingPaused(() => this.executeCommand('2003')); // 8 s come Java
    });
  }

  /**
   * Stampa il report periodico dei corrispettivi per intervallo di date.
   * 
   * Comando Custom: `5002` + dataInizio + dataFine
   * 
   * @param startDate Data iniziale (Date o stringa DDMMYY)
   * @param endDate Data finale (Date o stringa DDMMYY)
   */
  async printPeriodicTotalsReport(startDate: Date | string, endDate: Date | string): Promise<void> {
    const s = formatDateDDMMYY(startDate);
    const e = formatDateDDMMYY(endDate);
    await this.atomic(() => this.withPollingPaused(() => this.executeCommand(`5002${s}${e}`))); // 8 s come Java
  }

  /**
   * Stampa il report periodico dei corrispettivi per intervallo di numeri di azzeramento Z.
   * 
   * Comando Custom: `5001` + startZ + endZ
   * 
   * @param startZ Numero primo azzeramento Z (es. 1)
   * @param endZ Numero ultimo azzeramento Z (es. 100)
   */
  async printPeriodicReportByNumber(startZ: number, endZ: number): Promise<void> {
    const s = formatNumberPad(startZ, 4);
    const e = formatNumberPad(endZ, 4);
    await this.atomic(() => this.withPollingPaused(() => this.executeCommand(`5001${s}${e}`))); // 8 s come Java
  }

  // --- CASSETTO RENDIRESTO E DISPLAY CLIENTE ---

  /**
   * Invia l'impulso di apertura al cassetto rendiresto collegato alla porta RJ11/RJ12 della stampante.
   *
   * Comando Custom: `70081` (8 s). Come `CashDrawerService.openDrawer` del driver Java (`internalIOCashDrawer`
   * dentro un blocco che cattura `JposException`), eventuali errori di comando o di comunicazione NON vengono
   * propagati: sono solo registrati con `logger.warn`.
   */
  async openDrawer(): Promise<void> {
    try {
      await this.executeCommand('70081', 8000);
    } catch (e) {
      this.logger?.warn?.('openDrawer: errore ignorato (come CashDrawerService Java)', { error: (e as Error).message });
    }
  }

  // --- DISPLAY CLIENTE (LineDisplayService del driver Java) ---

  /** `currentDisplay` di Java: 40 caratteri (2 righe x 20 colonne). */
  private displayBuffer = ' '.repeat(40);
  /** `CursorRow` / `CursorColumn` di Java */
  private cursorRow = 0;
  private cursorCol = 0;

  /**
   * Port di `formatForDisplay` + `scrollLine`: scrive `text` nel buffer da `20*riga + colonna%20`.
   * Se supera 40 caratteri il buffer viene azzerato (`scrollLine` = 40 spazi) e rimane solo la parte in eccesso.
   * Restituisce il nuovo buffer e il cursore risultante (`tempCursorRow`/`tempCursorColumn`), senza applicarli.
   */
  private formatForDisplay(text: string): { buffer: string; row: number; col: number } {
    const cur = this.displayBuffer;
    const pos = 20 * this.cursorRow + (this.cursorCol % 20);
    let end = pos + text.length;
    let buffer = '';
    if (end < 40) buffer = cur.substring(0, pos) + text + cur.substring(end, 40);
    if (end === 40) buffer = cur.substring(0, pos) + text;
    if (end > 40) {
      const scrolled = ' '.repeat(40); // scrollLine
      end -= 40;
      buffer = text.substring(text.length - end, text.length) + scrolled.substring(end - 1, 39);
    }
    return { buffer, row: Math.floor(end / 20), col: end % 20 };
  }

  /**
   * Testo sul display cliente 2x20 (`LineDisplayService.displayText` del driver Java). Il testo e' scritto a partire
   * dalla POSIZIONE CORRENTE DEL CURSORE sopra il contenuto esistente (buffer di 40 caratteri) e il cursore avanza;
   * oltre la fine il display scorre. Testo > 40 caratteri: tronco a 40. Comando `7007` + 40 caratteri (8 s).
   *
   * CAMBIAMENTO rispetto alle versioni precedenti, che scrivevano sempre da colonna 0 con riempimento di spazi.
   * Per cancellare l'intero display usare `clearDisplay()`.
   *
   * @param text Messaggio per il display (es. "TOTALE: 15.50 €")
   */
  async displayText(text: string): Promise<void> {
    const t = sanitizeText(text, 'Testo display').substring(0, 40);
    await this.atomic(async () => {
      const f = this.formatForDisplay(t);
      await this.executeCommand(`7007${f.buffer}`, 8000);
      this.displayBuffer = f.buffer;
      this.cursorRow = f.row;
      this.cursorCol = f.col;
    });
  }

  /**
   * Testo sul display a una posizione (`displayTextAt` di Java: imposta riga 0..1 e colonna 0..19 del cursore,
   * poi `displayText`).
   */
  async displayTextAt(row: number, col: number, text: string): Promise<void> {
    assertIntRange(row, 0, 1, 'Riga display');
    assertIntRange(col, 0, 19, 'Colonna display');
    const t = sanitizeText(text, 'Testo display');
    await this.atomic(async () => {
      this.cursorRow = row;
      this.cursorCol = col;
      await this.displayText(t);
    });
  }

  /**
   * `clearText` di Java: esegue `displayText('')` e riporta il cursore a (0,0). ATTENZIONE: nel bytecode Java questo
   * RIINVIA il contenuto corrente senza cancellarlo (con testo vuoto `formatForDisplay` restituisce il buffer
   * invariato). Per svuotare davvero il display usare `clearDisplay()`.
   */
  async clearText(): Promise<void> {
    await this.atomic(async () => {
      await this.displayText('');
      this.cursorRow = 0;
      this.cursorCol = 0;
    });
  }

  /**
   * Cancella il display cliente: invia `7007` + 40 spazi e azzera buffer e cursore. Non e' un metodo di
   * `LineDisplayService` (Java non cancella con `clearText`): equivale a `directIO 1301`, ma riallinea lo stato locale.
   */
  async clearDisplay(): Promise<void> {
    await this.atomic(async () => {
      await this.executeCommand(`7007${' '.repeat(40)}`, 8000);
      this.displayBuffer = ' '.repeat(40);
      this.cursorRow = 0;
      this.cursorCol = 0;
    });
  }

  // --- PROGRAMMAZIONE E GESTIONE TABELLA IVA ---

  /**
   * Legge la tabella delle aliquote IVA programmate nella memoria fiscale della stampante.
   * 
   * Comando Custom: `7012` (come `getVatEntry` del driver Java: la risposta e' di 6 aliquote da 4 cifre,
   * l'aliquota i-esima occupa i caratteri `(i-1)*4 .. (i-1)*4+4` dei dati).
   * 
   * @returns Array con le percentuali IVA programmate (max 6, es. [22, 10, 5, 4]).
   */
  async getVatTable(): Promise<number[]> {
    const res = await this.executeCommand('7012');
    const d = res.data;
    const rates: number[] = [];
    for (let i = 0; i < 6 && (i + 1) * 4 <= d.length; i++) {
      const val = parseInt(d.substring(i * 4, i * 4 + 4), 10);
      if (!isNaN(val)) rates.push(val / 100);
    }
    return rates;
  }

  /**
   * Legge se la giornata fiscale e' aperta (`riempiVarStatoFiscal` / `getDayOpened` del driver Java).
   * 
   * Comando Custom: `1010` (carattere 8 della risposta di Java = `data[7]`: '1' = giornata chiusa).
   * Se la risposta e' troppo corta si restituisce l'ultimo valore noto (false all'inizio).
   */
  async getDayOpened(): Promise<boolean> {
    const res = await this.executeCommand('1010');
    if (res.data.length >= 2) {
      this.dayOpenedCache = res.data.charAt(7) !== '1';
    }
    return this.dayOpenedCache;
  }

  /**
   * Programma la tabella delle aliquote IVA nella stampante fiscale (`setVatTable` del driver Java).
   * 
   * Richiede la giornata fiscale chiusa: se e' aperta lancia `CustomOperationNotAllowedError`
   * ("Error Day Opened!" in Java, JPOS 106). Poi azzera i totalizzatori (`220207`, `220208`, `220210`,
   * 10 s ciascuno) e invia `7013` + 6 aliquote a 4 cifre (percentuale * 100; le mancanti a `0000`) + `000000`
   * con timeout 30 s.
   * 
   * @param rates Array di al piu' 6 aliquote IVA percentuali (es. [22, 10, 5, 4]).
   */
  async setVatTable(rates: number[]): Promise<void> {
    if (!Array.isArray(rates) || rates.length > 6) {
      throw new RangeError('Tabella IVA: al massimo 6 aliquote');
    }
    let payload = '';
    for (let i = 0; i < 6; i++) {
      const r = i < rates.length ? rates[i] : 0;
      if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 99.99) {
        throw new RangeError(`Aliquota IVA fuori intervallo 0..99.99 (ricevuto ${r})`);
      }
      payload += Math.round(r * 100).toString().padStart(4, '0');
    }
    await this.atomic(async () => {
      if (await this.getDayOpened()) {
        throw new CustomOperationNotAllowedError('Giornata fiscale aperta: impossibile programmare la tabella IVA', '7013');
      }
      await this.resetTotalizers();
      await this.executeCommand(`7013${payload}000000`, 30000);
    });
  }

  // --- STATO CONNESSIONE AGENZIA DELLE ENTRATE (RT) ---

  /**
   * Interroga lo stato della connessione telematica e dell'invio corrispettivi verso i server
   * dell'Agenzia delle Entrate (Sogei).
   * 
   * Comando Custom: `1510`
   * 
   * @returns Oggetto con esito comando, descrizione operazione, errori applicativi, errori HTTP ed errori XML.
   */
  async getRTConnectionStatus(): Promise<{
    commandStatus: string;
    operationDesc: string;
    applError: string;
    httpError: string;
    xmlError: string;
    rawStatus: string;
  }> {
    const res = await this.executeCommand('1510', getCmdTimeoutMs('1510'));
    const d = res.data;
    return {
      commandStatus: d.charAt(0) || '',
      operationDesc: d.length > 21 ? d.substring(1, 21).trim() : '',
      applError: d.length >= 24 ? d.substring(21, 24) : '',
      httpError: d.length >= 27 ? d.substring(24, 27) : '',
      xmlError: d.length >= 30 ? d.substring(27, 30) : '',
      rawStatus: d
    };
  }

  // --- GIORNALE DI FONDO ELETTRONICO (DGFE) ---

  /**
   * Legge la percentuale di memoria del Giornale di Fondo Elettronico (DGFE / MicroSD) occupata.
   * Utile per avvisi preventivi prima dell'esaurimento della memoria.
   * 
   * Comando Custom: `8008`
   * 
   * @returns Percentuale occupazione da 0 a 100 (es. 42.5 = 42.5%).
   */
  async getDGFEPercentage(): Promise<number> {
    const res = await this.executeCommand('8008', getCmdTimeoutMs('8008'));
    const num = parseFloat(res.data.replace(/[^0-9.]/g, ''));
    return isNaN(num) ? 0 : num;
  }

  /**
   * Stampa il Giornale di Fondo Elettronico (DGFE) per intervallo di date.
   * 
   * Comando Custom: `8001`
   * 
   * @param startDate Data inizio (DDMMYY o Date)
   * @param endDate Data fine (DDMMYY o Date)
   */
  async printDGFEByDate(startDate: Date | string, endDate: Date | string): Promise<void> {
    const s = formatDateDDMMYY(startDate);
    const e = formatDateDDMMYY(endDate);
    await this.executeCommand(`8001${s}${e}`, getCmdTimeoutMs('8001')); // 1800 s come Java
  }

  /**
   * Stampa il Giornale di Fondo Elettronico (DGFE) per intervallo di numeri di scontrino.
   * 
   * Comando Custom: `8002`
   * 
   * @param startTicket Numero primo scontrino
   * @param endTicket Numero ultimo scontrino
   */
  async printDGFEByTicket(startTicket: number, endTicket: number): Promise<void> {
    const s = formatNumberPad(startTicket, 4);
    const e = formatNumberPad(endTicket, 4);
    await this.executeCommand(`8002${s}${e}`, getCmdTimeoutMs('8002'));
  }

  /**
   * Stampa il Giornale di Fondo Elettronico (DGFE) per intervallo di azzeramenti Z.
   * 
   * Comando Custom: `8003`
   * 
   * @param startZ Numero primo azzeramento Z
   * @param endZ Numero ultimo azzeramento Z
   */
  async printDGFEByClosing(startZ: number, endZ: number): Promise<void> {
    const s = formatNumberPad(startZ, 4);
    const e = formatNumberPad(endZ, 4);
    await this.executeCommand(`8003${s}${e}`, getCmdTimeoutMs('8003'));
  }

  // --- DUPLICATO SCONTRINO ---

  /**
   * Ristampa la copia / duplicato dell'ultimo scontrino fiscale o documento emesso.
   * 
   * Comando Custom: `4007`
   */
  async duplicateReceipt(): Promise<void> {
    await this.executeCommand('4007', 30000); // 30 s come Java
  }

  // --- INTESTAZIONE SCONTRINO (HEADER LINES) ---

  /**
   * Imposta il numero di righe di intestazione stampate all'inizio di ogni documento.
   * 
   * Comando Custom: `6301`
   * 
   * @param count Numero righe (da 1 a 9)
   */
  async setHeaderLineCount(count: number): Promise<void> {
    assertIntRange(count, 1, 9, 'Numero righe di intestazione');
    await this.executeCommand(`6301${count}`);
  }

  /**
   * Programma una riga di intestazione nella memoria non volatile della stampante
   * (`setHeaderLine` del driver Java).
   * 
   * Comando Custom: `6302` + prima cifra del numero riga + pitch (`1` normale, `2` doppia larghezza)
   * + testo dinamico (lunghezza reale, max `MessageLength`; oltre tale limite max `MessageLength42` con pitch `3`).
   * Con testo vuoto invia `6302` + riga + pitch + `00`. Sulle stampanti non RX attende poi 1200 ms
   * (`headerLineDelayMs`). Con l'opzione `deleteEmptyHeaderLines` invia anche `6301` + riga.
   * Le sequenze ESC presenti nel testo vengono interpretate solo per allineamento (il pitch segue `doubleWidth`).
   * 
   * @param lineNumber Numero della riga da programmare (1..NumHeaderLines: 6 di default, 9 dopo `identify()`)
   * @param text Testo della riga di intestazione
   * @param doubleWidth Se true usa la doppia larghezza (pitch `2`)
   */
  async setHeaderLine(lineNumber: number, text: string, doubleWidth: boolean = false): Promise<void> {
    assertIntRange(lineNumber, 1, 9, 'Numero riga di intestazione');
    sanitizeText(parseEscSequenceLine(text ?? '', { mode: 'header' }).text, 'Riga di intestazione'); // validazione prima di qualsiasi comando
    await this.atomic(async () => {
      await this.ensureIdentified();
      if (this.identified) {
        assertIntRange(lineNumber, 1, this.caps.numHeaderLines, 'Numero riga di intestazione');
      }
      await this.assertPrinterReady('setHeaderLine');
      const pitch = doubleWidth ? '2' : '1';
      const lineDigit = String(lineNumber).substring(0, 1);
      const raw = text ?? '';
      if (raw.length === 0) {
        await this.executeCommand(`6302${lineDigit}${pitch}${formatDynamicDescription('', this.caps.messageLength)}`);
      } else {
        // FilterEscSeqPrnHeader (modalita' header): C/P/A, logo `I01<cifra>`; F/R scartati; testo > MessageLength -> pitch 3
        const prefix = `6302${lineDigit}`;
        const p = parseEscSequenceLine(raw, { mode: 'header', pitch });
        for (const op of p.ops) {
          if (op.kind === 'headerLogo') await this.executeCommand(`${prefix}I01${op.digit}`);
        }
        if (p.text.length > 0) {
          if (p.text.length > this.caps.messageLength) {
            await this.executeCommand(`${prefix}3${formatDynamicDescription(p.text, this.caps.messageLength42)}`);
          } else {
            await this.executeCommand(`${prefix}${p.pitch}${formatDynamicDescription(p.text, this.caps.messageLength)}`);
          }
        }
      }

      if (this.deleteEmptyHeaderLines) {
        await this.executeCommand(`6301${lineDigit}`);
      }
      if (!this.caps.rxPrinter && this.headerLineDelayMs > 0) {
        await sleep(this.headerLineDelayMs);
      }
    });
  }

  // --- MODALITÀ ADDESTRAMENTO / TRAINING (RT) ---

  /**
   * Attiva la modalità di addestramento / demo (Training Mode) sul Registratore Telematico.
   * Durante questa modalità gli scontrini emessi recano la dicitura non fiscale di addestramento
   * e non influiscono sui totalizzatori fiscali né sui corrispettivi da trasmettere.
   * 
   * Comando Custom: `64300`
   */
  async beginTraining(): Promise<void> {
    await this.atomic(async () => {
      await this.executeCommand('64300', 10000); // 10 s come Java
      await this.waitPendingOperation(); // come il driver Java
    });
  }

  /**
   * Termina la modalità di addestramento e ripristina la normale modalità fiscale del dispositivo.
   * 
   * Comando Custom: `64301`
   */
  async endTraining(): Promise<void> {
    await this.atomic(async () => {
      await this.executeCommand('64301', 10000); // 10 s come Java
      await this.waitPendingOperation(); // come il driver Java
    });
  }

  // --- TOTALIZZATORI E DATI ---

  /**
   * Restituisce il Gran Totale cumulativo della stampante fiscale espresso in centesimi di euro.
   * 
   * Comando Custom: `1105`
   */
  async getGrandTotal(): Promise<number> {
    const res = await this.executeCommand('1105', getCmdTimeoutMs('1105'));
    const num = parseInt(res.data.replace(/[^0-9]/g, ''), 10);
    return isNaN(num) ? 0 : num;
  }

  /**
   * Legge i dati del documento/scontrino corrente aperto (totale parziale, numero articoli).
   * 
   * Comando Custom: `1003`
   */
  async getTicketData(): Promise<string> {
    const res = await this.executeCommand('1003');
    return res.data;
  }

  /**
   * Legge i dati cumulativi della giornata fiscale in corso.
   * 
   * Comando Custom: `1004`
   */
  async getDailyData(): Promise<string> {
    const res = await this.executeCommand('1004', getCmdTimeoutMs('1004'));
    return res.data;
  }

  // --- EMISSIONE FATTURA SEMPLIFICATA RT ---

  /**
   * Inizia l'emissione di una Fattura Fiscale Semplificata RT.
   * 
   * Wrapper di `beginFiscalReceipt({ invoice })` (FiscalReceiptType 6 del driver Java): `71020`, `71021`,
   * lotteria, `71023` / `71029` (numero con `§`), `7103` solo per conto IVA che inizia per `@`. I dati cliente
   * (`3010C` + `CF/P.IVA:`) sono stampati al primo pagamento. NOTA: rispetto alle versioni precedenti non invia piu'
   * `7103` + CF/P.IVA a 24 caratteri ne' `30101`. Dopo questa chiamata è possibile registrare gli articoli con `printRecItem()`
   * e chiudere con `printRecTotal()` ed `endFiscalReceipt()`.
   * 
   * @param options Parametri fattura semplificata
   */
  async printSimpleInvoice(options: InvoiceOptions): Promise<void> {
    await this.beginFiscalReceipt({
      invoice: { number: options.invoiceNumber ?? 0, taxId: options.taxId, customerLines: options.customerLines },
      lotteryCode: options.lotteryCode,
      headerLines: options.additionalHeader ? [options.additionalHeader] : undefined,
      trailerLines: options.additionalTrailer ? [options.additionalTrailer] : undefined
    });
  }

  // --- LETTURE STRUTTURATE (getData del driver Java; offset = indice Java - 1) ---

  /**
   * `1003` (dati scontrino corrente, risposta di 61 caratteri): `currentTotal` = data[36..46) (10 cifre),
   * `checkTotal` = data[37..46) (9 cifre, quello confrontato da `checkTotal`), `notPaid` = data[46..56).
   * Gli importi sono in centesimi.
   */
  async readTicketTotals(): Promise<{ currentTotal: number; checkTotal: number; notPaid: number; rawStatus: string }> {
    const d = (await this.executeCommand('1003', 10000)).data;
    return {
      currentTotal: toInt(d.substring(36, 46)),
      checkTotal: toInt(d.substring(37, 46)),
      notPaid: toInt(d.substring(46, 56)),
      rawStatus: d
    };
  }

  /**
   * `1004` (dati giornata, 88 caratteri): receiptNumber [0..4), dailyTotal [4..13), simplifiedInvoiceNumber [13..17),
   * simplifiedInvoiceTotal [17..26), midVoid [52..61), refund [70..79), notPaid [79..88).
   */
  async readDailyTotals(): Promise<{
    receiptNumber: number; dailyTotal: number; simplifiedInvoiceNumber: number; simplifiedInvoiceTotal: number;
    midVoid: number; refund: number; notPaid: number; rawStatus: string;
  }> {
    const d = (await this.executeCommand('1004', getCmdTimeoutMs('1004'))).data;
    return {
      receiptNumber: toInt(d.substring(0, 4)),
      dailyTotal: toInt(d.substring(4, 13)),
      simplifiedInvoiceNumber: toInt(d.substring(13, 17)),
      simplifiedInvoiceTotal: toInt(d.substring(17, 26)),
      midVoid: toInt(d.substring(52, 61)),
      refund: toInt(d.substring(70, 79)),
      notPaid: toInt(d.substring(79, 88)),
      rawStatus: d
    };
  }

  /** `1115` (78 caratteri): documenti annullati e resi del giorno (numero [52..56), importo [56..65), reso [65..69), [69..78)). */
  async readDailyVoidedReturned(): Promise<{
    voidedDocuments: number; voidedAmount: number; returnedDocuments: number; returnedAmount: number; rawStatus: string;
  }> {
    const d = (await this.executeCommand('1115', 10000)).data;
    return {
      voidedDocuments: toInt(d.substring(52, 56)),
      voidedAmount: toInt(d.substring(56, 65)),
      returnedDocuments: toInt(d.substring(65, 69)),
      returnedAmount: toInt(d.substring(69, 78)),
      rawStatus: d
    };
  }

  /** `1018` (13 caratteri): note di credito semplificate: numero [0..4), importo [4..13). */
  async readCreditNotes(): Promise<{ number: number; amount: number; rawStatus: string }> {
    const d = (await this.executeCommand('1018', 10000)).data;
    return { number: toInt(d.substring(0, 4)), amount: toInt(d.substring(4, 13)), rawStatus: d };
  }

  /** `1104`: numero dell'ultimo azzeramento Z (`data[0..4)`). */
  async getZReportNumber(): Promise<number> {
    const d = (await this.executeCommand('1104', 10000)).data;
    return toInt(d.substring(0, 4));
  }

  /** `1520`: servizi RT: Z [0], fatture [1], lotteria [2], backup Z [3], download firmware [4]. */
  async getRTServices(): Promise<{ z: string; invoices: string; lottery: string; zBackup: string; firmwareDownload: string; rawStatus: string }> {
    const d = (await this.executeCommand('1520', 10000)).data;
    return { z: d[0] ?? '', invoices: d[1] ?? '', lottery: d[2] ?? '', zBackup: d[3] ?? '', firmwareDownload: d[4] ?? '', rawStatus: d };
  }

  /**
   * Stato di un documento (directIO -96014 del driver Java): `1517` + Z(4) + numero(4), timeout 90 s; carattere `data[8]`:
   * P in attesa (2), A accettato (0), R rifiutato (1), C/E o ERR05/errore con risposta corta sconosciuto (3).
   */
  async getDocumentStatus(zReport: number | string, ticketNumber: number | string): Promise<{ code: 0 | 1 | 2 | 3; status: 'ACCEPTED' | 'REJECTED' | 'PENDING' | 'UNKNOWN' }> {
    const cmd = `1517${formatNumberPad(zReport, 4)}${formatNumberPad(ticketNumber, 4)}`;
    let data = '';
    try {
      const r = await this.executeCommand(cmd, 90000);
      if (r.ignoredErrorCode !== undefined) return { code: 3, status: 'UNKNOWN' };
      data = r.data;
    } catch (e) {
      if (e instanceof CustomFiscalError) return { code: 3, status: 'UNKNOWN' };
      throw e;
    }
    switch (data.charAt(8)) {
      case 'P': return { code: 2, status: 'PENDING' };
      case 'A': return { code: 0, status: 'ACCEPTED' };
      case 'R': return { code: 1, status: 'REJECTED' };
      default: return { code: 3, status: 'UNKNOWN' };
    }
  }

  /** Azzera i totalizzatori (`ResetTotalizers`, directIO 1600): `220207`, `220208`, `220210`, 10 s ciascuno. */
  async resetTotalizers(): Promise<void> {
    await this.atomic(async () => {
      for (const reset of ['220207', '220208', '220210']) await this.executeCommand(reset, 10000);
    });
  }

  // --- LOGHI / BITMAP (9100 / 9101 / 9102) ---

  /**
   * Carica un logo (`LoadBitmap`/`LoadBitmapFromBase64`): `9100` + n(2) + dimensione(6), blocchi interi da 50 byte
   * `910150` + 100 cifre esadecimali maiuscole, resto `9101` + lunghezza(2) + esadecimale, infine `9102`; 10 s ciascuno.
   * @param logoNo 1..25
   */
  async loadBitmap(data: Uint8Array, logoNo: number): Promise<void> {
    assertIntRange(logoNo, 1, 25, 'Numero logo');
    const hex = Array.from(data, (b) => (b & 0xff).toString(16).padStart(2, '0').toUpperCase());
    await this.atomic(async () => {
      await this.executeCommand(`9100${logoNo.toString().padStart(2, '0')}${data.length.toString().padStart(6, '0')}`, 10000);
      const full = Math.floor(data.length / 50) * 50;
      for (let i = 0; i < full; i += 50) await this.executeCommand(`910150${hex.slice(i, i + 50).join('')}`, 10000);
      if (full < data.length) {
        const rest = hex.slice(full);
        await this.executeCommand(`9101${rest.length.toString().padStart(2, '0')}${rest.join('')}`, 10000);
      }
      await this.executeCommand('9102', 10000);
    });
  }

  /** Come `loadBitmap`, con i byte in Base64 (`LoadBitmapFromBase64`, directIO -95000). */
  async loadBitmapFromBase64(base64: string, logoNo: number): Promise<void> {
    await this.loadBitmap(Buffer.from(base64, 'base64'), logoNo);
  }

  /** Cancella un logo (`EraseBitmap`, directIO 1102): `9100` + n(2) + `000000`, 10 s. @param logoNo 1..25 */
  async eraseBitmap(logoNo: number): Promise<void> {
    assertIntRange(logoNo, 1, 25, 'Numero logo');
    await this.executeCommand(`9100${logoNo.toString().padStart(2, '0')}000000`, 10000);
  }

  /** Id a 3 cifre del logo n (1..25) per `3017` (`GetPrinterLogoId`, directIO -95002). */
  private logoId(n: number): string {
    if (n === 25) return '017';
    const k = n - 1;
    return `${k % 4}1${Math.floor(k / 4) + 1}`;
  }

  // --- CASSETTO ---

  /**
   * Stato del cassetto (`7108`): true se la risposta e' `1` (come il codice directIO 1001 del driver Java, che invia `7108`
   * e restituisce `resp.substring(1)`). Nota: la classe `CashDrawerService` Java non interroga la stampante.
   */
  async getDrawerOpened(): Promise<boolean> {
    const r = await this.executeCommand('7108', 10000);
    return r.data.charAt(0) === '1';
  }

  // --- ESCAPE HATCH (DIRECT IO) ---

  /**
   * Port di `directIO` del driver Java.
   *
   * Con `command` NUMERICO (type number) si applicano i codici JavaPOS; con `command` stringa si invia il comando
   * Custom grezzo (timeout come `getCmdTimeout`: 10 s, 15 s per `3023`/`9102`, 180 s per `8006`, 1800 s per
   * `8001/8002/8003/8005`), con gli alias `1520`, `<monitorServices />`, `1510XML`, `1511XML` e la riscrittura
   * `3023xxyy...` -> `30250xx50...` quando l'RT e' in servizio, c'e' uno scontrino aperto e il comando e' lungo > 8.
   * Per compatibilita' le stringhe `'1000'`, `'1301'`, `'1302'` restano alias dei codici numerici.
   *
   * Valore restituito: stringa (come il testo consegnato da Java con `DirectIOEvent`/`obj`): i dati della risposta
   * (senza stato) per i comandi grezzi, `'OK'` per i codici che non producono dati, il valore dei getter per i
   * codici -96000..-96014 e un XML per `1510XML`/`1511XML`.
   *
   * Codici numerici: 1000 cassetto (`70081`, data non vuoto); 1001 stato cassetto `7108`; 1100 carica logo (`object` = Buffer o
   * Base64, `data[0]` = n); 1102 cancella logo; 1301 pulisci display; 1302 testo (`data[0]` riga 1..2, `object` testo); 1600 azzera
   * totalizzatori; -35004 dati reso (`data[0]` numero, `object` = [riga1, riga2]); -95000 logo Base64; -95001 `63021I01`+`data[0]`;
   * -95002 stampa logo 1..25 (`3017`+id); -95003 intestazione sì/no; -95012 `3019`; -96000..-96003 contatori 1115;
   * -96010 matricola; -96011 display presente (`7007`); -96012 RT in servizio; -96013 verifica documento (`7101A`...'9');
   * -96014 stato documento (`1517`). -95010/-95011 impostano reso/annullo RT
   * (`data` = [numero scontrino, numero Z], `object` = [matricola, 'yyyyMMdd'], solo con RT in servizio, nulla e' inviato) consumati dal PROSSIMO
   * `beginFiscalReceipt`. `1510XML`/`1511XML`/`1520` restituiscono gli XML identici al driver Java (CRLF, senza lo spazio iniziale).
   */
  async directIO(command: string | number, data?: number[], object?: any): Promise<string> {
    if (typeof command === 'number') return this.directIONumeric(command, data, object);
    const cmdString = sanitizeText(command, 'Comando');

    // Java: con command == 0 e obj stringa uguale a uno dei codici negativi, la stringa e' rimappata al codice numerico
    // (i codici 1000/1301/... sono rimappati solo nel ramo NCR130A, codice morto: restano comandi grezzi)
    if (['-95000', '-95001', '-95002', '-95003', '-35004', '-95010', '-95011', '-95012'].includes(cmdString)) {
      return this.directIONumeric(parseInt(cmdString, 10), data, cmdString);
    }

    return this.atomic(async () => {
      const isMonitor = cmdString === '<monitorServices />' || cmdString === '<monitorServices/>';
      if (isMonitor || cmdString === '1520' || cmdString === '1510XML' || cmdString === '1511XML') {
        const wire = isMonitor || cmdString === '1520' ? '1520' : cmdString === '1510XML' ? '1510' : '1511';
        // Java calcola il timeout (`getCmdTimeout`) sulla stringa originale: sempre 10 s per questi alias
        let res: ParsedFrame;
        try {
          res = await this.executeCommand(wire, getCmdTimeoutMs(cmdString));
        } catch (e) {
          if (e instanceof CustomFiscalError && (e.code === 3 || e.code === 5)) return '';
          throw e;
        }
        // ERR05/ERR03 nella risposta: Java ritorna senza produrre alcun risultato
        if (res.ignoredErrorCode === 3 || res.ignoredErrorCode === 5) return '';
        if (wire === '1510') return rtConnectionXml(res.data);
        if (wire === '1511') return rtLogicalXml(res.data);
        if (cmdString === '1520' || isMonitor) return monitorServicesXml(res.data);
      }
      // Java (directIO @2459-2630): timeout (`getCmdTimeout`) calcolato sul comando ORIGINALE, poi riscrittura se
      // RTMode == 3 && startsWith("3023") && !NFTicket && length > 8 (nessun requisito di scontrino fiscale aperto).
      const timeout = getCmdTimeoutMs(cmdString);
      let cmd = cmdString;
      if (cmd.startsWith('3023') && !this.nonFiscalOpen && cmd.length > 8) {
        await this.ensureIdentified();
        if (this.caps.rtMode === 3) cmd = `30250${cmd.substring(4, 6)}50${cmd.substring(8)}`;
      }
      const res = await this.executeCommand(cmd, timeout);
      return res.data;
    });
  }

  private async directIONumeric(code: number, data: number[] | undefined, object: any): Promise<string> {
    const d0 = data && data.length > 0 ? data[0] : undefined;
    const need = (): number => {
      if (d0 === undefined) throw new RangeError(`directIO ${code}: parametro data[0] mancante`);
      return d0;
    };
    switch (code) {
      case 1000:
        if (!data || data.length === 0) throw new RangeError('directIO 1000: data non vuoto richiesto');
        await this.executeCommand('70081', 10000);
        return 'OK';
      case 1001:
        return this.atomic(async () => (await this.executeCommand('7108', 10000)).data);
      case 1100: {
        const bytes = typeof object === 'string' ? Buffer.from(object, 'base64') : (object as Uint8Array);
        await this.loadBitmap(bytes, need());
        return 'OK';
      }
      case 1102:
        await this.eraseBitmap(need());
        return 'OK';
      case 1301:
        // Java: `7007` + 40 spazi con sendFrameCommand, senza toccare buffer/cursore del display
        if (!data || data.length === 0) throw new RangeError('directIO 1301: data non vuoto richiesto');
        await this.atomic(() => this.executeCommand(`7007${' '.repeat(40)}`, 8000));
        return 'OK';
      case 1302: {
        const row = need();
        if (row !== 1 && row !== 2) throw new RangeError('Numero riga display non valido');
        const t = sanitizeText(String(object ?? ''), 'Testo display');
        // come Java: invio diretto, senza modificare buffer/cursore di displayText
        const frame = row === 1 ? t.padEnd(40, ' ').substring(0, 40) : ' '.repeat(20) + t.padEnd(20, ' ').substring(0, 20);
        await this.atomic(() => this.executeCommand(`7007${frame}`, 8000));
        return 'OK';
      }
      case 1600:
        await this.resetTotalizers();
        return 'OK';
      case -35004:
        this.setRefundInfo({ number: need(), line1: object?.[0], line2: object?.[1] });
        return 'OK';
      case -95000:
        if (!data || data.length < 2 || data[1] !== 1) throw new RangeError('directIO -95000: data = [logo, 1] richiesto');
        await this.loadBitmapFromBase64(String(object), data[0]);
        return 'OK';
      case -95001:
        await this.executeCommand(`63021I01${need()}`, 10000);
        return 'OK';
      case -95002: {
        const n = need();
        assertIntRange(n, 1, 25, 'Numero logo');
        await this.executeCommand(`3017${this.logoId(n)}`, 10000);
        return 'OK';
      }
      case -95003:
        this.printHeaderFlag = need() >= 1;
        return 'OK';
      case -95010:
      case -95011: {
        // RT: imposta il documento di reso (-95010) / annullo (-95011) per il PROSSIMO beginFiscalReceipt.
        // Solo con RTMode == 3 (altrimenti nessun effetto); non invia nulla alla stampante.
        await this.ensureIdentified();
        if (this.caps.rtMode !== 3) return 'OK';
        if (!data || data.length < 2) throw new RangeError('directIO: invalid data length value');
        const objs: unknown[] = Array.isArray(object) ? object : [];
        if (objs.length < 2) throw new RangeError('directIO: invalid object size');
        const issueDate = String(objs[1]);
        if (!/^\d{8}$/.test(issueDate)) throw new RangeError('directIO: invalid issueDate Format');
        const [ticket, z] = data;
        this.pendingRtDoc = {
          type: code === -95010 ? 1 : 2,
          zNum: String(z).padStart(4, '0'),
          ticketNum: String(ticket).padStart(4, '0'),
          // chars [6,7,4,5,2,3] di yyyyMMdd = DDMMYY
          ticketDate: `${issueDate[6]}${issueDate[7]}${issueDate[4]}${issueDate[5]}${issueDate[2]}${issueDate[3]}`,
          deviceId: String(objs[0]),
          noPreview: false
        };
        return 'OK';
      }
      case -95012: {
        // Java @2257-2398: data vuoto -> 106 "invalid data length value"; il codice (obj String) e' memorizzato in
        // m_csPseudoLotteryCode se non vuoto, poi `3019` + lunghezza (2 cifre) + codice con sendFrameCommand (10 s)
        if (!data || data.length < 1) throw new RangeError('directIO -95012: invalid data length value');
        if (typeof object !== 'string') throw new RangeError('directIO -95012: oggetto stringa richiesto');
        const lot = sanitizeText(object, 'Codice lotteria');
        if (lot.length > 0) this.pseudoLottery = lot;
        await this.executeCommand(`3019${lot.length < 10 ? '0' + lot.length : '' + lot.length}${lot}`, 10000);
        return 'OK';
      }
      case -96000: return String((await this.readDailyVoidedReturned()).voidedDocuments).padStart(4, '0');
      case -96001: return String((await this.readDailyVoidedReturned()).voidedAmount).padStart(9, '0');
      case -96002: return String((await this.readDailyVoidedReturned()).returnedDocuments).padStart(4, '0');
      case -96003: return String((await this.readDailyVoidedReturned()).returnedAmount).padStart(9, '0');
      case -96010: {
        // Java getData(PRINTER_ID, -96010): sempre la variante `1511` data[1..12) (come con RTMode == 3)
        const rt = await this.getRTStatus();
        return rt.matrRt;
      }
      case -96011: {
        try {
          await this.executeCommand('7007', 90000);
        } catch (e) {
          if (e instanceof CustomFiscalError && e.code === 214) return '0';
          throw e;
        }
        return '1';
      }
      case -96012:
        await this.ensureIdentified();
        return this.caps.rtMode === 3 ? '1' : '0';
      case -96013: {
        const [num, z, matf, date] = String(object ?? '').split('|');
        if (!matf || matf.length < 10 || !date || date.length !== 8) throw new RangeError('directIO -96013: formato "NNNN|ZZZZ|MATF|YYYYMMDD" richiesto');
        const dd = `${date.substring(6, 8)}${date.substring(4, 6)}${date.substring(2, 4)}`;
        const r = await this.executeCommand(`7101A${formatNumberPad(z, 4)}${formatNumberPad(num, 4)}${dd}9${formatDynamicDescription(matf, 11)}`, 90000);
        return r.data.charAt(0) === '1' ? '0' : '1';
      }
      case -96014: {
        const [num, z] = String(object ?? '').split('|');
        return String((await this.getDocumentStatus(z, num)).code);
      }
      default:
        throw new RangeError(`directIO: codice ${code} non supportato`);
    }
  }
}
