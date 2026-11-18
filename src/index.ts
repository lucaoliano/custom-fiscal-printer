/**
 * CustomFiscalPrinter - Modulo Node.js & TypeScript per Stampanti Fiscali Custom
 */

export { CustomFiscalPrinter, formatJavaPad5, getCmdTimeoutMs } from './client/fiscal-printer';
export { Mutex } from './utils/mutex';

// Trasporti
export { ITransport } from './transports/transport.interface';
export { TcpTransport } from './transports/tcp.transport';
export { SerialTransport } from './transports/serial.transport';
export { MockTransport, MockHandler } from './transports/mock.transport';

// Protocollo e formattazione
export {
  calculateChecksum,
  buildFrame,
  parseResponse,
  ParsedFrame
} from './protocol/frame';
export { Esc, ESC, parseEscSequenceLine, FormattedPrintLine, EscOp, EscFilterMode, EscParseOptions, EscBarcodeOptions } from './protocol/esc-sequences';
export {
  replaceEuroCharacter,
  sanitizeText,
  formatPrice,
  formatQuantity,
  formatDepartment,
  formatVat,
  formatDescription,
  formatDynamicDescription,
  formatDateDDMMYY,
  formatNumberPad,
  formatQty,
  formatSinglePrice
} from './utils/formatters';

// Tipi e opzioni
export {
  ConnectionOptions,
  TcpConnectionOptions,
  SerialConnectionOptions,
  MockConnectionOptions,
  PrinterStatus,
  RTStatus,
  PrinterCapabilities,
  RTConnectionStatus,
  DGFEInfo,
  FiscalItem,
  AdjustmentType,
  ItemAdjustment,
  FiscalPayment,
  FiscalReceiptOptions,
  DocumentReference,
  RefundOptions,
  VoidOptions,
  InvoiceOptions,
  InvoiceReceiptOptions,
  DocumentEmissionResult,
  RtDocumentOptions,
  BeginReceiptResult,
  PrinterStatusUpdateEvent,
  ItemVoid,
  AdjustmentKind,
  NonFiscalOptions,
  TextAlignment,
  TextStyle,
  BarcodeType,
  BarcodeOptions,
  ErrorPolicy,
  ChecksumPolicy,
  PrinterLogger,
  PrinterOptions
} from './types';
export { isIgnoredByJavaDriver } from './client/fiscal-printer';

// Errori
export {
  CustomFiscalError,
  CustomProtocolError,
  CustomTimeoutError,
  CustomOperationNotAllowedError,
  CUSTOM_ERROR_DESCRIPTIONS,
  CustomErrorKind,
  classifyCustomError
} from './errors';
