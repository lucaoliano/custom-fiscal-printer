import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter, formatJavaPad5 } from '../src/client/fiscal-printer';
import { MockTransport, MockHandler } from '../src/transports/mock.transport';
import { CustomOperationNotAllowedError } from '../src/errors';
import { Esc, ESC, parseEscSequenceLine } from '../src/protocol/esc-sequences';

const RT_IN_SERVICE = '0'.repeat(25) + '1' + '0'.repeat(7) + '0' + '00';

function setup(handler?: MockHandler, opts: Record<string, unknown> = {}) {
  const mock = new MockTransport(handler);
  const printer = new CustomFiscalPrinter(mock, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0, headerLineDelayMs: 0, ...opts });
  const calls: Array<[string, number]> = [];
  const orig = printer.executeCommand.bind(printer);
  printer.executeCommand = async (command: string, timeoutMs: number = 8000) => {
    if (!['1013', '1014', '1511'].includes(command) || handler === undefined && false) calls.push([command, timeoutMs]);
    return orig(command, timeoutMs);
  };
  const cmds = () => calls.map((c) => c[0]);
  return { mock, printer, calls, cmds };
}

/** RX con RT in servizio */
const rx: MockHandler = (cmd) => {
  if (cmd === '1013') return { data: 'KUBE II F' };
  if (cmd === '1014') return { data: '1601' };
  if (cmd === '1511') return { data: RT_IN_SERVICE };
  return { data: '' };
};

describe('P1: barcode 3023/3025, bitmap 3017/3026, ESC', () => {
  it('Esc.barcode con hri e parser', () => {
    assert.strictEqual(Esc.barcode('EAN13', '123', { hri: true }), `${ESC}|11R1{hri:1}123`);
    const p = parseEscSequenceLine(`${ESC}|4R1abc`);
    assert.deepStrictEqual(p.ops, [{ kind: 'barcode', type: '1', data: 'abc' }]);
  });

  it('printNormal in documento non fiscale: 3023 0 tipo hri 5 len3 dati, bitmap 3 cifre, feed', async () => {
    const { printer, cmds } = setup();
    await printer.connect();
    await printer.beginNonFiscal({ printHeader: false });
    await printer.printNormal(Esc.barcode('EAN13', '1234567890128') + Esc.bitmap(2) + Esc.bitmap(12));
    await printer.printNormal(Esc.barcode('QRCODE', 'ciao', { hri: true }));
    await printer.printNormal(Esc.barcode('QRCODE', 'ciao', { hri: false }));
    assert.deepStrictEqual(cmds().slice(1), [
      '30230' + '1' + '0' + '5' + '013' + '1234567890128',
      '3017002',
      '3017012',
      '30230' + '6' + '2' + '5' + '004' + 'ciao',
      '30230' + '6' + '0' + '5' + '004' + 'ciao'
    ]);
  });

  it('barcode: tetto 248 e tipo non valido non invia nulla', async () => {
    const { printer, cmds } = setup();
    await printer.connect();
    await printer.beginNonFiscal({ printHeader: false });
    await printer.printNormal(`${ESC}|301R1${'9'.repeat(300)}`);
    await printer.printNormal(`${ESC}|4RXabc`);
    assert.strictEqual(cmds()[1], '30230105248' + '9'.repeat(248));
    assert.strictEqual(cmds().length, 2);
  });

  it('trailer: logo 3026, barcode 3025 (tetto 190), feed, testo con pitch', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecTotal({ amountInCents: 100 });
    const before = cmds().length;
    await printer.endFiscalReceipt({
      printDetails: false,
      trailerLines: [`${ESC}|3B`, `${ESC}|301R1${'8'.repeat(250)}`, `${ESC}|0FX`]
    });
    assert.deepStrictEqual(cmds().slice(before), [
      '3026003',
      '30250' + '1' + '0' + '5' + '190' + '8'.repeat(190),
      '3024' + '1' + '01X',
      '3011',
      '3013'
    ]);
  });
});

describe('P1: fattura semplificata (71020/71021/71023/71029, 3010C)', () => {
  it('numero normale + CF: nessun 7103; dati cliente al primo pagamento', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    await printer.printSimpleInvoice({ invoiceNumber: 12, taxId: 'RSSMRA80A01H501U', customerLines: ['Rossi'] });
    assert.deepStrictEqual(cmds().slice(-3), ['71020', '71021', '7102300012']);
    await printer.printRecTotal({ amountInCents: 100 });
    const c = cmds();
    const i = c.indexOf('3010C05Rossi');
    assert.ok(i > 0);
    assert.strictEqual(c[i + 1], '3010C25CF/P.IVA:RSSMRA80A01H501U');
    assert.strictEqual(c[i + 2], '300408Contanti000000100');
  });

  it('numero con § -> 71029, troncamenti, non numerico, @ -> 7103', async () => {
    const t = async (num: string, taxId: string) => {
      const { printer, cmds } = setup(rx);
      await printer.connect();
      await printer.beginFiscalReceipt({ invoice: { number: num, taxId } });
      return cmds();
    };
    // 1010/1011: controllo giornata e stato; 71020/71021 solo con RT in servizio
    const h = ['1010', '1011', '71020', '71021'];
    assert.deepStrictEqual(await t('§42', 'X'), [...h, '7102900042']);
    assert.deepStrictEqual(await t('§1234567890', 'X'), [...h, '71029' + '12345']);
    assert.deepStrictEqual(await t('1234567', 'X'), [...h, '71023' + '12345']);
    assert.deepStrictEqual(await t('abc', 'X'), [...h, '7102300000']);
    assert.deepStrictEqual(await t('7', '@42'), [...h, '7102300007', '710300000']);
    assert.strictEqual(formatJavaPad5('007'), '00007');
    const { printer } = setup();
    await printer.connect();
    await assert.rejects(printer.beginFiscalReceipt({ invoice: { number: '', taxId: 'x' } }), RangeError);
    await assert.rejects(printer.beginFiscalReceipt({ invoice: { number: '1$', taxId: 'x' } }), RangeError);
    await assert.rejects(printer.beginFiscalReceipt({ invoice: { number: '§', taxId: 'x' } }), RangeError);
    await assert.rejects(printer.beginFiscalReceipt({ invoice: { number: '1', taxId: '' } }), RangeError);
  });
});

describe('P1: stato documento, printNormal -> printRecMessage', () => {
  it('printNormal con scontrino aperto -> 3002; dopo pagamento bufferizzato e stampato dopo 3011', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printNormal('Ciao');
    await printer.printRecTotal({ amountInCents: 100 });
    await printer.printNormal('Dopo');
    await printer.endFiscalReceipt({ printDetails: false });
    const c = cmds();
    assert.ok(c.includes('3002104Ciao'));
    assert.deepStrictEqual(c.slice(-3), ['3011', '3002104Dopo', '3013']);
  });

  it('guardie: operazioni fuori sequenza -> 114/207', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    const wrong = (e: any) => e instanceof CustomOperationNotAllowedError && e.jposCode === 114 && e.extendedJposCode === 207;
    await assert.rejects(printer.printRecItem({ description: 'a', priceInCents: 1 }), wrong);
    await assert.rejects(printer.printNormal('x'), wrong);
    await assert.rejects(printer.endNonFiscal(), wrong);
    await assert.rejects(printer.endFiscalReceipt(), wrong);
    await printer.beginFiscalReceipt();
    await assert.rejects(printer.beginFiscalReceipt(), wrong);
    await assert.rejects(printer.beginNonFiscal(), wrong);
    await assert.rejects(printer.printZReport(), wrong);
    await assert.rejects(printer.endFiscalReceipt(), wrong); // senza pagamento
    assert.deepStrictEqual(cmds().filter((c) => c === '4004' || c === '2002'), []);
  });

  it('endFiscalReceipt: 3011 poi 3013 (30 s) e stato azzerato', async () => {
    const { printer, calls } = setup(rx);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecTotal({ amountInCents: 100 });
    await printer.endFiscalReceipt({ printDetails: false });
    assert.deepStrictEqual(calls.slice(-2), [['3011', 30000], ['3013', 30000]]);
    assert.strictEqual(printer.getDocumentState().fiscalOpen, false);
  });
});

describe('P2: operazioni di scontrino', () => {
  it('33014 / 30014 / 3005 / 30012-3 / 31012-3 / 33014 refund', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await assert.rejects(printer.printRecItemVoid({ description: 'x', priceInCents: 1 }), CustomOperationNotAllowedError);
    await printer.printRecItem({ description: 'Pane', priceInCents: 100 });
    const b = cmds().length;
    await printer.printRecItemVoid({ description: 'Pane', priceInCents: 100, quantity: 2, unitPriceInCents: 50, vatInfo: 2 });
    await printer.printRecItemVoid({ description: 'Pane', priceInCents: 100, vatInfo: 10003 });
    await printer.printRecRefund({ amountInCents: 250 });
    await printer.printRecVoidItem('Pane', 100);
    await printer.printRecSubtotalAdjustment('DISCOUNT', 'sc', 10);
    await printer.printRecSubtotalAdjustment('MARKUP', 'mg', 10);
    await printer.printRecItemAdjustmentVoid('DISCOUNT', 'sc', 10, 3);
    await printer.printRecItemAdjustmentVoid('MARKUP', 'mg', 10, 10002);
    await printer.printRecNotPaid('Buoni', 500);
    assert.deepStrictEqual(cmds().slice(b, b + 9), [
      '33014' + '000002000' + '001' + '04Pane' + '000000050' + '2',
      '33014' + '000001000' + '003' + '04Pane' + '000000100' + '0',
      '33014' + '000001000' + '001' + '08Recupero' + '000000250' + '0',
      '30014' + '04Pane' + '000000100',
      '30013' + '02sc' + '000000010',
      '30012' + '02mg' + '000000010',
      '31012' + '03' + '02sc'.replace('03', '') + '000000010'.slice(0, 0) + '000000010'.slice(0, 0),
      '31013' + '02' + '02mg' + '000000010',
      '3005' + '05Buoni' + '000000500'
    ].map((x, i) => (i === 6 ? '31012' + '03' + '02sc' + '000000010' : x)));
  });

  it('printRecRefund non RT: 31019', async () => {
    const { printer, cmds } = setup(undefined);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecRefund({ description: 'Rec', amountInCents: 100, vatInfo: 30 });
    assert.strictEqual(cmds().pop(), '31019' + '01' + '03Rec' + '000000100');
  });

  it('PreLine/PostLine, POS id, numero reso, righe reso', async () => {
    const { printer, calls } = setup(rx);
    await printer.connect();
    await printer.setPosId('POS1', 'Mario');
    await printer.beginFiscalReceipt({ refund: true });
    printer.setRefundInfo({ number: 42, line1: 'Rif' });
    printer.setPreLine('prima');
    await printer.printRecItem({ description: 'a', priceInCents: 100 });
    printer.setPostLine('dopo');
    await printer.printRecSubtotal();
    await printer.printRecTotal({ amountInCents: 100 });
    await printer.endFiscalReceipt({ printDetails: false });
    const c = calls.map((x) => x[0]);
    assert.ok(c.indexOf('300215prima') < c.indexOf(c.find((x) => x.startsWith('33011'))!));
    assert.ok(c.includes('300214dopo') || c.includes('300214dopo'.replace('300214', '30021' + '04')));
    const i = c.indexOf('30101' + '03Rif');
    assert.deepStrictEqual(c.slice(i, i + 5), ['30101' + '03Rif', '30241' + '04POS1', '30241' + '05Mario', '3010P12' + '000000000042', '3011']);
    assert.deepStrictEqual(calls.find((x) => x[0] === '3010P12000000000042'), ['3010P12000000000042', 10000]);
  });

  it('checkTotal: totale diverso -> resetPrinter + 212', async () => {
    const h: MockHandler = (cmd) => {
      if (cmd === '1003') return { data: '0'.repeat(37) + '000000999' + '0'.repeat(15) };
      if (cmd === '1012') return { data: '1' };
      return rx(cmd, 0);
    };
    const { printer, cmds } = setup(h, { checkTotal: true });
    await printer.connect();
    await printer.beginFiscalReceipt();
    await assert.rejects(
      printer.printRecTotal({ amountInCents: 1000, expectedTotalInCents: 1000 }),
      (e: any) => e instanceof CustomOperationNotAllowedError && e.extendedJposCode === 212
    );
    assert.ok(cmds().includes('33018'));
    assert.strictEqual(cmds().pop(), '71020');
  });

  it('resetPrinter: stato vendita -> 33018 (15 s), 71020', async () => {
    const h: MockHandler = (cmd) => (cmd === '1012' ? { data: '1' } : rx(cmd, 0));
    const { printer, calls } = setup(h);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.resetPrinter();
    assert.ok(calls.some((c) => c[0] === '33018' && c[1] === 15000));
    assert.strictEqual(calls[calls.length - 1][0], '71020');
  });
});

describe('P2: getter, directIO, bitmap', () => {
  it('getDate normalizzata, serial da 1511, getFiscalState', async () => {
    const h: MockHandler = (cmd) => {
      if (cmd === '1001') return { data: '0301240930' };
      if (cmd === '1511') return { data: 'S' + 'ABCDEFGHIJK' + '0'.repeat(13) + '1' + '0'.repeat(10) };
      if (cmd === '1010') return { data: '00000001100' };
      return { data: '' };
    };
    const { printer } = setup(h);
    await printer.connect();
    assert.strictEqual(await printer.getDate(), '030120240930');
    assert.strictEqual(await printer.getSerialNumber(), 'ABCDEFGHIJK');
    const st = await printer.getFiscalState();
    assert.strictEqual(st.dayOpened, false);
    assert.strictEqual(st.nonFiscalDocOpen, true);
  });

  it('lettori strutturati 1003/1004/1115/1018/1104', async () => {
    const h: MockHandler = (cmd) => {
      if (cmd === '1003') return { data: '0'.repeat(36) + '0000001234' + '0000000050' + '0'.repeat(5) };
      if (cmd === '1004') return { data: '0007' + '000000100' + '0003' + '000000200' + '0'.repeat(26) + '000000300' + '0'.repeat(9) + '000000400' + '000000500' };
      if (cmd === '1104') return { data: '0012' + '0000' };
      return { data: '' };
    };
    const { printer } = setup(h);
    await printer.connect();
    const t = await printer.readTicketTotals();
    assert.strictEqual(t.currentTotal, 1234);
    assert.strictEqual(t.checkTotal, 1234);
    assert.strictEqual(t.notPaid, 50);
    const d = await printer.readDailyTotals();
    assert.deepStrictEqual([d.receiptNumber, d.dailyTotal, d.simplifiedInvoiceNumber, d.simplifiedInvoiceTotal, d.midVoid, d.refund, d.notPaid], [7, 100, 3, 200, 300, 400, 500]);
    assert.strictEqual(await printer.getZReportNumber(), 12);
  });

  it('1517 stato documento', async () => {
    const mk = (c: string) => setup((cmd) => (cmd.startsWith('1517') ? { data: 'xxxxxxxx' + c } : { data: '' }));
    for (const [c, code] of [['P', 2], ['A', 0], ['R', 1], ['C', 3], ['E', 3]] as const) {
      const { printer, calls } = mk(c);
      await printer.connect();
      assert.strictEqual((await printer.getDocumentStatus(1, 2)).code, code);
      assert.deepStrictEqual(calls[0], ['151700010002', 90000]);
    }
  });

  it('directIO: codici numerici e stringhe con timeout', async () => {
    const { printer, calls, cmds } = setup(rx);
    await printer.connect();
    await printer.directIO(1000, [1]);
    await printer.directIO(1302, [1], 'ciao');
    await printer.directIO(1302, [2], 'xy');
    await printer.directIO(1301, [1]);
    await printer.directIO(1600);
    await printer.directIO(-95002, [1]);
    await printer.directIO(-95002, [5]);
    await printer.directIO(-95002, [25]);
    await printer.directIO(-95001, [3]);
    await printer.directIO(-95012, [8], 'ABCD1234');
    await printer.directIO(1102, [3]);
    assert.deepStrictEqual(cmds(), [
      '70081',
      '7007' + 'ciao'.padEnd(40),
      '7007' + ' '.repeat(20) + 'xy'.padEnd(20),
      '7007' + ' '.repeat(40),
      '220207', '220208', '220210',
      '3017011', '3017012', '3017017',
      '63021I013',
      '301908ABCD1234',
      '910003000000'
    ].map((x) => x.replace('3017012', '3017012')).map((x, i) => (i === 7 ? '3017011' : x)));
    await assert.rejects(printer.directIO(1302, [3], 'x'), RangeError);
    await printer.directIO('3023abcdefghi');
    // RT in servizio (RTMode 3) e nessun documento non fiscale: riscritto in 30250 (timeout dal comando originale: 15 s)
    assert.deepStrictEqual(calls[calls.length - 1], ['30250ab50efghi', 15000]);
    await printer.directIO('8001010120010101');
    assert.strictEqual(calls[calls.length - 1][1], 1800000);
    await printer.directIO('<monitorServices />');
    assert.strictEqual(calls[calls.length - 1][0], '1520');
  });

  it('directIO 3023 riscritto in 30250 con scontrino aperto e RT in servizio', async () => {
    const { printer, cmds } = setup(rx);
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.directIO('3023' + '10' + '05' + 'dati');
    assert.strictEqual(cmds().pop(), '30250' + '10' + '50' + 'dati');
  });

  it('loadBitmap / eraseBitmap / resetTotalizers', async () => {
    const { printer, calls } = setup();
    await printer.connect();
    await printer.loadBitmap(new Uint8Array(52).fill(0xab), 2);
    assert.deepStrictEqual(calls.map((c) => c[0]), [
      '9100' + '02' + '000052',
      '910150' + 'AB'.repeat(50),
      '9101' + '02' + 'ABAB',
      '9102'
    ]);
    assert.ok(calls.every((c) => c[1] === 10000));
    await assert.rejects(printer.loadBitmap(new Uint8Array(1), 26), RangeError);
    await printer.eraseBitmap(5);
    assert.strictEqual(calls[calls.length - 1][0], '910005000000');
  });

  it('display: riga/colonna e getDrawerOpened', async () => {
    const { printer, cmds } = setup((cmd) => (cmd === '7108' ? { data: '1' } : { data: '' }));
    await printer.connect();
    await printer.displayTextAt(1, 2, 'ab');
    assert.strictEqual(cmds()[0], '7007' + ' '.repeat(22) + 'ab' + ' '.repeat(16));
    // clearText di Java riinvia il contenuto corrente (non cancella) e azzera il cursore; clearDisplay cancella
    await printer.clearText();
    assert.strictEqual(cmds()[1], cmds()[0]);
    await printer.clearDisplay();
    assert.strictEqual(cmds()[2], '7007' + ' '.repeat(40));
    assert.strictEqual(await printer.getDrawerOpened(), true);
  });
});

describe('Rifiniture: setDate/setHeaderLine con 1109, reso senza documento', () => {
  it('setDate e setHeaderLine: coperchio aperto / carta finita -> 207, senza altri comandi', async () => {
    const { printer, cmds } = setup((cmd) => (cmd === '1109' ? { data: '10000' } : { data: '' }));
    await printer.connect();
    await assert.rejects(printer.setDate(new Date(2024, 0, 1, 1, 1)), (e: any) => e.extendedJposCode === 207);
    await assert.rejects(printer.setHeaderLine(1, 'x'), (e: any) => e.extendedJposCode === 207);
    assert.deepStrictEqual(cmds(), ['1109', '1109']);
    const ok = setup((cmd) => (cmd === '1109' ? { data: '00000' } : { data: '' }));
    await ok.printer.connect();
    await ok.printer.setDate('010120240101');
    assert.deepStrictEqual(ok.cmds().slice(0, 2), ['1109', '20010101240101']);
  });

  it('reso con cifra ASK inattesa: nessun PERFORM ma documento aperto; annullo: ogni cifra != 2 prosegue', async () => {
    const warns: string[] = [];
    const rtH = (inner: MockHandler): MockHandler => (cmd, c) => (cmd === '1511' ? { data: RT_IN_SERVICE } : inner(cmd, c));
    const { printer, cmds } = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '7' } : { data: '' })), {
      logger: { warn: (m: string) => warns.push(m) }
    });
    await printer.connect();
    const r = await printer.printRefundReceipt({ docRef: { zReport: 1, ticketNumber: 2, date: '150523' }, deviceSerial: 'X' });
    assert.strictEqual(r.emitted, false);
    assert.strictEqual(r.documentOpen, true);
    assert.strictEqual(cmds().filter((c) => c.startsWith('7101')).length, 1);
    assert.ok(warns.length > 0);
    const ok = setup(rtH(() => ({ data: '1' })));
    await ok.printer.connect();
    assert.deepStrictEqual(
      await ok.printer.printVoidReceipt({ docRef: { zReport: 1, ticketNumber: 2, date: '150523' }, deviceSerial: 'X' }),
      { emitted: true, documentOpen: false }
    );
  });

  it('printRecTaxID: stato 1012 e invio 3019 / 3010B', async () => {
    const { printer, cmds } = setup((cmd) => (cmd === '1012' ? { data: '1' } : { data: '' }));
    await printer.connect();
    // Java: con "lotteria|CF" vale solo la lotteria (else-if); il CF si passa con "|CF" in una chiamata separata
    await printer.printRecTaxID('ABCD1234|RSSMRA80A01H501U');
    assert.deepStrictEqual(cmds(), ['1012', '301908ABCD1234']);
    await printer.printRecTaxID('|RSSMRA80A01H501U');
    assert.deepStrictEqual(cmds().slice(2), ['1012', '3010B16RSSMRA80A01H501U']);
  });
});
