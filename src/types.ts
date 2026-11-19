/**
 * Tipi, DTO e interfacce per il modulo CustomFiscalPrinter
 */

import type { ReconnectOptions } from './transports/reconnecting.transport';

/**
 * Configurazione per la connessione via rete locale Ethernet o Wi-Fi.
 */
export interface TcpConnectionOptions {
  /** Tipo di connessione socket TCP */
  type: 'tcp';
  /** Indirizzo IP o hostname della stampante (es. "192.168.0.1") */
  host: string;
  /** Porta TCP aperta sulla stampante (default: 9100) */
  port?: number;
  /** Timeout massimo di attesa in millisecondi (default: 8000) */
  timeout?: number;
  /** Riapre il canale se cade o dopo un timeout, prima del comando successivo (mai rigiocando un comando inviato). Default: false */
  reconnect?: boolean | ReconnectOptions;
}

/**
 * Configurazione per la connessione via porta seriale RS232 o USB Virtual COM.
 */
export interface SerialConnectionOptions {
  /** Tipo di connessione porta seriale */
  type: 'serial';
  /** Percorso porta seriale (es. "COM3" su Windows, "/dev/ttyUSB0" su Linux o "/dev/tty.usbserial-..." su macOS) */
  path: string;
  /** Velocità di trasmissione in baud (default: 19200, supportato anche 57600 o 115200) */
  baudRate?: number;
  /** Bit di dati (7 o 8, default: 8) */
  dataBits?: 7 | 8;
  /** Parità ('none', 'odd', 'even', default: 'none') */
  parity?: 'none' | 'odd' | 'even';
  /** Bit di stop (1 o 2, default: 1) */
  stopBits?: 1 | 2;
  /** Timeout massimo di attesa in millisecondi (default: 8000) */
  timeout?: number;
  /** Riapre la porta se cade o dopo un timeout, prima del comando successivo (mai rigiocando un comando inviato). Default: false */
  reconnect?: boolean | ReconnectOptions;
}

/**
 * Configurazione per il simulatore di test in-memory (senza hardware).
 */
export interface MockConnectionOptions {
  /** Tipo di connessione mock per test unitari */
  type: 'mock';
}

/**
 * Opzioni unificate di connessione alla stampante.
 */
export type ConnectionOptions =
  | TcpConnectionOptions
  | SerialConnectionOptions
  | MockConnectionOptions;

/**
 * Stato hardware dei sensori fisici della stampante (comando 1109).
 */
export interface PrinterStatus {
  /** Coperchio stampante aperto (Cover Open) */
  coverOpen: boolean;
  /** Carta del rotolo fiscale completamente esaurita (Paper Empty) */
  paperEmpty: boolean;
  /** Carta del rotolo fiscale in esaurimento (Paper Near End) */
  paperNearEnd: boolean;
  /** Giornale elettronico esaurito */
  journalEmpty: boolean;
  /** Giornale elettronico quasi esaurito */
  journalNearEnd: boolean;
  /** Risposta grezza restituita dalla stampante */
  rawStatus: string;
}

/**
 * Stato logico del Registratore Telematico RT (comando 1511).
 *
 * I campi seguono il layout usato dal driver Java ufficiale (`directIO("1511XML")`, `ReadRTLogicalStatus`):
 * le posizioni sono quelle della risposta privata dei byte di stato (offset Java - 1).
 */
export interface RTStatus {
  /** Se true, il dispositivo opera come Registratore Telematico (risposta 1511 valida e completa) */
  isRT: boolean;
  /** Se true, l'RT e' IN SERVIZIO (IN_SERVIZIO = '1'): e' la condizione che il driver Java chiama RTMode = 3 */
  inService: boolean;
  /**
   * @deprecated Usare `inService`. Valore equivalente al `RTMode` del driver Java:
   * 3 se in servizio, 2 se non in servizio, 0 se il dispositivo non risponde come RT.
   */
  rtMode: number;
  /** Se true, la stampante e' in modalita' addestramento (DEMO = '1') e non ha valore fiscale */
  trainingMode: boolean;
  /** SERIAL_RT: primo carattere della risposta */
  serialRt: string;
  /** MATR_RT: matricola RT (11 caratteri) */
  matrRt: string;
  /** MATR_83: matricola ex art. 83 (10 caratteri) */
  matr83: string;
  /** CHIAVE_PRI (il driver Java legge la stessa posizione di CENSIMENTO) */
  chiavePri: string;
  /** CENSIMENTO */
  censimento: string;
  /** ATTIVAZIONE */
  attivazione: string;
  /** DATA_IN_SERVIZIO (6 caratteri) */
  dataInServizio: string;
  /** SIMULAZIONE */
  simulazione: string;
  /** NEXTTICKETRT ('0' se il campo non e' presente) */
  nextTicketRt: string;
  /** VATSPLIT ('0' se il campo non e' presente) */
  vatSplit: string;
  /** INACTIVITYPERIOD ('0' se il campo non e' presente) */
  inactivityPeriod: string;
  /** Risposta grezza restituita dalla stampante */
  rawStatus: string;
}

/**
 * Capacita' della stampante rilevate come fa il driver Java in `open()`
 * (`ReadPrinterModel` + `ReadRTLogicalStatus`). Vedi `CustomFiscalPrinter.identify()`.
 */
export interface PrinterCapabilities {
  /** Codice modello (esadecimale maiuscolo) letto da `1014`; '' se non disponibile */
  model: string;
  /** Codice sottomodello (esadecimale maiuscolo) letto da `1014`; '' se non disponibile */
  subModel: string;
  /** `RXPrinter` del driver Java (famiglie di stampanti a 44 colonne) */
  rxPrinter: boolean;
  /** `RXPrinterTiny` del driver Java */
  rxPrinterTiny: boolean;
  /** `StaticState.PrinterArch` del driver Java: 3 = famiglia RX, 2 = famiglie precedenti, 1 = non determinata */
  printerArch: number;
  /** Lunghezza massima della descrizione articolo (22, oppure 44 sulle stampanti RX) */
  descriptionLength: number;
  /** Lunghezza massima della descrizione pagamento (22) */
  descriptionLengthPayment: number;
  /** `MessageLength` del driver Java (32, oppure 44 sulle stampanti RX) */
  messageLength: number;
  /** `MessageLength42` del driver Java (42/44; 56 se `1013` contiene la stringa modello "NCR 130A") */
  messageLength42: number;
  /** Numero massimo di righe di intestazione programmabili (6 di default, 9 dopo l'identificazione) */
  numHeaderLines: number;
  /** true se l'RT e' in servizio (`RTMode == 3` nel driver Java) */
  rtInService: boolean;
  /** `RTMode` del driver Java: 3 = RT in servizio, 2 = altrimenti (default 2) */
  rtMode: number;
  /** true se la stampante e' in modalita' addestramento */
  trainingMode: boolean;
}

/**
 * Stato della connessione telematica verso i server dell'Agenzia delle Entrate (comando 1510).
 */
export interface RTConnectionStatus {
  /** Stato dell'ultimo comando di invio (es. "1" = successo) */
  commandStatus: string;
  /** Descrizione testuale dell'ultima operazione (es. "INVIO CORRISPETTIVI") */
  operationDesc: string;
  /** Codice errore applicativo Agenzia delle Entrate (3 cifre) */
  applError: string;
  /** Codice esito o errore protocollo HTTP (es. "200") */
  httpError: string;
  /** Codice errore di validazione file XML corrispettivi */
  xmlError: string;
  /** Risposta grezza restituita dal comando 1510 */
  rawStatus: string;
}

/**
 * Informazioni sul Giornale di Fondo Elettronico DGFE.
 */
export interface DGFEInfo {
  /** Percentuale di memoria DGFE occupata (da 0 a 100) */
  usedPercentage?: number;
  /** Risposta grezza */
  rawStatus: string;
}

/**
 * Dati di una riga articolo per la vendita su scontrino fiscale RT (comando 33011).
 */
export interface FiscalItem {
  /** Descrizione articolo stampata sullo scontrino (max 22 o 44 caratteri) */
  description: string;
  /** Importo totale riga in centesimi di euro (es. 150 = 1,50 €). Con quantity = 1 coincide con il prezzo unitario. */
  priceInCents: number;
  /** Quantità venduta (default: 1, supporta decimali es. 1.5 per articoli a peso) */
  quantity?: number;
  /**
   * Indice aliquota IVA programmata nella stampante (1..9, default: 1 = 22%).
   * Alternativo a `department`: come nel driver Java (vatInfo 10000..10029 = reparto), se e' indicato un
   * reparto > 0 non si puo' indicare anche l'aliquota (RangeError) e viene inviata aliquota '0'.
   */
  vatRate?: number;
  /**
   * Indice reparto cassa programmato (intero 0..29). 0 o omesso = nessun reparto (si usa `vatRate`).
   * Con reparto > 0 il comando 33011 invia reparto a 3 cifre e aliquota '0'.
   */
  department?: number;
  /** Nome unità di misura facoltativo (es. "Kg", "pz", "lt"), stampato nella riga di dettaglio solo se quantity !== 1 */
  unitName?: string;
  /**
   * Prezzo unitario in centesimi (es. prezzo al kg). OBBLIGATORIO quando quantity !== 1:
   * viene inviato nel comando 33011 e stampato nella riga di dettaglio `Qty x PrezzoUnitario`.
   * Se omesso (quantity = 1) coincide con priceInCents.
   */
  unitPriceInCents?: number;
}

/**
 * Tipo di correzione/variazione importo.
 */
export type AdjustmentType = 'DISCOUNT' | 'MARKUP';

/**
 * Dati di sconto o maggiorazione su scontrino fiscale RT.
 */
export interface ItemAdjustment {
  /** 'DISCOUNT' per sconto, 'MARKUP' per maggiorazione */
  type: AdjustmentType;
  /** Descrizione della variazione (es. "Sconto Convenzione") */
  description: string;
  /** Importo dello sconto/maggiorazione in centesimi (es. 100 = 1,00 €) */
  amountInCents: number;
  /** Aliquota IVA associata (1..9, default 1). Alternativa a `department` (RangeError se indicati entrambi) */
  vatRate?: number;
  /**
   * Reparto associato (0..29). 0 o omesso = nessun reparto: il driver Java invia reparto 1 ('001') e l'aliquota
   * indicata, tranne sulle stampanti `printerArch === 3` dove invia reparto '000'.
   */
  department?: number;
}

/**
 * Dati del pagamento da registrare sullo scontrino (comando 3004 / 3007).
 */
export interface FiscalPayment {
  /** Importo pagato in centesimi (es. 1000 = 10,00 €) */
  amountInCents: number;
  /** Descrizione metodo di pagamento (es. "Contanti", "Carta di Credito", "Ticket", default: "Contanti") */
  description?: string;
  /** Indice forma di pagamento programmata nella stampante (1..10, facoltativo) */
  paymentId?: number;
  /** Totale atteso in centesimi per la verifica `checkTotal` (vedi `PrinterOptions.checkTotal`); 0/omesso = nessuna verifica */
  expectedTotalInCents?: number;
}

/**
 * Opzioni di apertura dello scontrino fiscale RT.
 */
export interface FiscalReceiptOptions {
  /** Righe di intestazione aggiuntive (supportano formattazione Esc) */
  headerLines?: string[];
  /** Righe di cortesia da stampare in calce prima del taglio */
  trailerLines?: string[];
  /** Codice Lotteria degli Scontrini del cliente (8 caratteri alfanumerici) */
  lotteryCode?: string;
  /** Codice Fiscale del cliente per detrazione sanitaria / scontrino parlante */
  fiscalCode?: string;
  /**
   * Se true (default), richiede il riepilogo dettagliato pagamenti RT. Come nel driver Java ha effetto
   * (comando `30112`) solo se la stampante e' una RX con RT in servizio; altrimenti si invia `3011`.
   */
  printDetails?: boolean;
  /**
   * Apre uno scontrino di tipo FATTURA SEMPLIFICATA (FiscalReceiptType 6 del driver Java).
   * Dopo `71020`/`71021` (e il codice lotteria) invia `71023`/`71029` e, solo con `taxId` che inizia per `@`, `7103`.
   * I dati cliente (`3010C`) sono stampati al primo pagamento (`printRecTotal`) o a `printRecNotPaid`.
   */
  invoice?: InvoiceReceiptOptions;
  /**
   * Apre uno scontrino di tipo RESO (FiscalReceiptType 7 del driver Java): a `endFiscalReceipt` le eventuali
   * righe aggiuntive impostate con `setRefundInfo` sono stampate con `30101`.
   */
  refund?: boolean;
  /**
   * Documento commerciale di RESO / ANNULLO RT collegato a un documento precedente (`RTDocType` 1/2 di Java,
   * `directIO -95010/-95011`). Eseguito DENTRO `beginFiscalReceipt` (flusso `7101R`/`7101A` ASK + PERFORM, dopo
   * `71020`/`71021` e senza lotteria). Dopo un RESO il documento resta APERTO: occorre vendere gli articoli resi
   * e chiudere con `endFiscalReceipt`. Un ANNULLO eseguito dalla stampante (PERFORM = 1) chiude subito il documento.
   * Ha effetto solo con l'RT in servizio (`RTMode == 3`).
   */
  rtDocument?: RtDocumentOptions;
}

/**
 * Riferimento di un documento commerciale RT di reso/annullo (vedi `FiscalReceiptOptions.rtDocument`).
 */
export interface RtDocumentOptions {
  /** `'refund'` = RESO (`7101R`), `'void'` = ANNULLO (`7101A`) */
  type: 'refund' | 'void';
  /** Riferimento al documento originale */
  docRef: DocumentReference;
  /** Matricola della stampante che ha emesso il documento originale (max 11 caratteri inviati) */
  deviceSerial: string;
  /** Se true, sopprime la preview (`NoPreview` di Java) */
  noPreview?: boolean;
  /** Codice lotteria cliente facoltativo (8 caratteri) */
  lotteryCode?: string;
}

/**
 * Esito di `beginFiscalReceipt`.
 */
export interface BeginReceiptResult {
  /** true se il documento fiscale e' rimasto aperto sulla stampante (vendita da effettuare e `endFiscalReceipt`) */
  documentOpen: boolean;
  /** Solo con `rtDocument`: true se la stampante ha eseguito il PERFORM `7101R`/`7101A` */
  rtDocumentEmitted?: boolean;
}

/**
 * Dati della fattura semplificata (PreLine "numero|conto IVA" + proprieta' CustomerInfo del driver Java).
 */
export interface InvoiceReceiptOptions {
  /**
   * Numero fattura. Stringa senza `$` e non vuota; se inizia per `§` si usa `71029` (variante a 7 caratteri),
   * altrimenti `71023` (max 6 caratteri letti). Non numerico -> `00000`; oltre 5 cifre si tengono le prime 5.
   */
  number: string | number;
  /** Conto IVA / Codice Fiscale / P.IVA cliente (non vuoto). Se inizia per `@` e' inviato `7103` e non stampato. */
  taxId: string;
  /** Righe anagrafica cliente (`3010C`), stampate al primo pagamento */
  customerLines?: string[];
}

/**
 * Esito delle operazioni che in Java possono terminare "senza fare nulla" (es. reso/annullo con cifra ASK inattesa).
 */
export interface DocumentEmissionResult {
  /** true se la stampante ha emesso il documento (PERFORM inviato e non rifiutato) */
  emitted: boolean;
  /** Motivo del mancato invio quando `emitted` e' false */
  reason?: string;
  /**
   * true se il documento e' rimasto APERTO sulla stampante: il chiamante deve registrare gli articoli (e il
   * pagamento) e chiudere con `endFiscalReceipt`. Un reso RT resta sempre aperto; un annullo e' chiuso dalla
   * stampante stessa (`false`).
   */
  documentOpen: boolean;
}

/**
 * Evento di variazione dei sensori (`StatusUpdateEvent` del driver Java): coperchio/carta scontrino/giornale.
 */
export interface PrinterStatusUpdateEvent {
  /** Codice `FPTR_SUE_*`: 11 COVER_OPEN, 12 COVER_OK, 21 JRN_EMPTY, 22 JRN_NEAREMPTY, 23 JRN_PAPEROK, 24 REC_EMPTY, 25 REC_NEAREMPTY, 26 REC_PAPEROK */
  code: number;
  /** Nome simbolico (`COVER_OPEN`, `REC_PAPEROK`, ...) */
  name: string;
  /** Stato dei sensori (`1109`) che ha generato l'evento */
  status: PrinterStatus;
}

/**
 * Riga articolo per `printRecItemVoid` (storno articolo, `33014`).
 */
export interface ItemVoid {
  description: string;
  /** Importo in centesimi (usato se `unitPriceInCents` e' omesso o 0) */
  priceInCents: number;
  /** Quantita' (default 1) */
  quantity?: number;
  /** Prezzo unitario in centesimi (default = priceInCents) */
  unitPriceInCents?: number;
  /** Aliquota IVA (intero; come Java: 10000..10030 = reparto 0..30) */
  vatInfo?: number;
}

/** Tipo di rettifica su subtotale / annullo rettifica articolo */
export type AdjustmentKind = 'DISCOUNT' | 'MARKUP';

/**
 * Riferimento al documento commerciale originale per operazioni di reso o annullo.
 */
export interface DocumentReference {
  /** Numero azzeramento fiscale Z di emissione (es. 1 o "0001") */
  zReport: number | string;
  /** Numero scontrino all'interno della giornata (es. 42 o "0042") */
  ticketNumber: number | string;
  /** Data di emissione del documento originale (Date o stringa "DDMMYY") */
  date: Date | string;
}

/**
 * Parametri per l'emissione del Documento Commerciale di Reso RT (comando 7101R).
 */
export interface RefundOptions {
  /** Riferimento al documento originale da cui si rende la merce */
  docRef: DocumentReference;
  /** Matricola fiscale della stampante originale (es. "STMTE110306"); come in Java ne sono inviati max 11 caratteri */
  deviceSerial: string;
  /** Codice lotteria cliente facoltativo */
  lotteryCode?: string;
  /** Se true, sopprime la preview e stampa direttamente */
  noPreview?: boolean;
}

/**
 * Parametri per l'emissione del Documento Commerciale di Annullo RT (comando 7101A).
 */
export interface VoidOptions {
  /** Riferimento al documento originale da annullare */
  docRef: DocumentReference;
  /** Matricola fiscale della stampante originale (es. "STMTE110306"); come in Java ne sono inviati max 11 caratteri */
  deviceSerial: string;
  /** Codice lotteria cliente facoltativo */
  lotteryCode?: string;
  /** Se true, sopprime la preview e stampa direttamente */
  noPreview?: boolean;
}

/**
 * Parametri per l'emissione di una Fattura Fiscale Semplificata RT (comando 71023).
 */
export interface InvoiceOptions {
  /** Numero fattura (0 per progressivo automatico stampante) */
  invoiceNumber?: number | string;
  /** Codice Fiscale o Partita IVA del cliente */
  taxId: string;
  /** Righe anagrafiche del cliente (da 1 a 8 righe di indirizzo, ragione sociale, ecc.) */
  customerLines: string[];
  /** Codice lotteria facoltativo */
  lotteryCode?: string;
  /** Intestazione aggiuntiva */
  additionalHeader?: string;
  /** Cortesia in calce */
  additionalTrailer?: string;
}

/**
 * Opzioni per il documento non fiscale (gestionale).
 */
export interface NonFiscalOptions {
  /** Se false, sopprime la stampa dell'intestazione grafica/testuale (PreLine = "NOHEADER") */
  printHeader?: boolean;
}

/**
 * Allineamento testo per documenti non fiscali e intestazioni.
 */
export type TextAlignment = 'LEFT' | 'CENTER' | 'RIGHT';

/**
 * Stile di carattere supportato dalla stampante.
 */
export type TextStyle =
  | 'NORMAL'
  | 'BOLD'
  | 'DOUBLE_WIDTH'
  | 'DOUBLE_HEIGHT'
  | 'CONDENSED';

/**
 * Tipologie di codici a barre gestiti nativamente dalle stampanti Custom.
 */
export type BarcodeType =
  | 'EAN13'
  | 'EAN8'
  | 'ITF'
  | 'CODE39'
  | 'EAN128'
  | 'QRCODE'
  | 'GS1DATABAR'
  | 'PDF417';

/**
 * Configurazione di stampa codice a barre.
 */
export interface BarcodeOptions {
  /** Tipologia di barcode */
  type: BarcodeType;
  /** Stringa dati da codificare */
  data: string;
  /** Allineamento orizzontale */
  alignment?: TextAlignment;
}

/**
 * Politica di gestione degli errori restituiti dalla stampante.
 * - `'java'` (default): replica `ProtCustom.handleCustomError` del driver JavaPOS ufficiale, che NON propaga
 *   alcuni errori in contesti precisi (es. ERR05 sui comandi che non muovono denaro, ERR03 su gran parte dei
 *   comandi). Gli errori su vendite (`3301x`), pagamenti (`3004`/`3007`) e non pagato (`3005`) vengono sempre propagati.
 *   L'errore ignorato resta visibile in `ParsedFrame.ignoredErrorCode` e viene segnalato con `logger.warn`.
 * - `'strict'`: ogni risposta di errore genera un `CustomFiscalError`.
 */
export type ErrorPolicy = 'java' | 'strict';

/**
 * Politica di verifica del checksum delle risposte.
 * - `'warn'` (default): un checksum errato viene segnalato con `logger.warn` ma la risposta è accettata
 *   (il driver Java ufficiale non verifica il checksum delle risposte).
 * - `'strict'`: un checksum errato genera `CustomProtocolError`.
 * - `'off'`: nessuna verifica.
 */
export type ChecksumPolicy = 'strict' | 'warn' | 'off';

/**
 * Logger opzionale (compatibile con `console`, pino, winston...).
 * `debug` riceve il traffico TX/RX in esadecimale, utile per l'assistenza.
 */
export interface PrinterLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Opzioni di comportamento del client (secondo parametro del costruttore).
 */
export interface PrinterOptions {
  /** Gestione errori stampante (default: `'java'`) */
  errorPolicy?: ErrorPolicy;
  /** Verifica checksum risposte (default: `'warn'`) */
  checksumPolicy?: ChecksumPolicy;
  /** Logger opzionale */
  logger?: PrinterLogger;
  /**
   * Attesa prima del polling `1513` dopo Z-report / training, in ms (default: 2000, come il driver Java).
   * Da modificare solo nei test.
   */
  pendingOperationDelayMs?: number;
  /**
   * Se true (default) la stampante viene identificata (modello `1013`/`1014` e stato RT `1511`, come `open()`
   * del driver Java) in modo lazy, alla prima operazione che ne dipende (inizio/fine scontrino, intestazione,
   * articoli). Con false non vengono inviati comandi di identificazione: si usano i valori di default
   * (22 colonne, `3011`), a meno che il chiamante non invochi `identify()`.
   */
  autoIdentify?: boolean;
  /**
   * Attesa dopo `setHeaderLine` sulle stampanti non RX, in ms (default: 1200, come il driver Java).
   * Da modificare solo nei test.
   */
  headerLineDelayMs?: number;
  /**
   * Come la proprieta' `deleteEmptyHeaderLines` del driver Java (default false): se true, dopo ogni
   * `setHeaderLine` viene inviato `6301` + numero riga.
   */
  deleteEmptyHeaderLines?: boolean;
  /**
   * Come `CheckTotal` del driver Java, impostato a true da `open()` (default true): se true, `printRecTotal` con importo totale atteso
   * verifica con `1003` che il totale sulla stampante (`data[37..46)`) coincida; in caso contrario esegue
   * `resetPrinter()` e lancia `CustomOperationNotAllowedError` (JPOS 212). Ignorato sulle stampanti `printerArch === 2`.
   */
  checkTotal?: boolean;
  /**
   * Come i controlli `checkFiscalDocOpened`/`checkNonFiscalDocOpened`/`checkFiscalDocNotOpened` del driver Java
   * (default true): il client tiene traccia di scontrino fiscale / documento non fiscale aperti e rifiuta con
   * `CustomOperationNotAllowedError` (JPOS 114/207, stato errato) le operazioni fuori sequenza.
   * Con false i controlli sono disattivati (utile dopo un riavvio del processo con un documento aperto sulla stampante).
   */
  documentStateChecks?: boolean;
  /**
   * Come `open()` del driver Java (default true): al `connect()` vengono rilevati modello e stato RT
   * (`ReadPrinterModel`, `ReadRTLogicalStatus`). `autoIdentify: false` disattiva sia questa rilevazione sia quella
   * lazy; con `identifyOnConnect: false` resta solo la rilevazione lazy alla prima operazione.
   */
  identifyOnConnect?: boolean;
  /**
   * Monitoraggio sensori come `CheckStatusThread` del driver Java: ogni ~2 s legge `1109` e emette l'evento
   * `'statusUpdate'` (`PrinterStatusUpdateEvent`) solo alle transizioni di coperchio/carta/giornale.
   * Come Java (che avvia sempre il thread in `open()`) e' ATTIVO DI DEFAULT; `false` lo disattiva. Il timer non tiene
   * vivo il processo (`unref`) e si ferma a `disconnect()`. Non si interpone mai con comandi o transazioni in corso e
   * viene sospeso durante inizio scontrino, Z/X e rapporti periodici (come `bUpdateStatus` di Java).
   * `true` = intervallo 2000 ms.
   */
  statusPolling?: boolean | { intervalMs?: number };
}
