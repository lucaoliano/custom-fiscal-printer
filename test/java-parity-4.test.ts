import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import { MockTransport, MockHandler } from '../src/transports/mock.transport';
import { CustomOperationNotAllowedError } from '../src/errors';

const RT_IN_SERVICE = '0'.repeat(25) + '1' + '0'.repeat(7) + '0' + '00';
const RT_NOT_IN_SERVICE = '0'.repeat(25) + '0' + '0'.repeat(7) + '0' + '00';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(handler?: MockHandler, opts: Record<string, unknown> = {}) {
  const mock = new MockTransport(handler);
  const printer = new CustomFiscalPrinter(mock, {
    statusPolling: false,
    identifyOnConnect: false,
    pendingOperationDelayMs: 0,
    headerLineDelayMs: 0,
    ...opts
  });
  const calls: Array<[string, number]> = [];
  const orig = printer.executeCommand.bind(printer);
  printer.executeCommand = async (command: string, timeoutMs: number = 8000) => {
    calls.push([command, timeoutMs]);
    return orig(command, timeoutMs);
  };
  return { mock, printer, calls, cmds: () => calls.map((c) => c[0]) };
}

const rtH = (inner: MockHandler = () => ({ data: '' }), rt1511 = RT_IN_SERVICE): MockHandler => (cmd, c) =>
  cmd === '1511' ? { data: rt1511 } : inner(cmd, c);

describe('directIO 3023 -> 30250 (RTMode 3 && startsWith 3023 && !NFTicket && length > 8)', () => {
  it('riscrive anche senza scontrino fiscale aperto; timeout dal comando originale (15 s)', async () => {
    const { printer, calls } = setup(rtH());
    await printer.connect();
    calls.length = 0;
    await printer.directIO('3023' + '10' + '05' + 'dati');
    assert.deepStrictEqual(calls.filter((c) => !['1511', '1013', '1014'].includes(c[0])), [['30250' + '10' + '50' + 'dati', 15000]]);
  });

  it('nessuna riscrittura: lunghezza <= 8, documento non fiscale aperto, RT non in servizio', async () => {
    const a = setup(rtH());
    await a.printer.connect();
    a.calls.length = 0;
    await a.printer.directIO('30231005');
    assert.deepStrictEqual(a.calls.filter((c) => !['1511', '1013', '1014'].includes(c[0])), [['30231005', 15000]]);

    const b = setup(rtH());
    await b.printer.connect();
    await b.printer.beginNonFiscal();
    b.calls.length = 0;
    await b.printer.directIO('30231005dati');
    assert.deepStrictEqual(b.calls.filter((c) => !['1511', '1013', '1014'].includes(c[0])), [['30231005dati', 15000]]);

    const c = setup(rtH(undefined, RT_NOT_IN_SERVICE));
    await c.printer.connect();
    c.calls.length = 0;
    await c.printer.directIO('30231005dati');
    assert.deepStrictEqual(c.calls.filter((x) => !['1511', '1013', '1014'].includes(x[0])), [['30231005dati', 15000]]);
  });
});

describe('directIO -95012 e stato unico m_csPseudoLotteryCode', () => {
  it('data vuoto -> errore; codice memorizzato e 3019 immediato (10 s) con lunghezza a 2 cifre', async () => {
    const { printer, calls } = setup(rtH());
    await printer.connect();
    await assert.rejects(printer.directIO(-95012, [], 'ABCD1234'), /invalid data length value/);
    await assert.rejects(printer.directIO(-95012, undefined, 'ABCD1234'), /invalid data length value/);
    assert.strictEqual(calls.filter((c) => c[0].startsWith('3019')).length, 0);
    await printer.directIO(-95012, [1], 'ABCD1234');
    assert.deepStrictEqual(calls.filter((c) => c[0].startsWith('3019')), [['301908ABCD1234', 10000]]);
    // codice vuoto: non sovrascrive il codice memorizzato (len 0 -> "00")
    await printer.directIO(-95012, [1], '');
    assert.deepStrictEqual(calls[calls.length - 1], ['301900', 10000]);
    // beginFiscalReceipt invia di nuovo il codice memorizzato (dopo 71021) e lo azzera
    calls.length = 0;
    await printer.beginFiscalReceipt();
    const c = calls.map((x) => x[0]);
    assert.ok(c.indexOf('71021') < c.indexOf('301908ABCD1234'));
    assert.strictEqual(c.filter((x) => x.startsWith('3019')).length, 1);
    await printer.resetPrinter();
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.ok(!calls.some((x) => x[0].startsWith('3019') && x[0] !== '301900'));
  });

  it('codice lungo >= 10 caratteri: lunghezza senza zero iniziale e nessun troncamento', async () => {
    const { printer, calls } = setup(rtH());
    await printer.connect();
    await printer.directIO(-95012, [1], 'ABCDEFGHIJ');
    assert.deepStrictEqual(calls[calls.length - 1], ['301910ABCDEFGHIJ', 10000]);
  });

  it('il codice di -95012 e\' usato dal documento RT 7101 (LotteryCodeDesc) e non viene azzerato da begin', async () => {
    const { printer, calls } = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '0' } : { data: '' })));
    await printer.connect();
    await printer.directIO(-95012, [1], 'ABCD1234');
    await printer.directIO(-95011, [7, 2], ['AB', '20230515']);
    calls.length = 0;
    await printer.beginFiscalReceipt();
    const c = calls.map((x) => x[0]);
    assert.ok(!c.some((x) => x.startsWith('3019')));
    assert.deepStrictEqual(c.filter((x) => x.startsWith('7101')), [
      '7101A000200071505230' + '02AB' + '08ABCD1234',
      '7101A000200071505231' + '02AB' + '08ABCD1234'
    ]);
  });

  it('opzione lotteryCode di begin = stesso stato: un solo 3019, poi azzerato', async () => {
    const { printer, calls } = setup(rtH());
    await printer.connect();
    await printer.beginFiscalReceipt({ lotteryCode: 'abcd1234' });
    assert.strictEqual(calls.filter((c) => c[0].startsWith('3019')).length, 1);
  });

  it('setLotteryCode equivale a directIO -95012 (memorizza)', async () => {
    const { printer, calls } = setup(rtH());
    await printer.connect();
    await printer.setLotteryCode('abcd1234');
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.ok(calls.some((x) => x[0] === '301908ABCD1234'));
  });
});

describe('printRecTaxID (stato 1012, else-if lotteria/codice fiscale, memorizzazione)', () => {
  const st = (d: string) => rtH((cmd) => (cmd === '1012' ? { data: d } : { data: '' }));

  it('8 caratteri = lotteria; 11/16 = codice fiscale; altra lunghezza = lotteria', async () => {
    const a = setup(st('1'));
    await a.printer.connect();
    await a.printer.printRecTaxID(' ABCD1234 ');
    assert.deepStrictEqual(a.calls.filter((c) => !['1511', '1013', '1014'].includes(c[0])), [['1012', 8000], ['301908ABCD1234', 8000]]);
    const b = setup(st('4'));
    await b.printer.connect();
    await b.printer.printRecTaxID('RSSMRA80A01H501U');
    assert.deepStrictEqual(b.calls.filter((c) => !['1511', '1013', '1014'].includes(c[0])), [['1012', 8000], ['3010B16RSSMRA80A01H501U', 8000]]);
    const c = setup(st('1'));
    await c.printer.connect();
    await c.printer.printRecTaxID('XYZ');
    assert.ok(c.cmds().includes('301903XYZ'));
  });

  it('"lotteria|CF": vale solo la lotteria (else-if di Java); "|CF": solo codice fiscale', async () => {
    const a = setup(st('1'));
    await a.printer.connect();
    await a.printer.printRecTaxID('ABCD1234|RSSMRA80A01H501U');
    assert.ok(!a.cmds().some((c) => c.startsWith('3010B')));
    const b = setup(st('1'));
    await b.printer.connect();
    await b.printer.printRecTaxID('|RSSMRA80A01H501U');
    assert.ok(b.cmds().includes('3010B16RSSMRA80A01H501U'));
    assert.ok(!b.cmds().some((c) => c.startsWith('3019')));
  });

  it('stato 0 senza scontrino: solo memorizzato (inviato da begin); stato 2/3: errore 114/207; codice fiscale con stato 0 e scontrino aperto: non inviato', async () => {
    const a = setup(st('0'));
    await a.printer.connect();
    await a.printer.printRecTaxID('ABCD1234');
    assert.ok(!a.cmds().some((c) => c.startsWith('3019')));
    a.calls.length = 0;
    await a.printer.beginFiscalReceipt();
    assert.ok(a.cmds().includes('301908ABCD1234'));

    const b = setup(st('3'));
    await b.printer.connect();
    await assert.rejects(b.printer.printRecTaxID('ABCD1234'), (e: any) => e instanceof CustomOperationNotAllowedError && e.extendedJposCode === 207);
    await assert.rejects(b.printer.printRecTaxID('RSSMRA80A01H501U'), (e: any) => e instanceof CustomOperationNotAllowedError);

    const c = setup(st('0'));
    await c.printer.connect();
    await c.printer.beginFiscalReceipt();
    c.calls.length = 0;
    await c.printer.printRecTaxID('RSSMRA80A01H501U');
    assert.deepStrictEqual(c.cmds(), ['1012']);
  });

  it('printRecTaxID azzera sempre i codici memorizzati prima di rileggere', async () => {
    const { printer, calls } = setup(rtH((cmd) => (cmd === '1012' ? { data: '0' } : { data: '' })));
    await printer.connect();
    await printer.directIO(-95012, [1], 'ABCD1234');
    await printer.printRecTaxID('');
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.ok(!calls.some((c) => c[0].startsWith('3019')));
  });
});

describe('open(): sequenza e polling di stato attivo di default', () => {
  it('connect di default: 30160, 1013, 1014, 1511, 1109 (UpdatePrinterStaus(true))', async () => {
    const m = new MockTransport(rtH());
    const p = new CustomFiscalPrinter(m);
    await p.connect();
    assert.deepStrictEqual(m.sentCommands, ['30160', '1013', '1014', '1511', '1109']);
    await p.disconnect();
  });

  it('statusPolling: false non invia 1109; il polling periodico emette eventi e si ferma a disconnect', async () => {
    const m = new MockTransport(rtH());
    const p = new CustomFiscalPrinter(m, { statusPolling: { intervalMs: 20 } });
    let polls = 0;
    const orig = p.executeCommand.bind(p);
    p.executeCommand = async (c: string, t?: number) => {
      if (c === '1109') polls++;
      return orig(c, t);
    };
    await p.connect();
    await sleep(120);
    assert.ok(polls >= 3, `polls=${polls}`);
    await p.disconnect();
    const after = polls;
    await sleep(80);
    assert.strictEqual(polls, after);

    const m2 = new MockTransport(rtH());
    const q = new CustomFiscalPrinter(m2, { statusPolling: false });
    await q.connect();
    assert.ok(!m2.sentCommands.includes('1109'));
  });

  it('30160 con errore: connect fallisce (Java: setModoBuffer false -> open fallisce) e il canale viene chiuso', async () => {
    const m = new MockTransport((cmd) => (cmd === '30160' ? { error: 16 } : { data: '' }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false });
    await assert.rejects(p.connect());
    assert.strictEqual(p.isConnected(), false);
  });

  it('CheckTotal e\' true di default (open() di Java): printRecTotal con totale atteso legge 1003', async () => {
    const { printer, calls } = setup(rtH((cmd) => (cmd === '1003' ? { data: '0'.repeat(37) + '000000100' + '0'.repeat(15) } : { data: '' })));
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecItem({ description: 'X', priceInCents: 100 });
    calls.length = 0;
    await printer.printRecTotal({ amountInCents: 100, expectedTotalInCents: 100 });
    assert.ok(calls.some((c) => c[0] === '1003'));
  });
});

describe('setHeaderLine con sequenze ESC (FilterEscSeqPrnHeader)', () => {
  const ESC = '\x1b';
  it('stile C/P e allineamento; logo; testo vuoto', async () => {
    const { printer, cmds } = setup(rtH(), { identifyOnConnect: true });
    await printer.connect();
    await printer.setHeaderLine(1, `${ESC}|5CCiao`); // C5 -> pitch 3
    await printer.setHeaderLine(2, `${ESC}|2CCiao`); // C2 -> pitch 5 / 22 colonne
    await printer.setHeaderLine(3, `${ESC}|1B`);
    await printer.setHeaderLine(4, '');
    const c = cmds().filter((x) => x.startsWith('6302'));
    assert.deepStrictEqual(c, ['63021304Ciao', '63022504Ciao', '63023I011', '63024100']);
  });
});
