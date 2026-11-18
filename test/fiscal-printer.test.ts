import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import { MockTransport } from '../src/transports/mock.transport';
import { CustomFiscalError } from '../src/errors';
import { Esc } from '../src/protocol/esc-sequences';

describe('CustomFiscalPrinter Client Lifecycle Tests', () => {
  let mock: MockTransport;
  let printer: CustomFiscalPrinter;

  beforeEach(() => {
    mock = new MockTransport();
    printer = new CustomFiscalPrinter(mock, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0, headerLineDelayMs: 0, documentStateChecks: false });
  });

  it('Gestisce connessione e disconnessione', async () => {
    assert.strictEqual(printer.isConnected(), false);
    await printer.connect();
    assert.strictEqual(printer.isConnected(), true);
    await printer.disconnect();
    assert.strictEqual(printer.isConnected(), false);
  });

  it('getPrinterStatus legge stato carta e coperchio', async () => {
    await printer.connect();

    // Simula risposta: 4 status bytes + "01000" (coverOpen=0, paperEmpty=1, nearEnd=0...)
    mock.setHandler((cmd) => {
      if (cmd === '1109') {
        return { data: '01000' };
      }
      return { data: '' };
    });

    const status = await printer.getPrinterStatus();
    assert.strictEqual(status.coverOpen, false);
    assert.strictEqual(status.paperEmpty, true);
    assert.strictEqual(status.paperNearEnd, false);
  });

  it('getRTStatus rileva la modalità RT e training mode', async () => {
    await printer.connect();

    mock.setHandler((cmd) => {
      if (cmd === '1511') {
        // Indici come nel driver Java: RTMode in data[25], training in data[33]
        const dummy = '0'.repeat(25) + '1' + '0'.repeat(7) + '1' + '00';
        return { data: dummy };
      }
      return { data: '' };
    });

    const rt = await printer.getRTStatus();
    assert.strictEqual(rt.isRT, true);
    assert.strictEqual(rt.rtMode, 3);
    assert.strictEqual(rt.trainingMode, true);
  });

  it('Emissione completa scontrino fiscale RT', async () => {
    await printer.connect();
    // 71020/71021 solo con RT in servizio (come beginFiscalReceipt di Java)
    mock.setHandler((cmd) => (cmd === '1511' ? { data: '0'.repeat(25) + '1' + '0'.repeat(10) } : { data: '' }));
    await printer.identify();

    // 1. Inizio scontrino
    await printer.beginFiscalReceipt({
      lotteryCode: 'ABCD1234',
      fiscalCode: 'RSSMRA80A01H501U'
    });

    // 2. Vendita articolo
    await printer.printRecItem({
      description: 'Caffè Espresso',
      priceInCents: 120, // 1,20 €
      quantity: 1,
      vatRate: 1, // IVA 22%
      department: 0
    });

    // 3. Totale e pagamento
    await printer.printRecTotal({
      amountInCents: 120,
      description: 'Contanti'
    });

    // 4. Chiusura scontrino
    await printer.endFiscalReceipt({
      trailerLines: ['Arrivederci e grazie']
    });

    // Verifica comandi inviati
    assert.strictEqual(mock.sentCommands.includes('71020'), true); // Reset
    assert.strictEqual(mock.sentCommands.includes('71021'), true); // Enable RT
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('301908ABCD1234')), true); // Lotteria
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('3010B')), true); // Codice fiscale
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('33011')), true); // Riga vendita RT
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('3004')), true); // Pagamento
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('3011')), true); // Fine scontrino
  });

  it('Emissione scontrino con quantità frazionata (pesata)', async () => {
    await printer.connect();

    await printer.beginFiscalReceipt();
    await printer.printRecItem({
      description: 'Mele Golden',
      priceInCents: 300,
      quantity: 1.5,
      unitName: 'Kg',
      unitPriceInCents: 200,
      vatRate: 2
    });
    await printer.printRecTotal({ amountInCents: 300 });
    await printer.endFiscalReceipt();

    // Verifica presenza riga moltiplicatore 3002
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('30021')), true);
    // Verifica comando RT 33011 con qty 1500 (000001500)
    assert.strictEqual(mock.sentCommands.some((c) => c.includes('000001500')), true);
  });

  it('Stampa documento non fiscale (gestionale) con sequenze escape', async () => {
    await printer.connect();

    await printer.beginNonFiscal();
    await printer.printNormal(Esc.alignCenter(Esc.bold('REPORT DI TEST')));
    await printer.printNormal('Riga normale di promemoria');
    await printer.endNonFiscal();

    assert.strictEqual(mock.sentCommands.includes('40011'), true);
    assert.strictEqual(mock.sentCommands.includes('4002'), true);
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('4003')), true);
    assert.strictEqual(mock.sentCommands.includes('4004'), true);
  });

  it('Apre il cassetto e invia messaggio a display', async () => {
    await printer.connect();

    await printer.openDrawer();
    assert.strictEqual(mock.sentCommands.includes('70081'), true);

    await printer.displayText('BENVENUTO');
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('7007BENVENUTO')), true);

    await printer.clearDisplay();
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('7007    ')), true);
  });

  it('Esegue Chiusura Giornaliera (Z-Report) e Lettura Finanziaria (X-Report)', async () => {
    await printer.connect();

    await printer.printXReport();
    assert.strictEqual(mock.sentCommands.includes('2003'), true);

    await printer.printZReport();
    assert.strictEqual(mock.sentCommands.includes('2002'), true);
  });

  it('Emette Documento di Reso e Documento di Annullo RT', async () => {
    await printer.connect();

    // RT in servizio; la stampante risponde con la cifra di esito 0 (proposta accettata): come in Java la conferma segue solo allora
    mock.setHandler((cmd) => {
      if (cmd === '1511') return { data: '0'.repeat(25) + '1' + '0'.repeat(10) };
      return cmd.startsWith('7101') ? { data: '0' } : { data: '' };
    });
    await printer.identify();
    mock.sentCommands.length = 0;

    // Reso RT: il documento resta APERTO (articoli, pagamento, endFiscalReceipt)
    const refund = await printer.printRefundReceipt({
      docRef: { zReport: 1, ticketNumber: 2, date: '150523' },
      deviceSerial: 'STMTE110306'
    });
    assert.deepStrictEqual(refund, { emitted: true, documentOpen: true });

    assert.deepStrictEqual(mock.sentCommands, [
      '1010', '1011', '71020', '71021',
      '7101R000100021505230' + '11STMTE110306', // ASK con modalita' 0
      '7101R000100021505231' + '11STMTE110306' // PERFORM
    ]);
    mock.sentCommands.length = 0;
    await printer.resetPrinter();
    mock.sentCommands.length = 0;

    // Annullo RT: PERFORM = 0 -> il documento resta aperto
    const voided = await printer.printVoidReceipt({
      docRef: { zReport: 1, ticketNumber: 3, date: '150523' },
      deviceSerial: 'STMTE110306'
    });
    assert.deepStrictEqual(voided, { emitted: true, documentOpen: true });

    assert.deepStrictEqual(mock.sentCommands, [
      '1010', '1011', '71020', '71021',
      '7101A000100031505230' + '11STMTE110306',
      '7101A000100031505231' + '11STMTE110306'
    ]);
  });

  it('Solleva CustomFiscalError quando la stampante restituisce codice di errore', async () => {
    await printer.connect();

    mock.setHandler(() => {
      // Simula errore 16 (Carta esaurita, JPOS REC_EMPTY)
      return { error: 16 };
    });

    await assert.rejects(
      async () => {
        await printer.printRecTotal({ amountInCents: 100 });
      },
      (err: any) => {
        assert.strictEqual(err instanceof CustomFiscalError, true);
        assert.strictEqual(err.code, 16);
        assert.strictEqual(err.message.includes('Carta esaurita'), true);
        return true;
      }
    );
  });

  it('getVatTable e setVatTable programmano e leggono le aliquote IVA', async () => {
    await printer.connect();

    mock.setHandler((cmd) => {
      if (cmd === '7012') {
        // Ritorna 4 aliquote: 22.00% (2200), 10.00% (1000), 5.00% (0500), 4.00% (0400)
        return { data: '2200100005000400' };
      }
      return { data: '' };
    });

    const rates = await printer.getVatTable();
    assert.deepStrictEqual(rates, [22, 10, 5, 4]);

    mock.sentCommands.length = 0;
    await printer.setVatTable([22, 10, 4]);
    // 1010 (giornata chiusa se data[7] == '1'; qui risposta vuota = chiusa), reset totalizzatori, 7013 con 6 aliquote + 000000
    assert.deepStrictEqual(mock.sentCommands, ['1010', '220207', '220208', '220210', '7013' + '220010000400' + '000000000000' + '000000']);
  });

  it('getRTConnectionStatus legge lo stato verso Agenzia delle Entrate', async () => {
    await printer.connect();

    mock.setHandler((cmd) => {
      if (cmd === '1510') {
        // commandStatus='1', operationDesc='INVIO CORRISPETTIVI ', applError='000', httpError='200', xmlError='000'
        return { data: '1INVIO CORRISPETTIVI 000200000' };
      }
      return { data: '' };
    });

    const conn = await printer.getRTConnectionStatus();
    assert.strictEqual(conn.commandStatus, '1');
    assert.strictEqual(conn.operationDesc, 'INVIO CORRISPETTIVI');
    assert.strictEqual(conn.httpError, '200');
  });

  it('Gestione DGFE (percentuale e stampe)', async () => {
    await printer.connect();

    mock.setHandler((cmd) => {
      if (cmd === '8008') return { data: '42.5' };
      return { data: '' };
    });

    const pct = await printer.getDGFEPercentage();
    assert.strictEqual(pct, 42.5);

    await printer.printDGFEByDate('010123', '310123');
    assert.strictEqual(mock.sentCommands.includes('8001010123310123'), true);
  });

  it('duplicateReceipt, training mode e intestazioni scontrino', async () => {
    await printer.connect();

    await printer.duplicateReceipt();
    assert.strictEqual(mock.sentCommands.includes('4007'), true);

    await printer.beginTraining();
    assert.strictEqual(mock.sentCommands.includes('64300'), true);

    await printer.endTraining();
    assert.strictEqual(mock.sentCommands.includes('64301'), true);

    await printer.setHeaderLineCount(4);
    assert.strictEqual(mock.sentCommands.includes('63014'), true);

    await printer.setHeaderLine(1, 'Ristorante Pizzeria');
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('63021')), true);
  });

  it('printSimpleInvoice emette fattura semplificata RT', async () => {
    await printer.connect();

    await printer.printSimpleInvoice({
      invoiceNumber: 12,
      taxId: 'IT01234567890',
      customerLines: ['Rossi Mario', 'Via Roma 1']
    });

    assert.strictEqual(mock.sentCommands.includes('7102300012'), true);
    // come Java: 7103 solo per conto IVA con '@'; dati cliente (3010C) al primo pagamento
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('7103')), false);
    await printer.printRecTotal({ amountInCents: 100 });
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('3010C11Rossi Mario')), true); // testo dinamico
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('3010C') && c.includes('CF/P.IVA:IT01234567890')), true);
  });

  it('directIO supporta comandi numerici OPOS e stringhe grezze Custom', async () => {
    await printer.connect();

    // 1000 = open drawer
    await printer.directIO(1000, [1]);
    assert.strictEqual(mock.sentCommands.includes('70081'), true);

    // 1301 = clear display
    await printer.directIO(1301, [1]);
    assert.strictEqual(mock.sentCommands.some((c) => c.startsWith('7007    ')), true);

    // Raw command string
    mock.setHandler((cmd) => {
      if (cmd === '1008') return { data: 'STMTE999999' };
      return { data: '' };
    });
    const sn = await printer.directIO('1008');
    assert.strictEqual(sn, 'STMTE999999');
  });
});
