/**
 * Errori e codici diagnostici del protocollo Custom
 */

/**
 * Classificazione tipizzata dell'errore, derivata dalla mappatura del driver Java ufficiale
 * (ProtCustom.getExtCustomError) verso i codici JavaPOS.
 */
export type CustomErrorKind =
  | 'TECHNICAL_ASSISTANCE' // JPOS_EFPTR_TECHNICAL_ASSISTANCE (208)
  | 'ILLEGAL' // JPOS_E_ILLEGAL (1106)
  | 'WRONG_STATE' // JPOS_EFPTR_WRONG_STATE (207)
  | 'WORD_NOT_ALLOWED' // JPOS_EFPTR_WORD_NOT_ALLOWED (221)
  | 'BUSY' // JPOS_E_BUSY (1113)
  | 'RECEIPT_TOTAL_OVERFLOW' // JPOS_EFPTR_RECEIPT_TOTAL_OVERFLOW (216)
  | 'BAD_ITEM_AMOUNT' // JPOS_EFPTR_BAD_ITEM_AMOUNT (214)
  | 'BAD_DATE' // JPOS_EFPTR_BAD_DATE (219)
  | 'PAPER_EMPTY' // JPOS_EPTR_REC_EMPTY (203)
  | 'COVER_OPEN' // JPOS_EPTR_COVER_OPEN (201)
  | 'MISSING_DEVICES' // JPOS_EFPTR_MISSING_DEVICES (206)
  | 'COMMUNICATION' // JPOS_E_OFFLINE (1108) / JPOS_E_NOHARDWARE (1107)
  | 'NEGATIVE_TOTAL' // JPOS_EFPTR_NEGATIVE_TOTAL (220)
  | 'FISCAL_MEMORY_DISCONNECTED' // JPOS_EFPTR_FISCAL_MEMORY_DISCONNECTED (211)
  | 'FISCAL_MEMORY_FULL'; // JPOS_EFPTR_FISCAL_MEMORY_FULL (210)

interface ErrorInfo {
  kind: CustomErrorKind;
  description: string;
}

const INFO_TECH: ErrorInfo = { kind: 'TECHNICAL_ASSISTANCE', description: 'Errore tecnico della stampante: richiesta assistenza tecnica' };
const INFO_ILLEGAL: ErrorInfo = { kind: 'ILLEGAL', description: 'Comando o parametro non valido' };
const INFO_STATE: ErrorInfo = { kind: 'WRONG_STATE', description: 'Stato della stampante non valido per il comando richiesto' };
const INFO_DATE: ErrorInfo = { kind: 'BAD_DATE', description: 'Data o ora non valida' };

const entries: Array<[number[], ErrorInfo]> = [
  [[2, 6, 15, 18, 19, 65, 66, 67, 68], INFO_TECH],
  [[3, 5, 9, 24, 25, 30, 31, 32, 33, 35, 36, 40, 52, 53, 57], INFO_ILLEGAL],
  [[4, 54, 55], INFO_STATE],
  [[7], { kind: 'WORD_NOT_ALLOWED', description: 'Parola o testo non consentito' }],
  [[8], { kind: 'BUSY', description: 'Stampante occupata: riprovare più tardi' }],
  [[10], { kind: 'RECEIPT_TOTAL_OVERFLOW', description: 'Totale dello scontrino oltre il limite consentito' }],
  [[11], { kind: 'BAD_ITEM_AMOUNT', description: 'Importo articolo non valido' }],
  [[12, 13, 14, 22], INFO_DATE],
  [[16], { kind: 'PAPER_EMPTY', description: 'Carta esaurita' }],
  [[17, 56], { kind: 'MISSING_DEVICES', description: 'Periferica o dispositivo mancante' }],
  [[20], { kind: 'COMMUNICATION', description: 'Stampante non raggiungibile o fuori linea' }],
  [[23], { kind: 'NEGATIVE_TOTAL', description: 'Totale negativo non consentito' }],
  [[50], { kind: 'FISCAL_MEMORY_DISCONNECTED', description: 'Memoria fiscale scollegata' }],
  [[51], { kind: 'FISCAL_MEMORY_FULL', description: 'Memoria fiscale piena' }],
  [[64], { kind: 'COVER_OPEN', description: 'Coperchio aperto' }]
];

const ERROR_INFO: Record<number, ErrorInfo> = {};
for (const [codes, info] of entries) {
  for (const c of codes) ERROR_INFO[c] = info;
}

/** Categoria assegnata ai codici non presenti nella tabella (come il driver Java: WRONG_STATE). */
const DEFAULT_INFO: ErrorInfo = INFO_STATE;

export const CUSTOM_ERROR_DESCRIPTIONS: Record<number, string> = Object.fromEntries(
  Object.entries(ERROR_INFO).map(([code, info]) => [Number(code), info.description])
) as Record<number, string>;
CUSTOM_ERROR_DESCRIPTIONS[99] = 'Errore esteso interno (richiede lettura codice esteso)';

/** Restituisce la categoria tipizzata per un codice errore Custom. */
export function classifyCustomError(code: number): CustomErrorKind {
  return (ERROR_INFO[code] ?? DEFAULT_INFO).kind;
}

export class CustomFiscalError extends Error {
  public readonly code: number;
  public readonly rawError: string;
  public readonly command?: string;
  public readonly extendedCode?: number;
  /** Categoria tipizzata (mappatura del driver Java verso JavaPOS). */
  public readonly kind: CustomErrorKind;
  /** true solo per BUSY: il comando può essere ritentato dal chiamante (la libreria non ritenta mai da sola). */
  public readonly retryable: boolean;

  constructor(code: number, rawError: string, command?: string, extendedCode?: number) {
    const desc = CUSTOM_ERROR_DESCRIPTIONS[code] || `Errore stampante fiscale Custom: ${code}`;
    super(extendedCode ? `${desc} [Codice esteso: ${extendedCode}]` : desc);
    this.name = 'CustomFiscalError';
    this.code = code;
    this.rawError = rawError;
    this.command = command;
    this.extendedCode = extendedCode;
    this.kind = classifyCustomError(code);
    this.retryable = this.kind === 'BUSY';
  }
}

export class CustomProtocolError extends Error {
  public readonly rawData?: string | Buffer;

  constructor(message: string, rawData?: string | Buffer) {
    super(message);
    this.name = 'CustomProtocolError';
    this.rawData = rawData;
  }
}

export class CustomTimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly command?: string;

  constructor(message: string, timeoutMs: number, command?: string) {
    super(message);
    this.name = 'CustomTimeoutError';
    this.timeoutMs = timeoutMs;
    this.command = command;
  }
}

/**
 * Operazione non consentita (JPOS_E_ILLEGAL, 106 nel driver Java).
 *
 * Il driver Java la lancia come `JposException(106, "Operation not allowed")` quando la stampante rifiuta
 * un reso/annullo (risposta 2 o ERR03/ERR05 a `7101R`/`7101A`) e, con "Error Day Opened!", quando si tenta di
 * programmare la tabella IVA a giornata fiscale aperta. Non e' un errore di protocollo `ERRxx`, quindi
 * non e' un `CustomFiscalError`.
 */
export class CustomOperationNotAllowedError extends Error {
  /** Codice JavaPOS equivalente (JPOS_E_ILLEGAL) */
  public readonly jposCode: number;
  /** Codice esteso JavaPOS (es. 207 = JPOS_EFPTR_WRONG_STATE, 212 = totale non corrispondente) quando jposCode e' 114 */
  public readonly extendedJposCode?: number;
  public readonly command?: string;

  constructor(message: string = 'Operazione non consentita', command?: string, jposCode: number = 106, extendedJposCode?: number) {
    super(message);
    this.name = 'CustomOperationNotAllowedError';
    this.command = command;
    this.jposCode = jposCode;
    this.extendedJposCode = extendedJposCode;
  }
}
