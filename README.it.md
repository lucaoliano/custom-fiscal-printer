# custom-fiscal-printer

[English](README.md) · **Italiano**

Driver **Node.js / TypeScript** per le stampanti fiscali e i Registratori Telematici (RT) **Custom**: Kube II F, Q3X F, Big Plus, Fusion e modelli compatibili.

Il modulo implementa direttamente il protocollo Custom a pacchetti (STX/ETX) su TCP o seriale, senza JDK, JavaPOS né librerie native. Il protocollo è stato ricostruito analizzando il driver JavaPOS `CUSTOMJPOSF` 3.00.02, di cui il modulo replica la logica di scambio dati e di gestione degli errori.

> [!WARNING]
> **Progetto non ufficiale, in fase di collaudo.** Non è affiliato né approvato da Custom S.p.A. I nomi dei prodotti sono marchi dei rispettivi proprietari. Il comportamento è verificato con test automatici e confrontato con il bytecode del driver ufficiale, ma **non ancora su una stampante reale**: prima di usarlo in produzione, collaudalo sul tuo modello e sul tuo firmware. Il software è fornito senza garanzie (vedi [LICENSE](LICENSE)).

---

## Caratteristiche

- **Trasporti**: TCP (Ethernet / Wi-Fi, porta 9100), seriale RS-232 / USB Virtual COM tramite [`serialport`](https://serialport.io), e un trasporto *mock* per sviluppo e test senza hardware.
- **Parità funzionale con il driver JavaPOS**: formati dei comandi, timeout, sequenze e gestione degli errori sono allineati al bytecode di `CUSTOMJPOSF` 3.00.02, metodo per metodo.
- **Documento commerciale RT**: vendita a pezzo e a peso, sconti e maggiorazioni su articolo e su subtotale, storni, resi su articolo, non pagato, messaggi, pagamenti (contanti o forme di pagamento programmate), codice lotteria, codice fiscale del cliente, verifica facoltativa del totale.
- **Fattura semplificata RT**, con i dati del cliente stampati al pagamento come in Java.
- **Reso e annullo RT** collegati a un documento precedente (`7101R` / `7101A`), con verifica preventiva della stampante.
- **Chiusure e report**: Z-report con attesa della trasmissione all'Agenzia delle Entrate, X-report, report periodici per data o per numero di azzeramento, stampa del DGFE.
- **Documenti non fiscali** con stili di testo, allineamento, barcode (anche QR, con o senza testo leggibile) e loghi residenti; caricamento e cancellazione dei loghi.
- **Cassetto** (apertura e stato) e **display cliente** a due righe.
- **Diagnostica**: riconoscimento del modello, sensori (carta, coperchio, giornale), stato fiscale e del documento, stato logico RT completo, esito della trasmissione dei documenti, contatori giornalieri, modalità addestramento; eventi facoltativi quando cambiano coperchio, carta o giornale.
- **Affidabilità**:
  - i comandi sono serializzati, e una transazione impedisce che altri comandi si inseriscano a metà di uno scontrino;
  - ogni risposta viene associata al comando tramite il contatore di pacchetto;
  - gli input vengono validati prima dell'invio;
  - gli errori sono tipizzati.

---

## Requisiti

- Node.js **22** o superiore.
- Per la seriale / USB: il pacchetto opzionale `serialport`, versioni dalla 10 alla 13.

## Installazione

Il pacchetto è pubblicato su GitHub Packages. Nel progetto che lo usa, crea un file `.npmrc` con:

```ini
@lucaoliano:registry=https://npm.pkg.github.com
```

poi installa:

```bash
npm install @lucaoliano/custom-fiscal-printer
npm install serialport   # solo se usi la seriale o la USB
```

(GitHub Packages richiede l'autenticazione anche per i pacchetti pubblici: serve un token con permesso `read:packages`.)

In alternativa, dal sorgente:

```bash
git clone https://github.com/lucaoliano/custom-fiscal-printer.git
cd custom-fiscal-printer
npm install
npm run build
```

---

## Avvio rapido

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
      quantity: 1.5,           // 1,5 kg
      unitName: 'Kg',
      unitPriceInCents: 200,   // 2,00 €/kg (obbligatorio se quantity ≠ 1)
      priceInCents: 300,
      vatRate: 2
    });

    await tx.printRecItemAdjustment({ type: 'DISCOUNT', description: 'Sconto cassa', amountInCents: 20 });
    await tx.printRecTotal({ amountInCents: 400, description: 'Contanti' });
    await tx.endFiscalReceipt({ trailerLines: ['Grazie e arrivederci'] });
  });
} catch (err) {
  if (err instanceof CustomFiscalError) {
    console.error(`[${err.kind}] ${err.message} (codice ${err.code})`);
  }
  throw err;
} finally {
  await printer.disconnect();
}
```

Gli importi sono sempre in **centesimi** e interi. `vatRate` è l'**indice** dell'aliquota programmata nella stampante (1–9), non la percentuale.

Ogni articolo si vende **per aliquota oppure per reparto**, come nel driver Java: `vatRate` invia l'aliquota, mentre `department` (1–29) invia il reparto, che applica l'aliquota programmata per quel reparto. Indicare entrambi genera un `RangeError`.

`connect()` esegue la stessa sequenza dell'apertura del dispositivo nel driver Java:
- disattiva la modalità buffer (`30160`);
- legge il modello e lo stato RT (`identify()`, comandi `1013`, `1014`, `1511`);
- legge i sensori (`1109`);
- avvia il controllo periodico dello stato.

Dal modello e dallo stato RT dipendono alcune scelte:
- la lunghezza delle descrizioni;
- il comando di chiusura (`3011` oppure `30112` con il riepilogo dei pagamenti);
- l'invio di `71020`/`71021` in apertura scontrino, solo con RT in servizio.

Ogni `beginFiscalReceipt` controlla anche la giornata fiscale e lo stato del documento sulla stampante (`1010`, `1011`), e restituisce `{ documentOpen }`.

---

## Connessione

```typescript
// TCP
new CustomFiscalPrinter({ type: 'tcp', host: '192.168.1.50', port: 9100, timeout: 8000 });

// Seriale / USB Virtual COM
new CustomFiscalPrinter({
  type: 'serial',
  path: process.platform === 'win32' ? 'COM3' : '/dev/ttyACM0',
  baudRate: 19200, dataBits: 8, parity: 'none', stopBits: 1
});

// Trasporto personalizzato: qualsiasi oggetto che implementa ITransport
new CustomFiscalPrinter(myTransport);
```

**Riconnessione.** Con `reconnect: true` (o `{ baseDelayMs, maxDelayMs, attempts }`) su una connessione TCP o seriale, il canale viene riaperto con backoff esponenziale se è caduto o dopo un timeout di lettura. Si riconnette solo **prima** di inviare un comando, mai nel mezzo di uno scambio e mai rigiocando un comando già inviato. Dopo una riconnessione lo stato del documento in memoria viene azzerato e la stampante emette `'reconnected'`: rileggi lo stato reale (`getFiscalState()`) e, se uno scontrino era aperto, chiama `resetPrinter()`. Lo stesso comportamento è disponibile per qualunque trasporto con `new ReconnectingTransport(inner, options, onReconnect)`.

**Linux, USB:** le stampanti Custom compaiono come `/dev/ttyACM*`. Per usarle senza privilegi di root, aggiungi l'utente al gruppo `dialout` oppure installa una regola udev. Per esempio, per una Kube II:

```
KERNEL=="ttyACM*", ATTRS{idVendor}=="0DD4", ATTRS{idProduct}=="2019", MODE="0666", SYMLINK+="KUBE_II"
```

## Opzioni del client

Il secondo parametro del costruttore regola il comportamento del driver:

```typescript
new CustomFiscalPrinter(connection, {
  errorPolicy: 'java',      // 'java' (default) | 'strict'
  checksumPolicy: 'warn',   // 'warn' (default) | 'strict' | 'off'
  logger: console           // facoltativo: { debug?, warn? }
});
```

| Opzione | Default | Descrizione |
|---|---|---|
| `errorPolicy` | `'java'` | Con `'java'` replica il driver ufficiale, che non propaga alcuni errori su comandi che non movimentano importi (vedi [Gestione degli errori](#gestione-degli-errori)). Con `'strict'` ogni errore genera un'eccezione. |
| `checksumPolicy` | `'warn'` | Il driver ufficiale non verifica il checksum delle risposte. Con `'warn'` una discrepanza viene solo registrata nel log; con `'strict'` genera `CustomProtocolError`. |
| `logger` | — | `debug` riceve il traffico TX/RX in esadecimale, utile per l'assistenza; `warn` riceve risposte scartate, errori ignorati, checksum non validi e documenti non emessi. |
| `documentStateChecks` | `true` | Controlla la sequenza delle operazioni come il driver Java: per esempio non si può vendere senza aver aperto lo scontrino, né chiuderlo prima del pagamento. Con `false` i controlli sono disattivati. |
| `identifyOnConnect` | `true` | Riconosce il modello già in `connect()`, come Java. Con `false` il riconoscimento avviene alla prima operazione fiscale. |
| `autoIdentify` | `true` | Con `false` il modello non viene mai riconosciuto: si usano i valori predefiniti e la chiusura è sempre `3011`. |
| `statusPolling` | `true` | Controllo periodico dei sensori ogni 2 s, come il thread di stato del driver Java; si può passare `{ intervalMs }` per cambiare l'intervallo, oppure `false` per disattivarlo (vedi [Eventi di stato](#eventi-di-stato)). |
| `checkTotal` | `true` | Come in Java, che lo attiva all'apertura: se `printRecTotal` riceve `expectedTotalInCents`, il client confronta il totale della stampante (`1003`) prima del pagamento. In caso di differenza annulla lo scontrino e lancia un errore. |
| `deleteEmptyHeaderLines` | `false` | Come la proprietà Java omonima: `setHeaderLine` invia anche `6301`. |
| `headerLineDelayMs` | `1200` | Pausa dopo `setHeaderLine` sui modelli non RX, come in Java. |
| `pendingOperationDelayMs` | `2000` | Pausa prima dell'attesa `1513` dopo Z-report e addestramento. |

I timeout di ogni comando sono quelli del driver Java (per esempio 30 s per chiusura e taglio, 90 s per reso e annullo, 180 s per lo Z-report, 1800 s per la stampa del DGFE).

---

## Concorrenza

Una stampante fiscale esegue un comando alla volta. Il client garantisce che:

- **ogni comando** venga inviato solo dopo la risposta al precedente, anche con chiamate concorrenti sulla stessa istanza;
- **i metodi composti da più comandi** (`beginFiscalReceipt`, `printRecItem`, `printRefundReceipt`, `printZReport`, …) non vengano interrotti da altre chiamate;
- **`transaction(fn)`** riservi la stampante per tutta la durata di `fn`, così un controllo periodico dello stato non si inserisce a metà di uno scontrino. Le chiamate annidate non si bloccano a vicenda, e il lock viene rilasciato anche se `fn` lancia un errore.

Usa **una sola istanza** di `CustomFiscalPrinter` per ogni stampante fisica.

## Eventi di stato

Come il driver Java, il client legge i sensori (`1109`) a intervalli regolari ed emette `statusUpdate` solo quando qualcosa cambia, con gli stessi codici degli eventi JavaPOS. Le letture vengono saltate mentre è in corso un comando o una transazione, e sono sospese durante Z-report, X-report e report periodici. Con `statusPolling: false` il controllo è disattivato.

```typescript
const printer = new CustomFiscalPrinter(connection);
printer.on('statusUpdate', (e) => {
  // e.code: 11 COVER_OPEN, 12 COVER_OK, 24 REC_EMPTY, 25 REC_NEAREMPTY, 26 REC_PAPEROK,
  //         21 JRN_EMPTY, 22 JRN_NEAREMPTY, 23 JRN_PAPEROK
  console.log(e.name);
});
await printer.connect(); // emette subito lo stato iniziale
```

Il timer non tiene in vita il processo e si ferma con `disconnect()`.

## Timeout e risposte in ritardo

Ogni pacchetto porta un contatore (01–99). Se una risposta arriva dopo il timeout, viene scartata perché il suo contatore non corrisponde al comando successivo, e non viene mai attribuita al comando sbagliato.

> [!IMPORTANT]
> Un `CustomTimeoutError` **non** significa che il comando non sia stato eseguito: la stampante potrebbe aver emesso il documento. Il driver non ripete mai i comandi in automatico. Prima di ripetere un'operazione fiscale, verifica lo stato del documento, per esempio con `getTicketData()`.

> Gli errori di uno scambio (`CustomTimeoutError`, `CustomConnectionError`, `CustomProtocolError`) hanno il campo `sent`: `true` se il frame del comando è stato consegnato per intero al trasporto (esito **ignoto**), `false` se il comando non è mai partito e si può ripetere senza rischi.

---

## Gestione degli errori

| Classe | Quando |
|---|---|
| `CustomFiscalError` | La stampante risponde con un codice di errore. |
| `CustomTimeoutError` | Nessuna risposta entro il timeout. |
| `CustomConnectionError` | Errore del canale: socket chiuso, porta seriale scollegata, scrittura fallita. |
| `CustomOperationNotAllowedError` | Operazione non consentita nello stato attuale, con gli stessi codici JPOS del driver Java (`jposCode`, `extendedJposCode`): sequenza errata, giornata fiscale aperta, coperchio aperto o carta esaurita prima di `setDate`/`setHeaderLine`, reso o annullo rifiutati dalla stampante. |
| `CustomProtocolError` | Frame non valido, carattere non trasmissibile, buffer di ricezione oltre il limite, checksum errato con `checksumPolicy: 'strict'`. |
| `RangeError` | Input non valido: importi non interi o fuori intervallo, aliquota, reparto, codice lotteria e così via. Viene sollevato **prima** di inviare qualunque comando. |

`CustomFiscalError` espone:

- `code`: codice Custom (es. `16`);
- `kind`: categoria (`'PAPER_EMPTY'`, `'COVER_OPEN'`, `'BUSY'`, `'WRONG_STATE'`, `'FISCAL_MEMORY_FULL'`, …), ricavata dalla mappatura del driver ufficiale;
- `retryable`: `true` solo per `BUSY`;
- `extendedCode`: codice esteso letto automaticamente con il comando `1015` quando la stampante risponde `ERR99`;
- `command`, `rawError`.

```typescript
try {
  await printer.printRecTotal({ amountInCents: 400 });
} catch (err) {
  if (err instanceof CustomFiscalError && err.kind === 'PAPER_EMPTY') {
    // chiedi all'operatore di sostituire il rotolo
  }
}
```

**Errori ignorati (`errorPolicy: 'java'`).** Come il driver ufficiale:

- l'errore `5` viene ignorato su tutti i comandi tranne vendite (`3301x`), pagamenti (`3004`, `3007`) e non pagato (`3005`);
- l'errore `3` viene ignorato tranne su vendite, reso/annullo (`7102A`, `7102R`) e fattura (`71023`);
- gli errori `5`, `56`, `57` e `85` vengono ignorati su `30160`/`30161`.

L'errore ignorato resta visibile in `ParsedFrame.ignoredErrorCode` e viene segnalato con `logger.warn`.

---

## Esempi

### Stato della stampante

```typescript
const s = await printer.getPrinterStatus();       // coverOpen, paperEmpty, paperNearEnd, …
const rt = await printer.getRTStatus();           // isRT, inService, trainingMode, matricole, attivazione, …
const ade = await printer.getRTConnectionStatus(); // esito dell'ultimo invio all'Agenzia delle Entrate
const caps = await printer.identify();            // modello, lunghezza descrizioni, RT in servizio
const fiscale = await printer.getFiscalState();   // giornata aperta, documento non fiscale aperto, addestramento
const totali = await printer.readTicketTotals();  // totale corrente dello scontrino aperto
const esito = await printer.getDocumentStatus(12, 42); // documento accettato/rifiutato/in attesa
```

### Chiusura giornaliera

```typescript
// Z-report: chiude la giornata fiscale, trasmette i corrispettivi e attende
// la fine della trasmissione (comando 1513) prima di restituire il controllo.
await printer.printZReport();
```

### Reso e annullo

Come nel driver Java, il documento di **reso** è uno scontrino: dopo l'apertura resta aperto, si registrano gli articoli resi e lo si chiude. Il pagamento non invia comandi alla stampante: aggiorna solo lo stato del documento, e la chiusura avviene con `endFiscalReceipt`.

```typescript
const docRef = { zReport: 12, ticketNumber: 42, date: '150526' }; // documento originale, data GGMMAA

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

L'**annullo** si apre allo stesso modo con `type: 'void'`. Se la stampante completa da sola il documento, `documentOpen` è `false`; altrimenti va chiuso con `endFiscalReceipt`.

`printRefundReceipt()` e `printVoidReceipt()` sono scorciatoie per queste aperture. Restituiscono `{ emitted, documentOpen, reason? }`.

- Prima di eseguire, il client chiede alla stampante se l'operazione è possibile (`7101R`/`7101A`); se la stampante la rifiuta viene lanciato `CustomOperationNotAllowedError`.
- Reso e annullo collegati (`7101R`/`7101A`) richiedono l'RT in servizio. Senza RT in servizio, `refund: true` apre un documento di reso con `7102600000`, come in Java.
- In alternativa si possono usare i codici JavaPOS: `directIO(-95010, [scontrino, z], [matricola, 'AAAAMMGG'])` per il reso, `-95011` per l'annullo, seguiti da `beginFiscalReceipt()`.

### Fattura semplificata

```typescript
await printer.transaction(async (tx) => {
  await tx.beginFiscalReceipt({
    invoice: {
      number: 0,                       // 0 = numerazione automatica della stampante
      taxId: '01234567890',            // P.IVA o codice fiscale del cliente
      customerLines: ['Rossi S.r.l.', 'Via Roma 1', '00100 Roma']
    }
  });
  await tx.printRecItem({ description: 'Consulenza', priceInCents: 10000, vatRate: 1 });
  await tx.printRecTotal({ amountInCents: 10000, description: 'Bonifico' }); // qui vengono stampati i dati del cliente
  await tx.endFiscalReceipt();
});
```

### Altre operazioni sullo scontrino

Si usano con uno scontrino aperto, tra `beginFiscalReceipt` ed `endFiscalReceipt`. Fa eccezione `resetPrinter`, che serve proprio ad annullare un documento rimasto aperto.

```typescript
await printer.printRecItemVoid({ description: 'Caffè', priceInCents: 120 });  // storno di un articolo
await printer.printRecRefund({ description: 'Reso', amountInCents: 120 });     // reso su articolo
await printer.printRecSubtotalAdjustment('DISCOUNT', 'Sconto 10%', 40);        // sconto sul subtotale
await printer.printRecMessage('Punti fedeltà: 120');                           // riga di messaggio
await printer.printRecNotPaid('Non riscosso', 500);                            // importo non pagato
await printer.resetPrinter();                                                  // annulla il documento aperto, come Java
```

### Documento non fiscale

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

### Cassetto e display

```typescript
await printer.openDrawer();                        // come Java: non lancia errori, li registra nel log
const aperto = await printer.getDrawerOpened();    // stato letto con 7108

await printer.displayTextAt(0, 0, 'TOTALE      4,00 EUR');
await printer.displayText(' EUR');                 // prosegue dalla posizione del cursore
await printer.clearDisplay();                      // svuota il display e riporta il cursore all'inizio
```

Il display funziona come in Java. È un'area di 2 righe × 20 caratteri con un cursore: `displayText` scrive dalla posizione del cursore sopra il contenuto esistente e fa scorrere le righe se il testo non entra. Come in Java, `clearText()` riporta solo il cursore all'inizio senza cancellare il testo; per svuotare il display usa `clearDisplay()`.

Durante uno scontrino aperto, `printNormal` stampa righe di messaggio fiscale (`3002`), come il driver Java; fuori da un documento genera un errore.

### Comandi non coperti dall'API

```typescript
const risposta = await printer.directIO('1008'); // invia un comando Custom grezzo
```

---

## Testo e caratteri

La stampante accetta caratteri Latin-1. Il simbolo `€` viene convertito automaticamente, e i caratteri tipografici più comuni vengono traslitterati (`’ “ ” – … ` e gli spazi speciali). Qualsiasi altro carattere fuori da Latin-1, o carattere di controllo, genera un errore invece di essere inviato. In particolare, un byte `0x02`/`0x03` dentro una descrizione troncherebbe il pacchetto.

---

## Emulatore

`@lucaoliano/custom-fiscal-printer/emulator` è un emulatore con stato di un registratore telematico Custom, per sviluppare e provare senza hardware. **Non** fa parte dell'entry point principale, quindi non finisce per sbaglio nel bundle di un'applicazione.

> **Cos'è e cosa non è.** Riproduce la lettura del protocollo fatta da questa libreria (comandi, layout dei payload, offset delle risposte), non il comportamento di una Q3X-F vera. Dove la libreria non basta a dire cosa risponderebbe il dispositivo, l'emulatore fa un'ipotesi esplicita (segnata «Ipotesi» nel sorgente). Che i test passino sull'emulatore prova che client ed emulatore concordano, non che lo faccia una stampante vera. La semantica del contatore scontrini (`1004`) e del numero Z (`1104`), gli indici delle forme di pagamento, l'IVA allo 0 % e le risposte a reso e annullo non sono ancora verificati su hardware.

Cosa modella: stato del documento (vendita, pagamento parziale, pagato, emesso ma non tagliato, non fiscale), totali calcolati dalle righe `33011` (quindi il controllo del totale con `1003` è vero), pagamenti con resto solo sul contante, contatore giornaliero degli scontrini, numerazione Z, letture X e Z, documenti di reso e annullo che citano un documento emesso, stato di carta e coperchio. È rigoroso: un comando sconosciuto riceve un errore (ERR09) ed è registrato in `unknownCommands`, mai un'accettazione silenziosa. Dopo un flusso verifica che la lista sia vuota.

```typescript
import { CustomFiscalPrinter } from '@lucaoliano/custom-fiscal-printer';
import { EmulatedPrinter, EmulatorTransport, startEmulatorServer } from '@lucaoliano/custom-fiscal-printer/emulator';

// In processo, senza socket
const emu = new EmulatedPrinter();
const printer = new CustomFiscalPrinter(new EmulatorTransport(emu), { statusPolling: false });

// Oppure su TCP, come una stampante Ethernet
const server = await startEmulatorServer({}, { port: 9100 }); // 127.0.0.1 per default
```

Oppure da riga di comando (`npx custom-fiscal-emulator --help`):

```bash
custom-fiscal-emulator --port 9100 --verbose --fault 3011:lose-reply
```

**L'iniezione di guasti** è il motivo per usarlo: `emu.inject(prefisso, guasto, volte)`.

| Guasto | Il comando viene eseguito? | Cosa vede il client |
|:---|:---|:---|
| `error` (`code`, `extendedCode`) | no | `CustomFiscalError` |
| `lose-command` | no | connessione chiusa, `sent: true` |
| `lose-reply` | **sì** | connessione chiusa, `sent: true` (esito ignoto) |
| `truncate-reply` | sì | mezzo frame, poi la connessione cade |
| `silence` | sì | `CustomTimeoutError`, `sent: true` |
| `delay` (`ms`) | sì | risposta in ritardo, o timeout se oltre quello del client |

`lose-command` e `lose-reply` per il client sono identici; solo l'emulatore sa se un documento è stato emesso, ed è ciò che permette di provare idempotenza e riconciliazione. `emu.setPaper()`, `emu.setCoverOpen()` e `emu.setRtInService()` cambiano lo stato dell'hardware, `emu.documents` elenca cosa è stato emesso ed `emu.snapshot()` i contatori.

L'emulatore non ha autenticazione e ascolta su `127.0.0.1`: non esporlo.

## Sviluppo

```bash
npm install
npm run build   # compila in dist/
npm test        # test unitari e di integrazione (nessuna stampante necessaria)
```

I test usano `MockTransport` e un server TCP locale che simula la stampante.

## Licenza

[MIT](LICENSE). Il driver JavaPOS ufficiale e le librerie native Custom non sono inclusi in questo repository e restano soggetti alla licenza del produttore.
