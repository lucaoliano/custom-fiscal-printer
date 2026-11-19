# custom-fiscal-printer

**English** · [Italiano](README.it.md)

A **Node.js / TypeScript** driver for **Custom** fiscal printers and Italian telematic cash registers (*Registratori Telematici*, RT): Kube II F, Q3X F, Big Plus, Fusion and compatible models.

The module speaks Custom's packet protocol (STX/ETX) directly over TCP or serial, with no JDK, JavaPOS or native libraries. The protocol was reconstructed by analysing the `CUSTOMJPOSF` 3.00.02 JavaPOS driver, whose data-exchange and error-handling logic this module reproduces.

> [!WARNING]
> **Unofficial project, still being validated.** It is not affiliated with or endorsed by Custom S.p.A. Product names are trademarks of their respective owners. Behaviour is covered by automated tests and has been compared against the official driver's bytecode, but **it has not yet been tested on a real printer**: validate it on your own model and firmware before using it in production. The software is provided without warranty (see [LICENSE](LICENSE)).

---

## Features

- **Transports**: TCP (Ethernet / Wi-Fi, port 9100), RS-232 serial / USB Virtual COM via [`serialport`](https://serialport.io), and a *mock* transport for development and testing without hardware.
- **Functional parity with the JavaPOS driver**: command formats, timeouts, sequences and error handling follow the `CUSTOMJPOSF` 3.00.02 bytecode, method by method.
- **RT commercial document** (receipt): sales by unit and by weight, item and subtotal discounts and surcharges, item voids, item refunds, not-paid amounts, messages, payments (cash or programmed payment types), lottery code, customer tax code, optional total check.
- **RT simplified invoice**, with customer data printed at payment time as in Java.
- **RT refund and void** linked to a previous document (`7101R` / `7101A`), checked with the printer beforehand.
- **Closures and reports**: Z-report that waits for transmission to the Italian Revenue Agency (*Agenzia delle Entrate*), X-report, periodic reports by date or by Z number, electronic journal (DGFE) printing.
- **Non-fiscal documents** with text styles, alignment, barcodes (including QR, with or without human-readable text) and stored logos; logo upload and deletion.
- **Cash drawer** (open and status) and two-line **customer display**.
- **Diagnostics**: model detection, sensors (paper, cover, journal), fiscal and document state, full RT logical state, document transmission outcome, daily counters, training mode; optional events when cover, paper or journal state changes.
- **Reliability**:
  - commands are serialized, and a transaction prevents other commands from slipping into the middle of a receipt;
  - each response is matched to its command by the packet counter;
  - inputs are validated before sending;
  - errors are typed.

---

## Requirements

- Node.js **22** or later.
- For serial / USB: the optional `serialport` package, versions 10 to 13.

## Installation

The package is published on GitHub Packages. In the consuming project, create an `.npmrc` file containing:

```ini
@lucaoliano:registry=https://npm.pkg.github.com
```

then install:

```bash
npm install @lucaoliano/custom-fiscal-printer
npm install serialport   # only if you use serial or USB
```

(GitHub Packages requires authentication even for public packages: you need a token with the `read:packages` scope.)

Or build from source:

```bash
git clone https://github.com/lucaoliano/custom-fiscal-printer.git
cd custom-fiscal-printer
npm install
npm run build
```

---

## Quick start

```typescript
import { CustomFiscalPrinter, CustomFiscalError } from '@lucaoliano/custom-fiscal-printer';

const printer = new CustomFiscalPrinter({ type: 'tcp', host: '192.168.1.50', port: 9100 });

await printer.connect();
try {
  await printer.transaction(async (tx) => {
    await tx.beginFiscalReceipt({ lotteryCode: 'ABCD1234' });

    await tx.printRecItem({ description: 'Caffè', priceInCents: 120, vatRate: 1 });
    await tx.printRecItem({
      description: 'Mele Golden',
      quantity: 1.5,           // 1.5 kg
      unitName: 'Kg',
      unitPriceInCents: 200,   // €2.00/kg (required when quantity ≠ 1)
      priceInCents: 300,
      vatRate: 2
    });

    await tx.printRecItemAdjustment({ type: 'DISCOUNT', description: 'Sconto cassa', amountInCents: 20 });
    await tx.printRecTotal({ amountInCents: 400, description: 'Contanti' });
    await tx.endFiscalReceipt({ trailerLines: ['Grazie e arrivederci'] });
  });
} catch (err) {
  if (err instanceof CustomFiscalError) {
    console.error(`[${err.kind}] ${err.message} (code ${err.code})`);
  }
  throw err;
} finally {
  await printer.disconnect();
}
```

Amounts are always integer **cents**. `vatRate` is the **index** of a VAT rate programmed in the printer (1–9), not the percentage.

As in the Java driver, each item is sold **either by VAT rate or by department**: `vatRate` sends the rate, while `department` (1–29) sends the department, which applies the rate programmed for it. Passing both throws a `RangeError`.

`connect()` runs the same sequence as opening the device in the Java driver:
- disables buffer mode (`30160`);
- reads the model and RT state (`identify()`, commands `1013`, `1014`, `1511`);
- reads the sensors (`1109`);
- starts periodic status polling.

Some behaviour depends on the model and RT state:
- description length;
- the closing command (`3011`, or `30112` with the payment summary);
- sending `71020`/`71021` when opening a receipt, only when the RT is in service.

Every `beginFiscalReceipt` also checks the fiscal day and document state on the printer (`1010`, `1011`), and returns `{ documentOpen }`.

---

## Connection

```typescript
// TCP
new CustomFiscalPrinter({ type: 'tcp', host: '192.168.1.50', port: 9100, timeout: 8000 });

// Serial / USB Virtual COM
new CustomFiscalPrinter({
  type: 'serial',
  path: process.platform === 'win32' ? 'COM3' : '/dev/ttyACM0',
  baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1
});

// Custom transport: any object implementing ITransport
new CustomFiscalPrinter(myTransport);
```

**Reconnection.** With `reconnect: true` (or `{ baseDelayMs, maxDelayMs, attempts }`) on a TCP or serial connection, the channel is reopened with exponential backoff when it dropped or after a read timeout. It reconnects only **before** sending a command, never in the middle of an exchange and never replaying a command already sent. After a reconnection the in-memory document state is reset and the printer emits `'reconnected'`: read the real state again (`getFiscalState()`) and, if a receipt was open, call `resetPrinter()`. The same behaviour is available for any transport with `new ReconnectingTransport(inner, options, onReconnect)`.

**Linux, USB:** Custom printers show up as `/dev/ttyACM*`. To use them without root, add the user to the `dialout` group or install a udev rule. For example, for a Kube II:

```
KERNEL=="ttyACM*", ATTRS{idVendor}=="0DD4", ATTRS{idProduct}=="2019", MODE="0666", SYMLINK+="KUBE_II"
```

## Client options

The constructor's second argument controls the driver's behaviour:

```typescript
new CustomFiscalPrinter(connection, {
  errorPolicy: 'java',      // 'java' (default) | 'strict'
  checksumPolicy: 'warn',   // 'warn' (default) | 'strict' | 'off'
  logger: console           // optional: { debug?, warn? }
});
```

| Option | Default | Description |
|---|---|---|
| `errorPolicy` | `'java'` | `'java'` mirrors the official driver, which does not propagate some errors on commands that do not move money (see [Error handling](#error-handling)). With `'strict'` every error throws. |
| `checksumPolicy` | `'warn'` | The official driver does not verify response checksums. With `'warn'` a mismatch is only logged; with `'strict'` it throws `CustomProtocolError`. |
| `logger` | — | `debug` receives TX/RX traffic in hex, useful for support; `warn` receives discarded responses, ignored errors, invalid checksums and documents that were not emitted. |
| `documentStateChecks` | `true` | Enforces the operation sequence like the Java driver: for example, you cannot sell without opening a receipt or close it before payment. `false` disables the checks. |
| `identifyOnConnect` | `true` | Detects the model during `connect()`, as Java does. With `false`, detection happens on the first fiscal operation. |
| `autoIdentify` | `true` | With `false` the model is never detected: defaults are used and the closing command is always `3011`. |
| `statusPolling` | `true` | Polls the sensors every 2 s, like the Java driver's status thread; pass `{ intervalMs }` to change the interval, or `false` to disable it (see [Status events](#status-events)). |
| `checkTotal` | `true` | As in Java, which enables it on open: if `printRecTotal` receives `expectedTotalInCents`, the client compares it with the printer's total (`1003`) before payment. On mismatch it cancels the receipt and throws. |
| `deleteEmptyHeaderLines` | `false` | Like the Java property of the same name: `setHeaderLine` also sends `6301`. |
| `headerLineDelayMs` | `1200` | Pause after `setHeaderLine` on non-RX models, as in Java. |
| `pendingOperationDelayMs` | `2000` | Pause before waiting on `1513` after the Z-report and training mode changes. |

Per-command timeouts are those of the Java driver (for example 30 s for closing and cutting, 90 s for refund and void, 180 s for the Z-report, 1800 s for DGFE printing).

---

## Concurrency

A fiscal printer executes one command at a time. The client guarantees that:

- **each command** is sent only after the previous one has been answered, even with concurrent calls on the same instance;
- **multi-command methods** (`beginFiscalReceipt`, `printRecItem`, `printRefundReceipt`, `printZReport`, …) are not interleaved with other calls;
- **`transaction(fn)`** reserves the printer for the whole of `fn`, so a periodic status poll cannot slip into the middle of a receipt. Nested calls do not deadlock, and the lock is released even if `fn` throws.

Use **a single instance** of `CustomFiscalPrinter` per physical printer.

## Status events

Like the Java driver, the client reads the sensors (`1109`) at regular intervals and emits `statusUpdate` only when something changes, using the JavaPOS event codes. Polls are skipped while a command or transaction is in progress, and suspended during Z-reports, X-reports and periodic reports. `statusPolling: false` disables polling.

```typescript
const printer = new CustomFiscalPrinter(connection);
printer.on('statusUpdate', (e) => {
  // e.code: 11 COVER_OPEN, 12 COVER_OK, 24 REC_EMPTY, 25 REC_NEAREMPTY, 26 REC_PAPEROK,
  //         21 JRN_EMPTY, 22 JRN_NEAREMPTY, 23 JRN_PAPEROK
  console.log(e.name);
});
await printer.connect(); // emits the initial state immediately
```

The timer does not keep the process alive and stops on `disconnect()`.

## Timeouts and late responses

Each packet carries a counter (01–99). If a response arrives after the timeout, it is discarded because its counter does not match the next command, and it is never attributed to the wrong command.

> [!IMPORTANT]
> A `CustomTimeoutError` does **not** mean the command was not executed: the printer may have emitted the document. The driver never retries commands automatically. Before repeating a fiscal operation, check the document state, for example with `getTicketData()`.

> Errors from a command exchange (`CustomTimeoutError`, `CustomConnectionError`, `CustomProtocolError`) carry a `sent` field: `true` when the command frame was fully handed to the transport (outcome **unknown**), `false` when the command never left and can be repeated safely.

---

## Error handling

| Class | When |
|---|---|
| `CustomFiscalError` | The printer replies with an error code. |
| `CustomTimeoutError` | No response within the timeout. |
| `CustomConnectionError` | Channel error: socket closed, serial port unplugged, write failed. |
| `CustomOperationNotAllowedError` | The operation is not allowed in the current state, with the same JPOS codes as the Java driver (`jposCode`, `extendedJposCode`): wrong sequence, fiscal day open, cover open or paper out before `setDate`/`setHeaderLine`, refund or void rejected by the printer. |
| `CustomProtocolError` | Invalid frame, non-transmittable character, receive buffer over the limit, bad checksum with `checksumPolicy: 'strict'`. |
| `RangeError` | Invalid input: non-integer or out-of-range amounts, VAT rate, department, lottery code and so on. Thrown **before** any command is sent. |

`CustomFiscalError` exposes:

- `code`: Custom error code (e.g. `16`);
- `kind`: category (`'PAPER_EMPTY'`, `'COVER_OPEN'`, `'BUSY'`, `'WRONG_STATE'`, `'FISCAL_MEMORY_FULL'`, …), derived from the official driver's mapping;
- `retryable`: `true` only for `BUSY`;
- `extendedCode`: extended code, read automatically with command `1015` when the printer replies `ERR99`;
- `command`, `rawError`.

```typescript
try {
  await printer.printRecTotal({ amountInCents: 400 });
} catch (err) {
  if (err instanceof CustomFiscalError && err.kind === 'PAPER_EMPTY') {
    // ask the operator to replace the paper roll
  }
}
```

**Ignored errors (`errorPolicy: 'java'`).** Like the official driver:

- error `5` is ignored on every command except sales (`3301x`), payments (`3004`, `3007`) and not-paid (`3005`);
- error `3` is ignored except on sales, refund/void (`7102A`, `7102R`) and invoice (`71023`);
- errors `5`, `56`, `57` and `85` are ignored on `30160`/`30161`.

The ignored error remains visible in `ParsedFrame.ignoredErrorCode` and is reported through `logger.warn`.

---

## Examples

### Printer status

```typescript
const s = await printer.getPrinterStatus();         // coverOpen, paperEmpty, paperNearEnd, …
const rt = await printer.getRTStatus();             // isRT, inService, trainingMode, serial numbers, activation, …
const ade = await printer.getRTConnectionStatus();  // outcome of the last transmission to the Revenue Agency
const caps = await printer.identify();              // model, description length, RT in service
const fiscal = await printer.getFiscalState();      // day open, non-fiscal document open, training mode
const totals = await printer.readTicketTotals();    // running total of the open receipt
const outcome = await printer.getDocumentStatus(12, 42); // document accepted/rejected/pending
```

### Daily closure

```typescript
// Z-report: closes the fiscal day, transmits the totals and waits for the
// transmission to finish (command 1513) before returning.
await printer.printZReport();
```

### Refund and void

As in the Java driver, a **refund** document is a receipt: once opened it stays open, you register the refunded items and then close it. Payment sends no command to the printer: it only updates the document state, and the document is closed by `endFiscalReceipt`.

```typescript
const docRef = { zReport: 12, ticketNumber: 42, date: '150526' }; // original document, date DDMMYY

await printer.transaction(async (tx) => {
  const r = await tx.beginFiscalReceipt({
    rtDocument: { type: 'refund', docRef, deviceSerial: '99MEY012345' }
  });
  if (!r.documentOpen) return;
  await tx.printRecItem({ description: 'Caffè', priceInCents: 120, vatRate: 1 });
  await tx.printRecTotal({ amountInCents: 120 });
  await tx.endFiscalReceipt();
});
```

A **void** is opened the same way with `type: 'void'`. If the printer completes the document by itself, `documentOpen` is `false`; otherwise close it with `endFiscalReceipt`.

`printRefundReceipt()` and `printVoidReceipt()` are shortcuts for these openings. They return `{ emitted, documentOpen, reason? }`.

- Before executing, the client asks the printer whether the operation is possible (`7101R`/`7101A`); if the printer refuses, `CustomOperationNotAllowedError` is thrown.
- Linked refund and void (`7101R`/`7101A`) require the RT to be in service. Without an RT in service, `refund: true` opens a refund document with `7102600000`, as in Java.
- Alternatively, use the JavaPOS codes: `directIO(-95010, [receipt, z], [serial, 'YYYYMMDD'])` for a refund, `-95011` for a void, followed by `beginFiscalReceipt()`.

### Simplified invoice

```typescript
await printer.transaction(async (tx) => {
  await tx.beginFiscalReceipt({
    invoice: {
      number: 0,                       // 0 = printer's automatic numbering
      taxId: '01234567890',            // customer VAT number or tax code
      customerLines: ['Rossi S.r.l.', 'Via Roma 1', '00100 Roma']
    }
  });
  await tx.printRecItem({ description: 'Consulenza', priceInCents: 10000, vatRate: 1 });
  await tx.printRecTotal({ amountInCents: 10000, description: 'Bonifico' }); // customer data is printed here
  await tx.endFiscalReceipt();
});
```

### Other receipt operations

These are used with an open receipt, between `beginFiscalReceipt` and `endFiscalReceipt`. The exception is `resetPrinter`, whose purpose is to cancel a document left open.

```typescript
await printer.printRecItemVoid({ description: 'Caffè', priceInCents: 120 });  // void an item
await printer.printRecRefund({ description: 'Reso', amountInCents: 120 });     // item refund
await printer.printRecSubtotalAdjustment('DISCOUNT', 'Sconto 10%', 40);        // subtotal discount
await printer.printRecMessage('Punti fedeltà: 120');                           // message line
await printer.printRecNotPaid('Non riscosso', 500);                            // not-paid amount
await printer.resetPrinter();                                                  // cancel the open document, as in Java
```

### Non-fiscal document

```typescript
import { Esc } from '@lucaoliano/custom-fiscal-printer';

await printer.transaction(async (tx) => {
  await tx.beginNonFiscal({ printHeader: true });
  await tx.printNormal(Esc.alignCenter(Esc.bold('REPORT DI TURNO')));
  await tx.printNormal(Esc.doubleWidth('PUNTI: 500'));
  await tx.printNormal(Esc.barcode('EAN13', '8012345678901'));
  await tx.printNormal(Esc.feed(2));
  await tx.endNonFiscal();
});
```

### Cash drawer and display

```typescript
await printer.openDrawer();                        // as in Java: never throws, errors are logged
const isOpen = await printer.getDrawerOpened();    // state read with 7108

await printer.displayTextAt(0, 0, 'TOTALE      4,00 EUR');
await printer.displayText(' EUR');                 // continues from the cursor position
await printer.clearDisplay();                      // clears the display and homes the cursor
```

The display works as in Java. It is a 2-line × 20-character area with a cursor: `displayText` writes from the cursor position over the existing content and scrolls the lines if the text does not fit. As in Java, `clearText()` only homes the cursor without erasing the text; use `clearDisplay()` to clear the display.

While a receipt is open, `printNormal` prints fiscal message lines (`3002`), like the Java driver; outside a document it throws.

### Commands not covered by the API

```typescript
const reply = await printer.directIO('1008'); // send a raw Custom command
```

---

## Text and characters

The printer accepts Latin-1 characters. The `€` sign is converted automatically, and the most common typographic characters are transliterated (`’ “ ” – …` and special spaces). Any other character outside Latin-1, or any control character, throws instead of being sent. In particular, a `0x02`/`0x03` byte inside a description would truncate the packet.

---

## Development

```bash
npm install
npm run build   # compiles to dist/
npm test        # unit and integration tests (no printer needed)
```

The tests use `MockTransport` and a local TCP server that simulates the printer.

## License

[MIT](LICENSE). The official JavaPOS driver and Custom's native libraries are not included in this repository and remain subject to the manufacturer's licence.
