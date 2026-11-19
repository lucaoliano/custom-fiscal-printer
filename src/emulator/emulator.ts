/**
 * Emulatore di un registratore telematico Custom.
 *
 * Riproduce la LETTURA del protocollo fatta da questa libreria (comandi, layout dei payload, offset delle risposte),
 * non il comportamento di una stampante reale: dove la libreria non basta a stabilire cosa risponderebbe
 * il dispositivo, la scelta è segnalata nel commento come «ipotesi». Serve a provare client e applicazioni
 * senza hardware, non a certificarne il comportamento sul campo.
 *
 * Il nucleo è puro: `handle(comando)` restituisce la risposta, senza socket né timer. I trasporti
 * (`EmulatorTransport`, `startEmulatorServer`) lo collegano al client.
 */

/** Come la risposta arriva al client. */
export type Delivery =
  | 'normal'
  /** La connessione cade senza risposta. */
  | 'close'
  /** Metà del frame di risposta, poi la connessione cade. */
  | 'truncate'
  /** Nessuna risposta, connessione aperta (il client va in timeout). */
  | 'silence'
  | { delayMs: number };

export interface EmulatorReply {
  /** Dati della risposta (dopo i 4 byte di stato). */
  data?: string;
  /** Codice ERRnn: la risposta è un errore. */
  error?: number;
  delivery?: Delivery;
}

/**
 * Guasti iniettabili. Quelli che distinguono «eseguito» da «non eseguito» sono il punto: dopo `lose-command` e
 * `lose-reply` il client vede lo stesso errore (`sent: true`, esito ignoto) ma lo stato della stampante è diverso.
 */
export type Fault =
  /** Il comando NON viene eseguito e la stampante risponde ERRnn. */
  | { kind: 'error'; code: number; extendedCode?: number }
  /** Il comando NON viene eseguito e la connessione cade. */
  | { kind: 'lose-command' }
  /** Il comando viene eseguito, poi la connessione cade prima della risposta. */
  | { kind: 'lose-reply' }
  /** Il comando viene eseguito, la risposta arriva a metà e la connessione cade. */
  | { kind: 'truncate-reply' }
  /** Il comando viene eseguito ma non c'è risposta (timeout del client). */
  | { kind: 'silence' }
  /** Il comando viene eseguito e la risposta arriva in ritardo. */
  | { kind: 'delay'; ms: number };

export type CommandMatcher = string | RegExp | ((command: string) => boolean);

export interface EmulatorOptions {
  /**
   * `rx` (default): si identifica come stampante di architettura 3 (descrizioni a 44 colonne, chiusura `30112`).
   * `legacy`: si identifica come architettura 1 (22 colonne, chiusura `3011`).
   * Ipotesi: quale dei due sia la Q3X-F non è verificato.
   */
  model?: 'rx' | 'legacy';
  /** Matricola dell'RT (11 caratteri). */
  serial?: string;
  /** Aliquote IVA programmate, percentuali: l'indice 1..6 della vendita punta qui. Default 22, 10, 5, 4, 0, 0. */
  vatRates?: number[];
  /** Indici delle forme di pagamento programmate (3007). Default 1..10. */
  paymentForms?: number[];
  /** RT in servizio (default true). Reso e annullo la richiedono. */
  rtInService?: boolean;
  clock?: () => Date;
  /** Numero dell'ultimo azzeramento Z già fatto (default 0). */
  lastZ?: number;
}

export interface EmulatedLine {
  description: string;
  quantityThousandths: number;
  unitPriceCents: number;
  lineTotalCents: number;
  /** Aliquota in percentuale, null se la riga è su reparto. */
  vatRatePercent: number | null;
  department: number;
}

export interface EmulatedPayment {
  /** Indice della forma di pagamento (3007); null = contanti (3004). */
  form: number | null;
  description: string;
  amountCents: number;
}

export interface DocumentReference {
  zReport: number;
  number: number;
  /** DDMMYY */
  date: string;
}

export interface EmittedDocument {
  kind: 'sale' | 'refund' | 'void';
  /** Numero dell'azzeramento Z a cui il documento appartiene (ultimo Z + 1 al momento dell'emissione). */
  zReport: number;
  /** Numero progressivo del documento nella giornata. */
  number: number;
  /** DDMMYY */
  date: string;
  totalCents: number;
  lines: EmulatedLine[];
  payments: EmulatedPayment[];
  changeCents: number;
  reference?: DocumentReference;
  /** Solo per le vendite: annullata da un documento di annullo. */
  voided: boolean;
}

export interface EmulatorSnapshot {
  receiptNumber: number;
  lastZ: number;
  dailyTotalCents: number;
  refundTotalCents: number;
  midVoidCents: number;
  dayOpened: boolean;
  /** Fase del documento fiscale in corso, o null. `emitted` = emesso, manca solo il taglio. */
  phase: 'sale' | 'payment' | 'paid' | 'emitted' | null;
  documentKind: 'sale' | 'refund' | null;
  nonFiscalOpen: boolean;
  totalCents: number;
  paidCents: number;
  xReports: number;
}

/** Codici ERR usati dall'emulatore: scelti tra quelli che la libreria NON ignora con la policy `java`. */
export const EMULATOR_ERROR = {
  /** Comando non consentito nello stato corrente. */
  WRONG_STATE: 4,
  /** Parametro o comando non valido (anche comando sconosciuto). */
  ILLEGAL: 9,
  OVERFLOW: 10,
  BAD_AMOUNT: 11,
  PAPER_EMPTY: 16,
  NEGATIVE_TOTAL: 23,
  COVER_OPEN: 64
} as const;

/** Rifiuto di un comando: diventa una risposta ERRnn. */
class Refusal extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

interface OpenDocument {
  kind: 'sale' | 'refund';
  phase: 'sale' | 'payment' | 'paid' | 'emitted';
  lines: EmulatedLine[];
  totalCents: number;
  payments: EmulatedPayment[];
  paidCents: number;
  reference?: DocumentReference;
}

interface Route {
  prefix: string;
  prints: boolean;
  run: (command: string) => string | undefined;
}

interface PendingFault {
  matcher: CommandMatcher;
  fault: Fault;
  remaining: number;
}

const MAX_AMOUNT_CENTS = 999_999_999;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function matches(matcher: CommandMatcher, command: string): boolean {
  if (typeof matcher === 'string') return command.startsWith(matcher);
  if (matcher instanceof RegExp) return matcher.test(command);
  return matcher(command);
}

/** Legge `width` cifre a partire da `from`; qualunque altro carattere è un parametro non valido. */
function digits(s: string, from: number, width: number, what: string): number {
  const part = s.substring(from, from + width);
  if (part.length !== width || !/^\d+$/.test(part)) {
    throw new Refusal(EMULATOR_ERROR.ILLEGAL, `${what}: attese ${width} cifre`);
  }
  return parseInt(part, 10);
}

function ddmmyy(date: Date): string {
  return pad(date.getDate(), 2) + pad(date.getMonth() + 1, 2) + pad(date.getFullYear() % 100, 2);
}

export class EmulatedPrinter {
  /** Ogni comando ricevuto, nell'ordine. */
  readonly commandLog: string[] = [];
  /** Comandi che l'emulatore non conosce: dopo un flusso corretto la lista deve essere vuota. */
  readonly unknownCommands: string[] = [];
  readonly documents: EmittedDocument[] = [];

  private readonly model: 'rx' | 'legacy';
  private readonly serial: string;
  private readonly paymentForms: number[];
  private readonly clock: () => Date;
  private vatRates: number[];
  private rtInService: boolean;
  private lastZ: number;
  private receiptNumber = 0;
  private dailyTotalCents = 0;
  private refundTotalCents = 0;
  private midVoidCents = 0;
  private voidedCount = 0;
  private voidedCents = 0;
  private refundCount = 0;
  private dayOpened = false;
  private training = false;
  private nonFiscalOpen = false;
  private doc: OpenDocument | null = null;
  private xReports = 0;
  private cover = false;
  private paperEmpty = false;
  private paperNearEnd = false;
  private extendedCode = 0;
  private clockOffsetMs = 0;
  private faults: PendingFault[] = [];
  private readonly routes: Route[];

  constructor(options: EmulatorOptions = {}) {
    this.model = options.model ?? 'rx';
    this.serial = (options.serial ?? 'EMULATORE01').padEnd(11, ' ').substring(0, 11);
    this.vatRates = [...(options.vatRates ?? [22, 10, 5, 4, 0, 0])];
    this.paymentForms = options.paymentForms ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    this.rtInService = options.rtInService ?? true;
    this.clock = options.clock ?? (() => new Date());
    this.lastZ = options.lastZ ?? 0;
    this.routes = this.buildRoutes();
  }

  // --- Controllo da parte di chi prova ---

  setPaper(state: { empty?: boolean; nearEnd?: boolean }): void {
    if (state.empty !== undefined) this.paperEmpty = state.empty;
    if (state.nearEnd !== undefined) this.paperNearEnd = state.nearEnd;
  }

  setCoverOpen(open: boolean): void {
    this.cover = open;
  }

  setRtInService(inService: boolean): void {
    this.rtInService = inService;
  }

  /**
   * Programma un guasto per i prossimi `times` comandi che corrispondono (default 1).
   * `matcher` stringa = prefisso del comando.
   */
  inject(matcher: CommandMatcher, fault: Fault, times = 1): void {
    this.faults.push({ matcher, fault, remaining: times });
  }

  clearFaults(): void {
    this.faults = [];
  }

  snapshot(): EmulatorSnapshot {
    const d = this.doc;
    return {
      receiptNumber: this.receiptNumber,
      lastZ: this.lastZ,
      dailyTotalCents: this.dailyTotalCents,
      refundTotalCents: this.refundTotalCents,
      midVoidCents: this.midVoidCents,
      dayOpened: this.dayOpened,
      phase: d?.phase ?? null,
      documentKind: d?.kind ?? null,
      nonFiscalOpen: this.nonFiscalOpen,
      totalCents: d?.totalCents ?? 0,
      paidCents: d?.paidCents ?? 0,
      xReports: this.xReports
    };
  }

  // --- Elaborazione dei comandi ---

  handle(command: string): EmulatorReply {
    this.commandLog.push(command);
    const fault = this.takeFault(command);
    if (fault?.kind === 'error') {
      this.extendedCode = fault.extendedCode ?? 0;
      return { error: fault.code };
    }
    if (fault?.kind === 'lose-command') return { delivery: 'close' };

    const reply = this.execute(command);
    switch (fault?.kind) {
      case 'lose-reply':
        return { ...reply, delivery: 'close' };
      case 'truncate-reply':
        return { ...reply, delivery: 'truncate' };
      case 'silence':
        return { ...reply, delivery: 'silence' };
      case 'delay':
        return { ...reply, delivery: { delayMs: fault.ms } };
      default:
        return reply;
    }
  }

  private takeFault(command: string): Fault | undefined {
    const hit = this.faults.find((f) => f.remaining > 0 && matches(f.matcher, command));
    if (!hit) return undefined;
    hit.remaining--;
    this.faults = this.faults.filter((f) => f.remaining > 0);
    return hit.fault;
  }

  private execute(command: string): EmulatorReply {
    // longest-prefix: `30112` prima di `3011`, `33011` prima di `3301`...
    const route = this.routes.find((r) => command.startsWith(r.prefix));
    try {
      if (!route) {
        this.unknownCommands.push(command);
        throw new Refusal(EMULATOR_ERROR.ILLEGAL, `Comando sconosciuto: ${command}`);
      }
      if (route.prints) this.requirePrinter();
      return { data: route.run(command) ?? '' };
    } catch (e) {
      if (e instanceof Refusal) return { error: e.code };
      throw e;
    }
  }

  private requirePrinter(): void {
    if (this.cover) throw new Refusal(EMULATOR_ERROR.COVER_OPEN, 'Coperchio aperto');
    if (this.paperEmpty) throw new Refusal(EMULATOR_ERROR.PAPER_EMPTY, 'Carta esaurita');
  }

  private now(): Date {
    return new Date(this.clock().getTime() + this.clockOffsetMs);
  }

  private requireDoc(): OpenDocument {
    if (!this.doc) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Nessun documento fiscale aperto');
    return this.doc;
  }

  /** Il documento si apre da solo alla prima riga se `71021` non l'ha già fatto. */
  private openSale(): OpenDocument {
    if (this.nonFiscalOpen) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Documento non fiscale aperto');
    this.doc ??= { kind: 'sale', phase: 'sale', lines: [], totalCents: 0, payments: [], paidCents: 0 };
    return this.doc;
  }

  private buildRoutes(): Route[] {
    const ack = (prefix: string, prints = false): Route => ({ prefix, prints, run: () => undefined });
    const routes: Route[] = [
      // handshake e anagrafica
      ack('30160'),
      ack('30161'),
      { prefix: '1001', prints: false, run: () => this.dateData() },
      { prefix: '2001', prints: false, run: (c) => this.setDate(c) },
      { prefix: '1008', prints: false, run: () => this.serial },
      {
        prefix: '1013',
        prints: false,
        run: () => `CUSTOM EMULATORE ${this.model === 'rx' ? 'RX' : 'LEGACY'} 1.0`
      },
      // codice modello letto da `readPrinterModel`: `1?00` = modello 0x1F (architettura 3, RX); `0000` = nessun modello noto (architettura 1)
      { prefix: '1014', prints: false, run: () => (this.model === 'rx' ? '1?00' : '0000') },
      { prefix: '1015', prints: false, run: () => pad(this.extendedCode, 3) },
      { prefix: '1109', prints: false, run: () => this.hardwareStatus() },
      { prefix: '1010', prints: false, run: () => this.fiscalStatus() },
      { prefix: '1011', prints: false, run: () => `${this.doc ? '1' : '0'}${this.nonFiscalOpen ? '1' : '0'}` },
      { prefix: '1012', prints: false, run: () => this.phaseDigit() },
      { prefix: '1511', prints: false, run: () => this.rtStatus() },
      ack('1513'),
      { prefix: '7012', prints: false, run: () => this.vatRates.map((r) => pad(Math.round(r * 100), 4)).join('') },
      { prefix: '7013', prints: false, run: (c) => this.setVatTable(c) },
      ack('220207'),
      ack('220208'),
      ack('220210'),
      // totali
      { prefix: '1003', prints: false, run: () => this.ticketTotals() },
      { prefix: '1004', prints: false, run: () => this.dailyTotals() },
      { prefix: '1115', prints: false, run: () => this.voidedReturned() },
      { prefix: '1104', prints: false, run: () => pad(this.lastZ, 4) },
      // documento fiscale
      { prefix: '71020', prints: false, run: () => this.resetTransaction() },
      { prefix: '71021', prints: false, run: () => void this.openSale() },
      ack('3019'),
      ack('3010'),
      ack('3002'),
      ack('3008'),
      ack('3012'),
      ack('3024'),
      ack('3017'),
      ack('3023'),
      ack('3025'),
      ack('3026'),
      ack('30021'),
      ack('30101'),
      { prefix: '33011', prints: true, run: (c) => this.sellItem(c) },
      { prefix: '33012', prints: true, run: (c) => this.adjust(c, +1) },
      { prefix: '33013', prints: true, run: (c) => this.adjust(c, -1) },
      { prefix: '33014', prints: true, run: (c) => this.adjust(c, -1) },
      { prefix: '3003', prints: true, run: () => void this.requireSaleDoc() },
      { prefix: '3004', prints: true, run: (c) => this.pay(c, false) },
      { prefix: '3007', prints: true, run: (c) => this.pay(c, true) },
      { prefix: '30112', prints: true, run: () => this.closeDocument() },
      { prefix: '3011', prints: true, run: () => this.closeDocument() },
      { prefix: '3013', prints: true, run: () => this.cut() },
      { prefix: '30018', prints: true, run: () => this.abort() },
      { prefix: '33018', prints: true, run: () => this.abort() },
      { prefix: '310180100000000000', prints: true, run: () => this.finish() },
      { prefix: '7101R', prints: true, run: (c) => this.rtDocument(c, 'refund') },
      { prefix: '7101A', prints: true, run: (c) => this.rtDocument(c, 'void') },
      // documento non fiscale
      { prefix: '40011', prints: true, run: () => this.beginNonFiscal() },
      ack('4002'),
      { prefix: '4003', prints: true, run: () => this.requireNonFiscal() },
      { prefix: '4004', prints: true, run: () => this.endNonFiscal() },
      ack('64301'),
      // chiusure e report
      { prefix: '2002', prints: true, run: () => this.zReport() },
      { prefix: '2003', prints: true, run: () => this.xReport() },
      ack('5001', true),
      ack('5002', true)
    ];
    return routes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // --- Stato letto dal client ---

  private dateData(): string {
    const d = this.now();
    return pad(d.getDate(), 2) + pad(d.getMonth() + 1, 2) + pad(d.getFullYear() % 100, 2) + pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
  }

  /** `2001` + ggMM + aaHHmm. Risponde '0' (data accettata, nessuna conferma richiesta). */
  private setDate(command: string): string {
    const p = command.substring(4);
    const day = digits(p, 0, 2, 'giorno');
    const month = digits(p, 2, 2, 'mese');
    const year = 2000 + digits(p, 4, 2, 'anno');
    const hour = digits(p, 6, 2, 'ora');
    const minute = digits(p, 8, 2, 'minuti');
    const target = new Date(year, month - 1, day, hour, minute);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || isNaN(target.getTime())) {
      throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Data non valida');
    }
    this.clockOffsetMs = target.getTime() - this.clock().getTime();
    return '0';
  }

  /** cover, paper empty, paper near end, journal empty, journal near end. */
  private hardwareStatus(): string {
    return `${this.cover ? 1 : 0}${this.paperEmpty ? 1 : 0}${this.paperNearEnd ? 1 : 0}00`;
  }

  /** d[7] = '1' giornata chiusa, d[8] = documento non fiscale aperto, d[10] = addestramento. */
  private fiscalStatus(): string {
    const d = ['0', '0', '0', '0', '0', '0', '0', this.dayOpened ? '0' : '1', this.nonFiscalOpen ? '1' : '0', '0', this.training ? '1' : '0', '0'];
    return d.join('');
  }

  /** Fase del documento: 0 libero, 1 vendita, 2 pagamento parziale, 3 pagato (resto), 5 emesso (manca il taglio). */
  private phaseDigit(): string {
    switch (this.doc?.phase) {
      case 'sale':
        return '1';
      case 'payment':
        return '2';
      case 'paid':
        return '3';
      case 'emitted':
        return '5';
      default:
        return '0';
    }
  }

  /** Layout di `getRTStatus`: [0] RT, [1..12) matricola, [12..22) matricola 83, [25] in servizio, [26..32) data, [33] addestramento. */
  private rtStatus(): string {
    const d = Array.from({ length: 37 }, () => '0');
    d[0] = '1';
    this.serial.split('').forEach((c, i) => (d[1 + i] = c));
    d[23] = '1';
    d[24] = '1';
    d[25] = this.rtInService ? '1' : '0';
    ddmmyy(this.now())
      .split('')
      .forEach((c, i) => (d[26 + i] = c));
    d[33] = this.training ? '1' : '0';
    return d.join('');
  }

  private ticketTotals(): string {
    const d = Array.from({ length: 61 }, () => '0');
    const total = this.doc?.totalCents ?? 0;
    const notPaid = Math.max(total - (this.doc?.paidCents ?? 0), 0);
    pad(total, 10)
      .split('')
      .forEach((c, i) => (d[36 + i] = c));
    pad(notPaid, 10)
      .split('')
      .forEach((c, i) => (d[46 + i] = c));
    return d.join('');
  }

  private dailyTotals(): string {
    const d = Array.from({ length: 88 }, () => '0');
    const put = (at: number, value: number, width: number) => pad(value, width).split('').forEach((c, i) => (d[at + i] = c));
    put(0, this.receiptNumber, 4);
    put(4, this.dailyTotalCents, 9);
    put(52, this.midVoidCents, 9);
    put(70, this.refundTotalCents, 9);
    return d.join('');
  }

  private voidedReturned(): string {
    const d = Array.from({ length: 78 }, () => '0');
    const put = (at: number, value: number, width: number) => pad(value, width).split('').forEach((c, i) => (d[at + i] = c));
    put(52, this.voidedCount, 4);
    put(56, this.voidedCents, 9);
    put(65, this.refundCount, 4);
    put(69, this.refundTotalCents, 9);
    return d.join('');
  }

  /** `7013` + 6 aliquote da 4 cifre + `000000`; solo a giornata chiusa. */
  private setVatTable(command: string): string | undefined {
    if (this.dayOpened) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Giornata aperta');
    const p = command.substring(4);
    this.vatRates = Array.from({ length: 6 }, (_, i) => digits(p, i * 4, 4, 'aliquota') / 100);
    return undefined;
  }

  // --- Documento fiscale ---

  private resetTransaction(): undefined {
    // un documento già emesso resta emesso: reset annulla solo ciò che non lo è
    if (this.doc && this.doc.phase !== 'emitted') this.doc = null;
    return undefined;
  }

  private requireSaleDoc(): OpenDocument {
    const doc = this.requireDoc();
    if (doc.phase !== 'sale') throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Righe non consentite dopo il pagamento');
    return doc;
  }

  /** `33011` + qty(9, millesimi) + reparto(3) + descrizione(2+testo) + prezzo unitario(9) + IVA(1). */
  private parseItem(command: string): { description: string; qty: number; dept: number; price: number; vatIndex: number } {
    const s = command.substring(5);
    const qty = digits(s, 0, 9, 'quantità');
    const dept = digits(s, 9, 3, 'reparto');
    const length = digits(s, 12, 2, 'lunghezza descrizione');
    const description = s.substring(14, 14 + length);
    const rest = s.substring(14 + length);
    if (description.length !== length || rest.length !== 10) {
      throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Riga articolo malformata');
    }
    return { description, qty, dept, price: digits(rest, 0, 9, 'prezzo'), vatIndex: digits(rest, 9, 1, 'aliquota') };
  }

  private vatPercent(dept: number, vatIndex: number): number | null {
    if (dept > 0) return null;
    // ipotesi: un indice oltre la tabella (1..6) o a 0 non è accettato
    if (vatIndex < 1 || vatIndex > this.vatRates.length) {
      throw new Refusal(EMULATOR_ERROR.ILLEGAL, `Aliquota IVA ${vatIndex} non programmata`);
    }
    return this.vatRates[vatIndex - 1];
  }

  private addToTotal(doc: OpenDocument, deltaCents: number): void {
    const next = doc.totalCents + deltaCents;
    if (next < 0) throw new Refusal(EMULATOR_ERROR.NEGATIVE_TOTAL, 'Totale negativo');
    if (next > MAX_AMOUNT_CENTS) throw new Refusal(EMULATOR_ERROR.OVERFLOW, 'Totale oltre il limite');
    doc.totalCents = next;
  }

  private sellItem(command: string): undefined {
    const item = this.parseItem(command);
    if (item.qty < 1) throw new Refusal(EMULATOR_ERROR.BAD_AMOUNT, 'Quantità nulla');
    const vatRatePercent = this.vatPercent(item.dept, item.vatIndex);
    const doc = this.doc ?? this.openSale();
    if (doc.phase !== 'sale') throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Righe non consentite dopo il pagamento');
    const lineTotalCents = Math.round((item.qty * item.price) / 1000);
    this.addToTotal(doc, lineTotalCents);
    doc.lines.push({
      description: item.description.trimEnd(),
      quantityThousandths: item.qty,
      unitPriceCents: item.price,
      lineTotalCents,
      vatRatePercent,
      department: item.dept
    });
    return undefined;
  }

  /** Sconto, maggiorazione e storno articolo: stesso formato della vendita, importo = totale della riga. */
  private adjust(command: string, sign: 1 | -1): undefined {
    const item = this.parseItem(command);
    this.vatPercent(item.dept, item.vatIndex);
    const doc = this.requireSaleDoc();
    if (item.price < 1) throw new Refusal(EMULATOR_ERROR.BAD_AMOUNT, 'Importo nullo');
    this.addToTotal(doc, sign * item.price);
    return undefined;
  }

  /** `3004` + descrizione(2+testo) + importo(9); `3007` + forma(2) + `00` + descrizione + importo. */
  private pay(command: string, withForm: boolean): undefined {
    const s = command.substring(4);
    let form: number | null = null;
    let at = 0;
    if (withForm) {
      form = digits(s, 0, 2, 'forma di pagamento');
      if (s.substring(2, 4) !== '00') throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Pagamento malformato');
      if (!this.paymentForms.includes(form)) {
        throw new Refusal(EMULATOR_ERROR.ILLEGAL, `Forma di pagamento ${form} non programmata`);
      }
      at = 4;
    }
    const length = digits(s, at, 2, 'lunghezza descrizione');
    const description = s.substring(at + 2, at + 2 + length);
    const tail = s.substring(at + 2 + length);
    if (description.length !== length || tail.length !== 9) {
      throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Pagamento malformato');
    }
    const amountCents = digits(tail, 0, 9, 'importo');

    const doc = this.requireDoc();
    if (doc.kind !== 'sale' || (doc.phase !== 'sale' && doc.phase !== 'payment')) {
      throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Pagamento non consentito');
    }
    if (doc.totalCents < 1) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Nulla da pagare');
    if (amountCents < 1) throw new Refusal(EMULATOR_ERROR.BAD_AMOUNT, 'Importo nullo');
    // ipotesi: solo il contante dà resto
    if (form !== null && amountCents > doc.totalCents - doc.paidCents) {
      throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Pagamento non contante oltre il dovuto');
    }
    doc.payments.push({ form, description: description.trimEnd(), amountCents });
    doc.paidCents += amountCents;
    doc.phase = doc.paidCents >= doc.totalCents ? 'paid' : 'payment';
    return undefined;
  }

  /** `3011` / `30112`: emette il documento. Manca ancora il taglio (`3013`). */
  private closeDocument(): undefined {
    const doc = this.requireDoc();
    if (doc.phase === 'emitted') throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Documento già emesso');
    if (doc.kind === 'sale' && doc.phase !== 'paid') {
      throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Pagamento non completato');
    }
    if (doc.kind === 'refund') {
      if (doc.totalCents < 1) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Reso senza righe');
      const original = this.find(doc.reference!);
      const alreadyRefunded = this.documents
        .filter((d) => d.kind === 'refund' && d.reference && this.sameRef(d.reference, doc.reference!))
        .reduce((sum, d) => sum + d.totalCents, 0);
      if (!original || alreadyRefunded + doc.totalCents > original.totalCents) {
        throw new Refusal(EMULATOR_ERROR.BAD_AMOUNT, 'Reso oltre il documento originale');
      }
    }
    this.emit(doc);
    return undefined;
  }

  private emit(doc: OpenDocument): void {
    const now = this.now();
    this.receiptNumber++;
    const emitted: EmittedDocument = {
      kind: doc.kind,
      zReport: this.lastZ + 1,
      number: this.receiptNumber,
      date: ddmmyy(now),
      totalCents: doc.totalCents,
      lines: doc.lines,
      payments: doc.payments,
      changeCents: Math.max(doc.paidCents - doc.totalCents, 0),
      reference: doc.reference,
      voided: false
    };
    this.documents.push(emitted);
    if (doc.kind === 'sale') this.dailyTotalCents += doc.totalCents;
    else {
      this.refundTotalCents += doc.totalCents;
      this.refundCount++;
    }
    this.dayOpened = true;
    doc.phase = 'emitted';
  }

  /** Taglio: completa un documento emesso. Con un documento ancora da pagare non è consentito. */
  private cut(): undefined {
    if (this.doc) {
      if (this.doc.phase !== 'emitted') throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Documento non ancora emesso');
      this.doc = null;
    }
    return undefined;
  }

  /** Annullo dello scontrino in corso (non emesso): niente numero di documento. */
  private abort(): undefined {
    if (this.doc && this.doc.phase !== 'emitted') this.midVoidCents += this.doc.totalCents;
    this.doc = null;
    return undefined;
  }

  /**
   * `310180100000000000` (chiusura di recupero). Ipotesi: su un documento già pagato lo emette, perché
   * un pagamento completo non si può «annullare»; su uno non pagato lo abbandona come `abort`.
   */
  private finish(): undefined {
    const doc = this.doc;
    if (!doc) return undefined;
    if (doc.phase === 'paid') this.emit(doc);
    return this.abort();
  }

  private find(ref: DocumentReference): EmittedDocument | undefined {
    return this.documents.find((d) => d.zReport === ref.zReport && d.number === ref.number && d.date === ref.date);
  }

  private sameRef(a: DocumentReference, b: DocumentReference): boolean {
    return a.zReport === b.zReport && a.number === b.number && a.date === b.date;
  }

  /**
   * `7101R` / `7101A` + Z(4) + numero(4) + data(6) + modalità(1) + matricola + codice lotteria.
   * Reso: modalità 0 = verifica (ASK), 1 o 8 = esecuzione (PERFORM); il documento resta aperto.
   * Annullo: 0 o 8 = verifica, 1 = esecuzione; l'annullo si completa da solo (risposta '1').
   * Risposta '2' = rifiutato (documento inesistente, già annullato, RT non in servizio...). Ipotesi sul formato.
   */
  private rtDocument(command: string, type: 'refund' | 'void'): string {
    const s = command.substring(5);
    const ref: DocumentReference = {
      zReport: digits(s, 0, 4, 'Z'),
      number: digits(s, 4, 4, 'numero documento'),
      date: s.substring(8, 14)
    };
    const mode = s.charAt(14);
    if (!/^\d{6}$/.test(ref.date) || !/^[0-9]$/.test(mode)) throw new Refusal(EMULATOR_ERROR.ILLEGAL, 'Riferimento malformato');
    const perform = type === 'refund' ? mode === '1' || mode === '8' : mode === '1';

    const original = this.find(ref);
    if (!this.rtInService || !original || original.kind !== 'sale' || original.voided) return '2';
    if (!perform) return '0';

    if (type === 'refund') {
      this.doc = { kind: 'refund', phase: 'sale', lines: [], totalCents: 0, payments: [], paidCents: 0, reference: ref };
      return '0';
    }
    original.voided = true;
    this.voidedCount++;
    this.voidedCents += original.totalCents;
    this.doc = null;
    this.emitVoid(original, ref);
    return '1';
  }

  private emitVoid(original: EmittedDocument, ref: DocumentReference): void {
    this.receiptNumber++;
    this.documents.push({
      kind: 'void',
      zReport: this.lastZ + 1,
      number: this.receiptNumber,
      date: ddmmyy(this.now()),
      totalCents: original.totalCents,
      lines: original.lines,
      payments: original.payments,
      changeCents: 0,
      reference: ref,
      voided: false
    });
    this.dayOpened = true;
  }

  // --- Documento non fiscale ---

  private beginNonFiscal(): undefined {
    if (this.doc || this.nonFiscalOpen) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Un documento è già aperto');
    this.nonFiscalOpen = true;
    return undefined;
  }

  private requireNonFiscal(): undefined {
    if (!this.nonFiscalOpen) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Nessun documento non fiscale aperto');
    return undefined;
  }

  private endNonFiscal(): undefined {
    this.requireNonFiscal();
    this.nonFiscalOpen = false;
    return undefined;
  }

  // --- Chiusure ---

  private zReport(): undefined {
    if (this.doc || this.nonFiscalOpen) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Documento aperto');
    if (!this.rtInService) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'RT non in servizio');
    this.lastZ++;
    this.receiptNumber = 0;
    this.dailyTotalCents = 0;
    this.refundTotalCents = 0;
    this.midVoidCents = 0;
    this.voidedCount = 0;
    this.voidedCents = 0;
    this.refundCount = 0;
    this.dayOpened = false;
    return undefined;
  }

  private xReport(): undefined {
    if (this.doc || this.nonFiscalOpen) throw new Refusal(EMULATOR_ERROR.WRONG_STATE, 'Documento aperto');
    this.xReports++;
    return undefined;
  }
}
