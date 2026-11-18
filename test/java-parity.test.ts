import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter, getCmdTimeoutMs } from '../src/client/fiscal-printer';
import { MockTransport, MockHandler } from '../src/transports/mock.transport';
import { CustomFiscalError, CustomOperationNotAllowedError } from '../src/errors';
import { formatQty, formatSinglePrice } from '../src/utils/formatters';

/** Crea una stampante con MockTransport e registra (comando, timeout) di ogni executeCommand. */
function setup(handler?: MockHandler, opts: Record<string, unknown> = {}) {
  const mock = new MockTransport(handler);
  const printer = new CustomFiscalPrinter(mock, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0, headerLineDelayMs: 0, documentStateChecks: false, ...opts });
  const calls: Array<[string, number]> = [];
  const orig = printer.executeCommand.bind(printer);
  printer.executeCommand = async (command: string, timeoutMs: number = 8000) => {
    if (command !== '1109') calls.push([command, timeoutMs]); // 1109: controllo stato di setDate/setHeaderLine
    return orig(command, timeoutMs);
  };
  return { mock, printer, calls };
}

/** Risposta 1511 con RT in servizio (data[25] = '1') e DEMO a data[33]. */
const RT_IN_SERVICE = '0'.repeat(25) + '1' + '0'.repeat(7) + '0' + '00';
const RT_NOT_IN_SERVICE = '0'.repeat(25) + '0' + '0'.repeat(7) + '0' + '00';

/** Handler per una stampante RX (modello 0x16 sottomodello 1 -> 44 colonne, PrinterArch 3). */
function rxHandler(rt1511: string = RT_IN_SERVICE, extra?: MockHandler): MockHandler {
  return (cmd, counter) => {
    if (extra) {
      const r = extra(cmd, counter);
      if (r.error !== undefined || r.data !== undefined) return r;
    }
    if (cmd === '1013') return { data: 'KUBE II F 1.0' };
    if (cmd === '1014') return { data: '1601' };
    if (cmd === '1511') return { data: rt1511 };
    return { data: '' };
  };
}

describe('Item 1: reso/annullo (beginFiscalReceipt RTDocType 1/2)', () => {
  const docRef = { zReport: 1, ticketNumber: 2, date: '150523' };
  const base = '7101R00010002150523';

  /** Stampante con RT in servizio (identificata) e handler `inner` per il resto dei comandi. */
  async function rtSetup(inner: MockHandler, opts: Record<string, unknown> = {}) {
    const r = setup((cmd, c) => {
      if (cmd === '1511') return { data: RT_IN_SERVICE };
      if (cmd === '1013' || cmd === '1014') return { data: '' };
      return inner(cmd, c);
    }, opts);
    await r.printer.connect();
    await r.printer.identify();
    r.calls.length = 0;
    return r;
  }
  const rtCalls = (calls: Array<[string, number]>) => calls.filter((c) => c[0].startsWith('7101'));

  it('reso: ASK sempre con 0 (anche con noPreview), PERFORM 8/1, timeout 90 s; il documento resta aperto', async () => {
    const { printer, calls } = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '1' } : { data: '' }));
    const a = await printer.printRefundReceipt({ docRef, deviceSerial: 'STMTE110306', noPreview: true });
    assert.deepStrictEqual(a, { emitted: true, documentOpen: true });
    // sequenza completa dentro beginFiscalReceipt: giornata, stato, 71020/71021, ASK, PERFORM
    assert.deepStrictEqual(calls.map((c) => c[0]), [
      '1010', '1011', '71020', '71021',
      base + '0' + '11STMTE110306',
      base + '8' + '11STMTE110306'
    ]);
    assert.strictEqual(printer.getDocumentState().fiscalOpen, true);
    assert.strictEqual(printer.getDocumentState().printerState, 2);
    calls.length = 0;
    await printer.printRefundReceipt({ docRef, deviceSerial: 'STMTE110306', lotteryCode: 'abcd1234' });
    assert.deepStrictEqual(rtCalls(calls), [
      [base + '0' + '11STMTE110306' + '08ABCD1234', 90000],
      [base + '1' + '11STMTE110306' + '08ABCD1234', 90000]
    ]);
    // nessun 3019: la lotteria e' nei comandi 7101R
    assert.ok(!calls.some((c) => c[0].startsWith('3019')));
  });

  it('reso: risposta 2 -> operazione non consentita (nessun PERFORM); altre cifre -> nessun PERFORM ma documento aperto', async () => {
    const { printer, calls } = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '2' } : { data: '' }));
    await assert.rejects(
      printer.printRefundReceipt({ docRef, deviceSerial: 'X' }),
      (e: any) => e instanceof CustomOperationNotAllowedError && e.jposCode === 106 && /non consentita/.test(e.message)
    );
    assert.strictEqual(rtCalls(calls).length, 1);
    assert.strictEqual(printer.getDocumentState().fiscalOpen, false); // stato azzerato (resetGlobalValues)

    const o = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '3' } : { data: '' }));
    const r = await o.printer.printRefundReceipt({ docRef, deviceSerial: 'X' });
    assert.strictEqual(rtCalls(o.calls).length, 1);
    assert.strictEqual(r.emitted, false);
    assert.strictEqual(r.documentOpen, true); // Java prosegue col tail: lo scontrino resta aperto
    assert.strictEqual(o.printer.getDocumentState().fiscalOpen, true);
  });

  it('reso: risposta PERFORM 2 -> operazione non consentita', async () => {
    const { printer } = await rtSetup((cmd) => (cmd.startsWith('7101') ? (cmd.endsWith('0' + '01X') ? { data: '0' } : { data: '2' }) : { data: '' }));
    await assert.rejects(printer.printRefundReceipt({ docRef, deviceSerial: 'X' }), CustomOperationNotAllowedError);
    assert.strictEqual(printer.getDocumentState().fiscalOpen, false);
  });

  it('reso/annullo: ERR03/ERR05 ignorati dalla policy java vengono ispezionati come in Java', async () => {
    for (const code of [3, 5]) {
      const r = await rtSetup((cmd) => (cmd.startsWith('7101') ? { error: code } : { data: '' }));
      await assert.rejects(r.printer.printRefundReceipt({ docRef, deviceSerial: 'X' }), CustomOperationNotAllowedError);
      const v = await rtSetup((cmd) => (cmd.startsWith('7101') ? { error: code } : { data: '' }));
      await assert.rejects(v.printer.printVoidReceipt({ docRef, deviceSerial: 'X' }), CustomOperationNotAllowedError);
    }
    // altri errori restano CustomFiscalError
    const o = await rtSetup((cmd) => (cmd.startsWith('7101') ? { error: 16 } : { data: '' }));
    await assert.rejects(o.printer.printRefundReceipt({ docRef, deviceSerial: 'X' }), CustomFiscalError);
    assert.strictEqual(o.printer.getDocumentState().fiscalOpen, false);
  });

  it('reso/annullo: ERR05 sul PERFORM -> operazione non consentita', async () => {
    const { printer } = await rtSetup((cmd) => (cmd.startsWith('7101') ? (cmd.includes('1' + '01X') && cmd.includes('2150523' + '1') ? { error: 5 } : { data: '0' }) : { data: '' }));
    await assert.rejects(printer.printVoidReceipt({ docRef, deviceSerial: 'X' }), CustomOperationNotAllowedError);
  });

  it('annullo: ASK 0 / 8, poi PERFORM sempre 1; PERFORM 1 chiude il documento; risposta 2 = non consentito', async () => {
    const { printer, calls } = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '0' } : { data: '' }));
    const r1 = await printer.printVoidReceipt({ docRef, deviceSerial: 'STMTE110306' });
    assert.deepStrictEqual(r1, { emitted: true, documentOpen: true });
    await printer.resetPrinter();
    await printer.printVoidReceipt({ docRef, deviceSerial: 'STMTE110306', noPreview: true });
    const b = '7101A00010002150523';
    assert.deepStrictEqual(
      rtCalls(calls).map((c) => c[0]),
      [
        b + '0' + '11STMTE110306', // ASK
        b + '1' + '11STMTE110306', // PERFORM
        b + '8' + '11STMTE110306', // ASK senza preview
        b + '1' + '11STMTE110306' // PERFORM sempre 1
      ]
    );
    // PERFORM = 1: la stampante ha completato il documento
    const c = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '1' } : { data: '' }));
    const r2 = await c.printer.printVoidReceipt({ docRef, deviceSerial: 'X' });
    assert.deepStrictEqual(r2, { emitted: true, documentOpen: false });
    assert.strictEqual(c.printer.getDocumentState().fiscalOpen, false);
    assert.strictEqual(c.printer.getDocumentState().paymentStarted, false);
    assert.strictEqual(c.calls[c.calls.length - 1][0].startsWith('7101A'), true); // niente tail dopo il completamento

    const o = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '2' } : { data: '' }));
    await assert.rejects(o.printer.printVoidReceipt({ docRef, deviceSerial: 'X' }), CustomOperationNotAllowedError);
    assert.strictEqual(rtCalls(o.calls).length, 1);
  });

  it('deviceSerial: massimo 11 caratteri, lunghezza reale', async () => {
    const { printer, calls } = await rtSetup((cmd) => (cmd.startsWith('7101') ? { data: '0' } : { data: '' }));
    await printer.printRefundReceipt({ docRef, deviceSerial: 'ABCDEFGHIJKLMNOP' });
    assert.strictEqual(rtCalls(calls)[0][0], base + '0' + '11ABCDEFGHIJK');
    await printer.resetPrinter();
    calls.length = 0;
    await printer.printVoidReceipt({ docRef, deviceSerial: 'AB' });
    assert.strictEqual(rtCalls(calls)[0][0], '7101A00010002150523' + '0' + '02AB');
  });

  it('policy strict: ERR05 sul reso e\' un CustomFiscalError (nessuna ispezione Java)', async () => {
    const { printer } = await rtSetup((cmd) => (cmd.startsWith('7101') ? { error: 5 } : { data: '' }), { errorPolicy: 'strict' });
    await assert.rejects(printer.printRefundReceipt({ docRef, deviceSerial: 'X' }), CustomFiscalError);
  });

  it('RT non in servizio: nessun documento (come directIO -95010 senza RTMode 3)', async () => {
    const { printer, calls } = setup((cmd) => (cmd === '1511' ? { data: RT_NOT_IN_SERVICE } : { data: '' }));
    await printer.connect();
    const r = await printer.printRefundReceipt({ docRef, deviceSerial: 'X' });
    assert.strictEqual(r.emitted, false);
    assert.strictEqual(r.documentOpen, false);
    assert.ok(!calls.some((c) => c[0].startsWith('7101') || c[0] === '71020'));
  });
});

describe('Item 2/10: identificazione (ReadPrinterModel / ReadRTLogicalStatus) e chiusura scontrino', () => {
  it('RX con RT in servizio: 30112 (timeout 30 s) dopo 1013/1014/1511 una sola volta', async () => {
    const { printer, calls } = setup(rxHandler());
    await printer.connect();
    await printer.endFiscalReceipt();
    await printer.endFiscalReceipt();
    assert.deepStrictEqual(calls, [
      ['1013', 10000],
      ['1014', 10000],
      ['1511', 10000],
      ['30112', 30000],
      ['3013', 30000],
      ['30112', 30000],
      ['3013', 30000]
    ]);
    const caps = printer.getCapabilities();
    assert.strictEqual(caps.rxPrinter, true);
    assert.strictEqual(caps.printerArch, 3);
    assert.strictEqual(caps.rtInService, true);
    assert.strictEqual(caps.rtMode, 3);
    assert.strictEqual(caps.model, '16');
    assert.strictEqual(caps.subModel, '1');
    assert.strictEqual(caps.descriptionLength, 44);
    assert.strictEqual(caps.messageLength, 44);
    assert.strictEqual(caps.messageLength42, 44);
    assert.strictEqual(caps.numHeaderLines, 9);
    assert.strictEqual(printer.descriptionLength, 44);
  });

  it('printDetails false -> 3011 (senza nemmeno identificare); RT non in servizio -> 3011', async () => {
    const a = setup(rxHandler());
    await a.printer.connect();
    await a.printer.endFiscalReceipt({ printDetails: false });
    assert.deepStrictEqual(a.calls, [['3011', 30000], ['3013', 30000]]);

    const b = setup(rxHandler(RT_NOT_IN_SERVICE));
    await b.printer.connect();
    await b.printer.endFiscalReceipt();
    assert.strictEqual(b.calls[b.calls.length - 2][0], '3011');
    assert.strictEqual(b.printer.getCapabilities().rtMode, 2);
  });

  it('stampante non RX (modello 0x08/1) -> 3011, 32 colonne, PrinterArch 2', async () => {
    // 0x08 = '08' -> (0*16+8); sottomodello 1 -> '01'
    const { printer, calls } = setup((cmd) =>
      cmd === '1014' ? { data: '0801' } : cmd === '1511' ? { data: RT_IN_SERVICE } : { data: '' }
    );
    await printer.connect();
    await printer.endFiscalReceipt();
    assert.strictEqual(calls[calls.length - 2][0], '3011');
    const caps = printer.getCapabilities();
    assert.strictEqual(caps.rxPrinter, false);
    assert.strictEqual(caps.printerArch, 2);
    assert.strictEqual(caps.descriptionLength, 22);
    assert.strictEqual(caps.messageLength, 32);
    assert.strictEqual(caps.messageLength42, 42);
    assert.strictEqual(caps.numHeaderLines, 9);
  });

  it('modello 0x15/1 (col32): RX ma 22 colonne, righe 32/42', async () => {
    const { printer } = setup((cmd) => (cmd === '1014' ? { data: '1501' } : { data: '' }));
    await printer.connect();
    const caps = await printer.identify();
    assert.strictEqual(caps.rxPrinter, true);
    assert.strictEqual(caps.descriptionLength, 22);
    assert.strictEqual(caps.messageLength, 32);
    assert.strictEqual(caps.messageLength42, 42);
  });

  it('1013 con "NCR 130A": RX, 44 colonne, MessageLength42 56, nessun 1014', async () => {
    const { printer, calls } = setup((cmd) => (cmd === '1013' ? { data: 'NCR 130A v1' } : { data: '' }));
    await printer.connect();
    const caps = await printer.identify();
    assert.strictEqual(caps.rxPrinter, true);
    assert.strictEqual(caps.descriptionLength, 44);
    assert.strictEqual(caps.messageLength42, 56);
    assert.ok(!calls.some((c) => c[0] === '1014'));
  });

  it('autoIdentify false: nessun comando di identificazione, 3011 di default', async () => {
    const { printer, calls } = setup(rxHandler(), { autoIdentify: false });
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.endFiscalReceipt();
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['1010', '1011', '3011', '3013'] // RTMode 2 (default non identificato): niente 71020/71021
    );
  });

  it('ERR05 sulla chiusura (ignorato dalla policy java) termina senza errori; strict propaga', async () => {
    const { printer } = setup(rxHandler(RT_IN_SERVICE, (cmd) => (cmd === '30112' ? { error: 5 } : {})));
    await printer.connect();
    await assert.doesNotReject(printer.endFiscalReceipt());
    const s = setup(() => ({ error: 5 }), { errorPolicy: 'strict', autoIdentify: false });
    await s.printer.connect();
    await assert.rejects(s.printer.endFiscalReceipt(), CustomFiscalError);
  });

  it('identificazione con ERR05 su 1511: default (non RT), nessun errore', async () => {
    const { printer } = setup((cmd) => (cmd === '1511' ? { error: 5 } : { data: '' }));
    await printer.connect();
    const caps = await printer.identify();
    assert.strictEqual(caps.rtInService, false);
    assert.strictEqual(caps.rtMode, 2);
  });

  it('getRTStatus: tutti i campi del 1511 (layout directIO 1511XML, offset Java - 1)', async () => {
    //   0       1..11        12..21        22 23 24 25   26..31   32 33 34 35 36
    const data = 'S' + 'MATRRT12345' + 'MATR83ABCD' + 'x' + 'C' + 'A' + '1' + '230124' + 'Z' + '1' + 'N' + 'V' + 'I';
    assert.strictEqual(data.length, 37);
    const { printer, calls } = setup((cmd) => (cmd === '1511' ? { data } : { data: '' }));
    await printer.connect();
    const rt = await printer.getRTStatus();
    assert.deepStrictEqual(calls[0], ['1511', 10000]);
    assert.strictEqual(rt.isRT, true);
    assert.strictEqual(rt.inService, true);
    assert.strictEqual(rt.rtMode, 3);
    assert.strictEqual(rt.trainingMode, true);
    assert.strictEqual(rt.serialRt, 'S');
    assert.strictEqual(rt.matrRt, 'MATRRT12345');
    assert.strictEqual(rt.matr83, 'MATR83ABCD');
    assert.strictEqual(rt.chiavePri, 'C');
    assert.strictEqual(rt.censimento, 'C');
    assert.strictEqual(rt.attivazione, 'A');
    assert.strictEqual(rt.dataInServizio, '230124');
    assert.strictEqual(rt.simulazione, 'Z');
    assert.strictEqual(rt.nextTicketRt, 'N');
    assert.strictEqual(rt.vatSplit, 'V');
    assert.strictEqual(rt.inactivityPeriod, 'I');
  });

  it('getRTStatus: ERR05/ERR03 o risposta corta = non RT; non in servizio = rtMode 2', async () => {
    for (const error of [3, 5]) {
      const { printer } = setup(() => ({ error }));
      await printer.connect();
      const rt = await printer.getRTStatus();
      assert.strictEqual(rt.isRT, false);
      assert.strictEqual(rt.inService, false);
      assert.strictEqual(rt.rtMode, 0);
    }
    const n = setup((cmd) => (cmd === '1511' ? { data: RT_NOT_IN_SERVICE } : { data: '' }));
    await n.printer.connect();
    const rt = await n.printer.getRTStatus();
    assert.strictEqual(rt.isRT, true);
    assert.strictEqual(rt.inService, false);
    assert.strictEqual(rt.rtMode, 2);
    assert.strictEqual(rt.trainingMode, false);
  });
});

describe('Item 3: setHeaderLine', () => {
  it('6302 + riga + pitch + testo dinamico (MessageLength)', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.setHeaderLine(1, 'Ristorante');
    await printer.setHeaderLine(2, 'Ristorante', true);
    await printer.setHeaderLine(3, '');
    await printer.setHeaderLine(4, 'x'.repeat(40)); // > MessageLength(32): pitch 3, max MessageLength42(44)
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      [
        '6302' + '1' + '1' + '10Ristorante',
        '6302' + '2' + '2' + '10Ristorante', // doubleWidth: pitch 2
        '6302' + '3' + '1' + '00', // testo vuoto
        '6302' + '4' + '3' + '40' + 'x'.repeat(40) // oltre MessageLength: pitch 3
      ]
    );
  });

  it('deleteEmptyHeaderLines invia anche 6301 + riga; range 1..9 (6 prima/9 dopo identify)', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false, deleteEmptyHeaderLines: true });
    await printer.connect();
    await printer.setHeaderLine(5, 'A');
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['6302' + '5' + '1' + '01A', '6301' + '5']
    );
    await assert.rejects(printer.setHeaderLine(10, 'x'), RangeError);

    // con identificazione di una stampante non RX il limite e' NumHeaderLines
    const r = setup((cmd) => (cmd === '1014' ? { data: '0801' } : { data: '' }));
    await r.printer.connect();
    await r.printer.setHeaderLine(9, 'ok');
    await assert.rejects(r.printer.setHeaderLine(0, 'x'), RangeError);
  });

  it('attesa di headerLineDelayMs solo sulle non RX', async () => {
    const nonRx = setup(undefined, { autoIdentify: false, headerLineDelayMs: 40 });
    await nonRx.printer.connect();
    const t0 = Date.now();
    await nonRx.printer.setHeaderLine(1, 'A');
    assert.ok(Date.now() - t0 >= 35);

    const rx = setup(rxHandler(), { headerLineDelayMs: 300 });
    await rx.printer.connect();
    const t1 = Date.now();
    await rx.printer.setHeaderLine(1, 'A');
    assert.ok(Date.now() - t1 < 250);
  });
});

describe('Item 4: setDate', () => {
  it('invia 2001 + ggMM + aaHHmm (10 caratteri, senza secondi)', async () => {
    const { printer, calls } = setup();
    await printer.connect();
    await printer.setDate(new Date(2024, 2, 5, 14, 7, 59));
    await printer.setDate('050320241407');
    assert.deepStrictEqual(calls, [
      ['20010503241407', 8000],
      ['20010503241407', 8000]
    ]);
    assert.strictEqual(calls[0][0].length, 14); // '2001' + 10
    await assert.rejects(printer.setDate('0503'), RangeError);
    await assert.rejects(printer.setDate(new Date('x')), RangeError);
  });

  it('risposta 1 (data troppo distante): ripete lo stesso comando per confermare, una volta sola', async () => {
    const { printer, calls } = setup((cmd) => ({ data: cmd === '1109' ? '' : '1' }));
    await printer.connect();
    await printer.setDate(new Date(2024, 11, 31, 23, 59));
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['20013112' + '242359', '20013112' + '242359']
    );
  });
});

describe('Item 5: setVatTable / getVatTable / getDayOpened', () => {
  it('giornata aperta -> CustomOperationNotAllowedError, nessun reset', async () => {
    // 1010: data[7] != '1' = giornata aperta
    const { printer, calls } = setup((cmd) => (cmd === '1010' ? { data: '00000000' } : { data: '' }));
    await printer.connect();
    await assert.rejects(printer.setVatTable([22]), CustomOperationNotAllowedError);
    assert.deepStrictEqual(calls.map((c) => c[0]), ['1010']);
    assert.strictEqual(await printer.getDayOpened(), true);
  });

  it('giornata chiusa: reset totalizzatori (10 s) e 7013 con 6 aliquote + 000000 (30 s)', async () => {
    const { printer, calls } = setup((cmd) => (cmd === '1010' ? { data: '00000001' } : { data: '' }));
    await printer.connect();
    await printer.setVatTable([22, 10, 5, 4, 0.5, 1.25]);
    assert.deepStrictEqual(calls, [
      ['1010', 8000],
      ['220207', 10000],
      ['220208', 10000],
      ['220210', 10000],
      ['7013' + '2200' + '1000' + '0500' + '0400' + '0050' + '0125' + '000000', 30000]
    ]);
    await assert.rejects(printer.setVatTable([1, 2, 3, 4, 5, 6, 7]), RangeError);
    assert.strictEqual(await printer.getDayOpened(), false);
  });

  it('getVatTable: 6 aliquote da 4 cifre (offset (i-1)*4 dei dati)', async () => {
    const { printer } = setup((cmd) => (cmd === '7012' ? { data: '220010000500040000000000' + '9999' } : { data: '' }));
    await printer.connect();
    assert.deepStrictEqual(await printer.getVatTable(), [22, 10, 5, 4, 0, 0]);
  });
});

describe('Item 6/8: printRecItem reparto/IVA e riga di dettaglio 3002', () => {
  const desc = 'Caffe'.padEnd(22, ' ');

  it('reparto > 0: reparto a 3 cifre e IVA 0; senza reparto: 000 e IVA (intera, non a 2 cifre)', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.printRecItem({ description: 'Caffe', priceInCents: 120, department: 5 });
    await printer.printRecItem({ description: 'Caffe', priceInCents: 120, vatRate: 2 });
    await printer.printRecItem({ description: 'Caffe', priceInCents: 120, department: 29 });
    await printer.printRecItem({ description: 'Caffe', priceInCents: 120 });
    assert.deepStrictEqual(calls, [
      ['33011' + '000001000' + '005' + '22' + desc + '000000120' + '0', 10000],
      ['33011' + '000001000' + '000' + '22' + desc + '000000120' + '2', 10000],
      ['33011' + '000001000' + '029' + '22' + desc + '000000120' + '0', 10000],
      ['33011' + '000001000' + '000' + '22' + desc + '000000120' + '1', 10000]
    ]);
  });

  it('reparto > 29 o negativo, o reparto + aliquota insieme -> RangeError senza comandi', async () => {
    const { printer, mock } = setup();
    await printer.connect();
    await assert.rejects(printer.printRecItem({ description: 'a', priceInCents: 1, department: 30 }), RangeError);
    await assert.rejects(printer.printRecItem({ description: 'a', priceInCents: 1, department: -1 }), RangeError);
    await assert.rejects(
      printer.printRecItem({ description: 'a', priceInCents: 1, department: 3, vatRate: 1 }),
      RangeError
    );
    assert.strictEqual(mock.sentCommands.length, 0);
  });

  it('descrizione paddata a DescriptionLength (44 sulle RX)', async () => {
    const { printer, calls } = setup(rxHandler());
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecItem({ description: 'Caffe', priceInCents: 120 });
    const sale = calls.find((c) => c[0].startsWith('33011'))!;
    assert.strictEqual(sale[0], '33011' + '000001000' + '000' + '44' + 'Caffe'.padEnd(44, ' ') + '000000120' + '1');
  });

  it('riga 3002 solo se quantity != 1: virgola decimale, zeri finali tolti, unita\' di misura, niente euro', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.printRecItem({
      description: 'Mele', priceInCents: 300, quantity: 1.5, unitName: 'Kg', unitPriceInCents: 200
    });
    await printer.printRecItem({
      description: 'Mele', priceInCents: 600, quantity: 3, unitPriceInCents: 200
    });
    await printer.printRecItem({
      description: 'Mele', priceInCents: 200, quantity: 1, unitName: 'Kg'
    });
    assert.deepStrictEqual(calls, [
      ['3002' + '1' + '13' + '1,5 Kg x 2,00', 10000],
      ['33011' + '000001500' + '000' + '22' + 'Mele'.padEnd(22) + '000000200' + '1', 10000],
      ['3002' + '1' + '08' + '3 x 2,00', 10000],
      ['33011' + '000003000' + '000' + '22' + 'Mele'.padEnd(22) + '000000200' + '1', 10000],
      ['33011' + '000001000' + '000' + '22' + 'Mele'.padEnd(22) + '000000200' + '1', 10000] // qty 1: nessuna riga 3002
    ]);
    assert.ok(!calls.some((c) => c[0].includes('€') || c[0].includes('\x7F')));
  });

  it('quantita\' con piu\' di 6 cifre (x1000) -> RangeError', async () => {
    const { printer, mock } = setup();
    await printer.connect();
    await assert.rejects(
      printer.printRecItem({ description: 'a', priceInCents: 1, quantity: 1000, unitPriceInCents: 1 }),
      RangeError
    );
    assert.strictEqual(mock.sentCommands.length, 0);
  });

  it('formatQty / formatSinglePrice: port dei formatter Java', () => {
    const cases: Array<[number, string]> = [
      [1000, '1'], [1500, '1,5'], [1250, '1,25'], [1050, '1,05'], [5, '0,005'], [10, '0,01'], [100, '0,1'],
      [50, '0,05'], [12345, '12,345'], [10000, '10'], [20500, '20,5'], [999, '0,999'], [3000, '3']
    ];
    for (const [q, out] of cases) assert.strictEqual(formatQty(q), out, String(q));
    const prices: Array<[number, string]> = [[200, '2,00'], [5, '0,05'], [0, '0,00'], [50, '0,50'], [12345, '123,45'], [99, '0,99']];
    for (const [c, out] of prices) assert.strictEqual(formatSinglePrice(c), out, String(c));
  });
});

describe('Item 7: printRecItemAdjustment', () => {
  it('sconto/maggiorazione: quantita 000001000, reparto 001 (non arch 3) o 000 (arch 3), IVA, descrizione dinamica', async () => {
    const a = setup(undefined, { autoIdentify: false });
    await a.printer.connect();
    await a.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'Sconto', amountInCents: 100 });
    await a.printer.printRecItemAdjustment({ type: 'MARKUP', description: 'Extra', amountInCents: 50, vatRate: 3 });
    await a.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'Sconto', amountInCents: 100, department: 7 });
    assert.deepStrictEqual(
      a.calls.map((c) => c[0]),
      [
        '33013' + '000001000' + '001' + '06Sconto' + '000000100' + '1',
        '33012' + '000001000' + '001' + '05Extra' + '000000050' + '3',
        '33013' + '000001000' + '007' + '06Sconto' + '000000100' + '0'
      ]
    );

    const b = setup(rxHandler());
    await b.printer.connect();
    await b.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'Sconto', amountInCents: 100 });
    assert.strictEqual(
      b.calls[b.calls.length - 1][0],
      '33013' + '000001000' + '000' + '06Sconto' + '000000100' + '1'
    ); // PrinterArch 3: reparto 000
  });

  it('descrizione troncata a DescriptionLength; reparto + aliquota -> RangeError', async () => {
    const a = setup(undefined, { autoIdentify: false });
    await a.printer.connect();
    await a.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'x'.repeat(30), amountInCents: 1 });
    assert.strictEqual(a.calls[0][0], '33013' + '000001000' + '001' + '22' + 'x'.repeat(22) + '000000001' + '1');
    await assert.rejects(
      a.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'x', amountInCents: 1, department: 2, vatRate: 1 }),
      RangeError
    );
    await assert.rejects(
      a.printer.printRecItemAdjustment({ type: 'DISCOUNT', description: 'x', amountInCents: 1, department: 30 }),
      RangeError
    );
  });
});

describe('Item 9: descrizioni dinamiche (formattaDescrizione) e righe', () => {
  it('codice fiscale 3010B, annullo 30018, righe di cortesia 3024 con pitch', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.setFiscalCode('rssmra80a01h501u');
    await printer.printRecVoid('ANNULLO');
    await printer.endFiscalReceipt({ printDetails: false, trailerLines: ['Arrivederci', '\x1B|2CGrazie', '\x1B|5Ccond'] });
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      [
        '3010B' + '16RSSMRA80A01H501U',
        '30018' + '07ANNULLO' + '000000000',
        '3024' + '1' + '11Arrivederci',
        '3024' + '5' + '06Grazie',
        '3024' + 'D' + '04cond',
        '3011',
        '3013'
      ]
    );
  });

  it('righe di cortesia: massimo MessageLength42 (42 su non RX)', async () => {
    const { printer, calls } = setup((cmd) => (cmd === '1014' ? { data: '0801' } : { data: '' }));
    await printer.connect();
    await printer.endFiscalReceipt({ printDetails: false, trailerLines: ['y'.repeat(60)] });
    assert.strictEqual(calls.find((c) => c[0].startsWith('3024'))![0], '3024' + '1' + '42' + 'y'.repeat(42));
  });

  it('printNormal: testo dinamico non paddato; feed con 40031 + " " dinamico', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.printNormal('Ciao');
    await printer.printNormal('\x1B|1FX');
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['4003' + '1' + '04Ciao', '40031' + '01 ', '4003' + '1' + '01X']
    );
  });

  it('righe di intestazione scontrino 3002: testo dinamico', async () => {
    const { printer, calls } = setup(undefined, { autoIdentify: false });
    await printer.connect();
    await printer.beginFiscalReceipt({ headerLines: ['Tavolo 4'] });
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['1010', '1011', '3002' + '1' + '08Tavolo 4']
    );
  });
});

describe('Item 12: timeout dei comandi come internalIO del driver Java', () => {
  it('tabella timeout', async () => {
    const { printer, calls } = setup((cmd) => (cmd.startsWith('7101') ? { data: '0' } : { data: '' }), {
      autoIdentify: false
    });
    await printer.connect();
    await printer.cutPaper();
    await printer.duplicateReceipt();
    await printer.printXReport();
    await printer.printZReport();
    await printer.printPeriodicTotalsReport('010123', '310123');
    await printer.printPeriodicReportByNumber(1, 2);
    await printer.printDGFEByDate('010123', '310123');
    await printer.printDGFEByTicket(1, 2);
    await printer.printDGFEByClosing(1, 2);
    await printer.beginTraining();
    await printer.endTraining();
    await printer.printRecSubtotal();
    await printer.printRecTotal({ amountInCents: 100 });
    await printer.directIO('9102');
    await printer.directIO('3023x');
    await printer.directIO('8006x');
    await printer.directIO('1008');
    const t = new Map(calls.map((c) => [c[0], c[1]] as [string, number]));
    assert.strictEqual(t.get('3013'), 30000);
    assert.strictEqual(t.get('4007'), 30000);
    assert.strictEqual(t.get('2003'), 8000);
    assert.strictEqual(t.get('2002'), 180000);
    assert.strictEqual(t.get('1513'), 40000);
    assert.strictEqual(t.get('5002010123310123'), 8000);
    assert.strictEqual(t.get('500100010002'), 8000);
    assert.strictEqual(t.get('8001010123310123'), 1800000);
    assert.strictEqual(t.get('800200010002'), 1800000);
    assert.strictEqual(t.get('800300010002'), 1800000);
    assert.strictEqual(t.get('64300'), 10000);
    assert.strictEqual(t.get('64301'), 10000);
    assert.strictEqual(t.get('3003'), 8000);
    assert.strictEqual(t.get('9102'), 15000);
    assert.strictEqual(t.get('3023x'), 15000);
    assert.strictEqual(t.get('8006x'), 180000);
    assert.strictEqual(t.get('1008'), 10000);
  });

  it('getCmdTimeoutMs come getCmdTimeout di Java', () => {
    for (const c of ['8001', '8002', '8003', '8005']) assert.strictEqual(getCmdTimeoutMs(c + '0101'), 1800000);
    assert.strictEqual(getCmdTimeoutMs('9102'), 15000);
    assert.strictEqual(getCmdTimeoutMs('3023X'), 15000);
    assert.strictEqual(getCmdTimeoutMs('8006'), 180000);
    assert.strictEqual(getCmdTimeoutMs('1109'), 10000);
  });
});
