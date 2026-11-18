import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import { MockTransport, MockHandler } from '../src/transports/mock.transport';
import { CustomOperationNotAllowedError, CustomFiscalError } from '../src/errors';
import { PrinterStatusUpdateEvent } from '../src/types';

const RT_IN_SERVICE = '0'.repeat(25) + '1' + '0'.repeat(7) + '0' + '00';
const RT_NOT_IN_SERVICE = '0'.repeat(25) + '0' + '0'.repeat(7) + '0' + '00';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stampante con MockTransport; registra (comando, timeout) di ogni executeCommand. */
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
  const cmds = () => calls.map((c) => c[0]);
  return { mock, printer, calls, cmds };
}

/** Handler RT in servizio (1511) con comportamento `inner` per il resto. */
const rtH = (inner: MockHandler = () => ({ data: '' }), rt1511 = RT_IN_SERVICE): MockHandler => (cmd, c) => {
  if (cmd === '1511') return { data: rt1511 };
  return inner(cmd, c);
};

describe('A: reso/annullo RT come documenti aperti (directIO -95010/-95011 + beginFiscalReceipt)', () => {
  const obj = ['MATR1234567', '20230515'];

  it('directIO -95010: nulla sul filo, valori memorizzati; begin esegue 7101R dentro l\'apertura', async () => {
    const { printer, calls, cmds, mock } = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '1' } : { data: '' })));
    await printer.connect();
    assert.strictEqual(await printer.directIO(-95010, [5, 3], obj), 'OK');
    assert.ok(!mock.sentCommands.some((c) => c.startsWith('7101')));
    calls.length = 0;
    const r = await printer.beginFiscalReceipt();
    assert.deepStrictEqual(r, { documentOpen: true, rtDocumentEmitted: true });
    // Z = data[1] = 0003, scontrino = data[0] = 0005, data = chars [6,7,4,5,2,3] di yyyyMMdd
    assert.deepStrictEqual(calls, [
      ['1010', 8000], ['1011', 8000], ['71020', 8000], ['71021', 8000],
      ['7101R000300051505230' + '11MATR1234567', 90000],
      ['7101R000300051505231' + '11MATR1234567', 90000]
    ]);
    assert.ok(!cmds().some((c) => c.startsWith('3019')));
    // il documento resta aperto: vendita, pagamento senza comando (Java: payFlag + PrinterState 4), chiusura
    calls.length = 0;
    await printer.printRecItem({ description: 'Reso', priceInCents: 100 });
    await printer.printRecTotal({ amountInCents: 100 });
    assert.ok(!cmds().some((c) => c.startsWith('3004') || c.startsWith('3007')));
    assert.deepStrictEqual(printer.getDocumentState(), { fiscalOpen: true, nonFiscalOpen: false, paymentStarted: true, printerState: 4 });
    await printer.endFiscalReceipt({ printDetails: false });
    assert.ok(cmds().includes('3011'));
    assert.strictEqual(printer.getDocumentState().fiscalOpen, false);
    // il pending e' stato consumato: una nuova begin e' un documento normale
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.ok(!cmds().some((c) => c.startsWith('7101')));
  });

  it('directIO -95011: annullo; PERFORM 1 chiude il documento (nessun tail, payFlag/restoStep false)', async () => {
    const { printer, calls } = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '1' } : { data: '' })));
    await printer.connect();
    await printer.directIO(-95011, [7, 2], obj);
    calls.length = 0;
    const r = await printer.beginFiscalReceipt();
    assert.deepStrictEqual(r, { documentOpen: false, rtDocumentEmitted: true });
    assert.deepStrictEqual(calls.map((c) => c[0]), [
      '1010', '1011', '71020', '71021',
      '7101A000200071505230' + '11MATR1234567',
      '7101A000200071505231' + '11MATR1234567'
    ]);
    assert.deepStrictEqual(printer.getDocumentState(), { fiscalOpen: false, nonFiscalOpen: false, paymentStarted: false, printerState: 1 });
  });

  it('directIO senza effetto con RTMode != 3; validazioni 106 con RT in servizio', async () => {
    const n = setup(rtH(undefined, RT_NOT_IN_SERVICE));
    await n.printer.connect();
    assert.strictEqual(await n.printer.directIO(-95010, [1], []), 'OK'); // no-op: nessuna validazione
    n.calls.length = 0;
    await n.printer.beginFiscalReceipt();
    assert.ok(!n.cmds().some((c) => c.startsWith('7101')));

    const { printer } = setup(rtH());
    await printer.connect();
    await assert.rejects(printer.directIO(-95010, [1], obj), /invalid data length value/);
    await assert.rejects(printer.directIO(-95010, [1, 2], ['X']), /invalid object size/);
    await assert.rejects(printer.directIO(-95011, [1, 2], ['X', '2023051']), /invalid issueDate Format/);
    await assert.rejects(printer.directIO(-95011, [1, 2], ['X', '2023051A']), /invalid issueDate Format/);
  });

  it('rtDocument nelle opzioni, noPreview, lotteria nei 7101; errore azzera lo stato', async () => {
    const { printer, calls } = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '0' } : { data: '' })));
    await printer.connect();
    await printer.beginFiscalReceipt({
      lotteryCode: 'zzzzzzzz', // ignorata: niente 3019 nei documenti RT
      rtDocument: { type: 'void', docRef: { zReport: 1, ticketNumber: 2, date: '150523' }, deviceSerial: 'AB', noPreview: true, lotteryCode: 'abcd1234' }
    });
    const cmds = calls.map((c) => c[0]);
    assert.ok(!cmds.some((c) => c.startsWith('3019')));
    assert.deepStrictEqual(cmds.filter((c) => c.startsWith('7101')), [
      '7101A00010002150523' + '8' + '02AB' + '08ABCD1234',
      '7101A00010002150523' + '1' + '02AB' + '08ABCD1234'
    ]);

    const e = setup(rtH((cmd) => (cmd.startsWith('7101') ? { data: '2' } : { data: '' })));
    await e.printer.connect();
    await assert.rejects(
      e.printer.beginFiscalReceipt({ rtDocument: { type: 'refund', docRef: { zReport: 1, ticketNumber: 2, date: '150523' }, deviceSerial: 'X' } }),
      (er: any) => er instanceof CustomOperationNotAllowedError && er.jposCode === 106
    );
    assert.strictEqual(e.printer.getDocumentState().fiscalOpen, false);
  });
});

describe('B: 7102600000 (FiscalReceiptType 7 senza RT in servizio)', () => {
  it('refund: true con RT non in servizio invia 7102600000 (10 s) e passa al tail', async () => {
    const { printer, calls } = setup(rtH(undefined, RT_NOT_IN_SERVICE));
    await printer.connect();
    await printer.beginFiscalReceipt({ refund: true, fiscalCode: 'RSSMRA80A01H501U', lotteryCode: 'ABCD1234' });
    // 1013/1014/1511: identificazione lazy
    assert.deepStrictEqual(calls.filter((c) => !['1013', '1014'].includes(c[0])), [
      ['1511', 10000], ['1010', 8000], ['1011', 8000],
      ['301908ABCD1234', 8000],
      ['7102600000', 10000],
      ['3010B16RSSMRA80A01H501U', 8000]
    ]);
  });

  it('refund: true con RT in servizio: nessun 7102600000, solo 71020/71021', async () => {
    const { printer, cmds } = setup(rtH());
    await printer.connect();
    await printer.beginFiscalReceipt({ refund: true });
    assert.ok(!cmds().includes('7102600000'));
    assert.ok(cmds().includes('71020') && cmds().includes('71021'));
  });
});

describe('C: prologo di beginFiscalReceipt', () => {
  it('71020/71021 solo con RT in servizio', async () => {
    const a = setup(rtH());
    await a.printer.connect();
    await a.printer.beginFiscalReceipt();
    assert.deepStrictEqual(a.cmds().filter((c) => c.startsWith('7102')), ['71020', '71021']);
    const b = setup(rtH(undefined, RT_NOT_IN_SERVICE));
    await b.printer.connect();
    await b.printer.beginFiscalReceipt();
    assert.deepStrictEqual(b.cmds().filter((c) => c.startsWith('7102')), []);
  });

  it('giornata: 1010 finche\' non aperta; se aperta 1511 una volta e poi niente', async () => {
    const closed = setup(rtH((cmd) => (cmd === '1010' ? { data: '00000001000' } : { data: '' })));
    await closed.printer.connect();
    await closed.printer.beginFiscalReceipt();
    // giornata chiusa (data[7]=='1'): nessun 1511 oltre all'identificazione lazy
    assert.deepStrictEqual(closed.cmds().filter((c) => c === '1511').length, 1);

    const open = setup(rtH((cmd) => (cmd === '1010' ? { data: '00000000000' } : { data: '' })), { documentStateChecks: false });
    await open.printer.connect();
    await open.printer.identify();
    open.calls.length = 0;
    await open.printer.beginFiscalReceipt();
    assert.deepStrictEqual(open.cmds().slice(0, 4), ['1010', '1511', '1011', '71020']);
    open.calls.length = 0;
    await open.printer.beginFiscalReceipt();
    assert.deepStrictEqual(open.cmds().slice(0, 2), ['1011', '71020']); // giornata gia' nota aperta
  });

  it('riempiVarStatoStep(true,true): 1011 data[0] != 0 -> gia\' aperto (114/207); data[0] == 0 azzera lo stato obsoleto', async () => {
    let s11 = '00';
    const { printer, cmds } = setup(rtH((cmd) => (cmd === '1011' ? { data: s11 } : { data: '' })));
    await printer.connect();
    await printer.beginFiscalReceipt();
    // la stampante dice "nessun documento": lo stato obsoleto lato client viene azzerato e si procede (1012 letto)
    await printer.beginFiscalReceipt();
    assert.strictEqual(cmds().filter((c) => c === '1012').length, 2);
    s11 = '10'; // documento fiscale aperto sulla stampante
    await assert.rejects(
      printer.beginFiscalReceipt(),
      (e: any) => e instanceof CustomOperationNotAllowedError && e.jposCode === 114 && e.extendedJposCode === 207
    );
    // nessun comando di apertura dopo l'errore
    const last = cmds().slice(-2);
    assert.deepStrictEqual(last, ['1011', '1012']);
  });

  it('lotteria: 3019 solo se non RT doc; resetLottery solo se accettata (nessun ERR); 301900 al reset', async () => {
    // RX: il reset resta nel ramo RX (nelle non RX endFiscalReceiptbyReset azzera il flag come in Java)
    const rxH = (inner: MockHandler = () => ({ data: '' })): MockHandler => rtH((cmd, c) => (cmd === '1014' ? { data: '1601' } : inner(cmd, c)));
    const ok = setup(rxH());
    await ok.printer.connect();
    await ok.printer.beginFiscalReceipt({ lotteryCode: 'abcd1234' });
    assert.ok(ok.cmds().includes('301908ABCD1234'));
    ok.calls.length = 0;
    await ok.printer.resetPrinter();
    assert.ok(ok.cmds().includes('301900'));
    assert.deepStrictEqual(ok.cmds().slice(-2), ['71020', '301900']);

    // errore 5 (ignorato dalla policy java): codice NON accettato -> niente 301900
    const bad = setup(rxH((cmd) => (cmd.startsWith('3019') ? { error: 5 } : { data: '' })));
    await bad.printer.connect();
    await bad.printer.beginFiscalReceipt({ lotteryCode: 'abcd1234' });
    bad.calls.length = 0;
    await bad.printer.resetPrinter();
    assert.ok(!bad.cmds().includes('301900'));
  });

  it('printRecTaxID prima di begin: lotteria (3019) e codice fiscale (3010B) applicati e azzerati da begin', async () => {
    const { printer, cmds, calls } = setup(rtH((cmd) => (cmd === '1012' ? { data: '0' } : { data: '' })));
    await printer.connect();
    await printer.printRecTaxID('ABCD1234');
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.deepStrictEqual(cmds().filter((c) => c.startsWith('3019') || c.startsWith('3010B')), ['301908ABCD1234']);
    // ordine Java: ... 71021, 3019, 3010B
    assert.ok(cmds().indexOf('71021') < cmds().indexOf('301908ABCD1234'));
    calls.length = 0;
    await printer.resetPrinter();
    calls.length = 0;
    await printer.beginFiscalReceipt();
    assert.ok(!cmds().some((c) => c.startsWith('3019') || c.startsWith('3010B')));
  });
});

describe('D: XML di directIO 1510XML / 1511XML / 1520', () => {
  const CRLF = '\r\n';

  it('1510XML: Stato_Connessione_RT', async () => {
    const d = '1' + 'INVIO CORRISPETTIVI '.substring(0, 20) + '123' + '200' + '000';
    const { printer, calls } = setup((cmd) => (cmd === '1510' ? { data: d } : { data: '' }));
    await printer.connect();
    const xml = await printer.directIO('1510XML');
    assert.deepStrictEqual(calls[calls.length - 1], ['1510', 10000]);
    assert.strictEqual(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?>' + CRLF +
        '<Stato_Connessione_RT ' + CRLF +
        'STATO_CMD = "1"' + CRLF +
        'DESC.OP = "INVIO CORRISPETTIVI"' + CRLF +
        'APPL.ERR = "123"' + CRLF +
        'HTTP.ERR = "200"' + CRLF +
        'XML.ERR = "000"/>'
    );
  });

  it('1511XML: Stato_logico_RT con campi corti a "0"', async () => {
    const d = 'S' + 'ABCDEFGHIJK' + '0123456789' + 'x' + '1' + '1' + '1' + '150523' + '0' + '1' + '1' + '1' + '7';
    const { printer } = setup((cmd) => (cmd === '1511' ? { data: d } : { data: '' }));
    await printer.connect();
    const expected = (demo: string, nt: string, vs: string, ip: string) =>
      '<?xml version="1.0" encoding="UTF-8"?>' + CRLF +
      '<Stato_logico_RT ' + CRLF +
      'SERIAL_RT = "S"' + CRLF +
      'MATR_RT = "ABCDEFGHIJK"' + CRLF +
      'MATR_83 = "0123456789"' + CRLF +
      'CHIAVE_PRI = "1"' + CRLF +
      'CENSIMENTO = "1"' + CRLF +
      'ATTIVAZIONE = "1"' + CRLF +
      'IN_SERVIZIO = "1"' + CRLF +
      'DATA_IN_SERVIZIO = "15052"' + CRLF + // r[27,33): sei caratteri a partire da data[26]
      'SIMULAZIONE = "3"' + CRLF +
      `DEMO = "${demo}"` + CRLF +
      `NEXTTICKETRT = "${nt}"` + CRLF +
      `VATSPLIT = "${vs}"` + CRLF +
      `INACTIVITYPERIOD = "${ip}"` + CRLF +
      '/>';
    // costruzione indipendente dei campi da `d` (offset Java - 1)
    const exp = expected(d.charAt(33), d.charAt(34), d.charAt(35), d.charAt(36))
      .replace('CHIAVE_PRI = "1"', `CHIAVE_PRI = "${d.charAt(23)}"`)
      .replace('CENSIMENTO = "1"', `CENSIMENTO = "${d.charAt(23)}"`)
      .replace('ATTIVAZIONE = "1"', `ATTIVAZIONE = "${d.charAt(24)}"`)
      .replace('IN_SERVIZIO = "1"', `IN_SERVIZIO = "${d.charAt(25)}"`)
      .replace('DATA_IN_SERVIZIO = "15052"', `DATA_IN_SERVIZIO = "${d.substring(26, 32)}"`)
      .replace('SIMULAZIONE = "3"', `SIMULAZIONE = "${d.charAt(32)}"`);
    assert.strictEqual(await printer.directIO('1511XML'), exp);

    // risposta corta (26 caratteri): DEMO/NEXTTICKETRT/VATSPLIT/INACTIVITYPERIOD = "0"
    const short = setup((cmd) => (cmd === '1511' ? { data: RT_IN_SERVICE.substring(0, 30) } : { data: '' }));
    await short.printer.connect();
    const x = await short.printer.directIO('1511XML');
    assert.match(x, /DEMO = "0"\r\nNEXTTICKETRT = "0"\r\nVATSPLIT = "0"\r\nINACTIVITYPERIOD = "0"\r\n\/>$/);
  });

  it('1520 e <monitorServices />: services Z= invoices= lottery= Zbackup= fwdownload=', async () => {
    const { printer, calls } = setup((cmd) => (cmd === '1520' ? { data: '10110' } : { data: '' }));
    await printer.connect();
    assert.strictEqual(await printer.directIO('<monitorServices />'), '<services Z=1 invoices=0  lottery=1 Zbackup=1  fwdownload=0 />');
    assert.strictEqual(await printer.directIO('1520'), '<services Z=1 invoices=0  lottery=1 Zbackup=1  fwdownload=0 />');
    assert.deepStrictEqual(calls[calls.length - 1], ['1520', 10000]);
  });

  it('ERR05/ERR03: nessun risultato (stringa vuota)', async () => {
    for (const code of [3, 5]) {
      const { printer } = setup((cmd) => (cmd === '1510' || cmd === '1511' || cmd === '1520' ? { error: code } : { data: '' }));
      await printer.connect();
      assert.strictEqual(await printer.directIO('1510XML'), '');
      assert.strictEqual(await printer.directIO('1511XML'), '');
      assert.strictEqual(await printer.directIO('1520'), '');
    }
  });
});

describe('E: monitoraggio sensori (CheckStatusThread / UpdatePrinterStaus)', () => {
  it('connect con polling: evento iniziale forzato, poi solo transizioni; stop alla disconnessione', async () => {
    let status = '00000';
    let polls = 0;
    const { printer, mock } = setup(
      (cmd) => {
        if (cmd === '1109') {
          polls++;
          return { data: status };
        }
        return { data: '' };
      },
      { statusPolling: { intervalMs: 5 } }
    );
    const events: PrinterStatusUpdateEvent[] = [];
    printer.on('statusUpdate', (e) => events.push(e));
    await printer.connect();
    // UpdatePrinterStaus(true): tutti i gruppi segnalati al primo giro
    assert.deepStrictEqual(events.map((e) => e.code), [12, 26, 23]);
    assert.strictEqual(events[0].name, 'COVER_OK');
    await sleep(40);
    assert.strictEqual(events.length, 3); // nessuna transizione
    assert.ok(polls > 2);

    events.length = 0;
    status = '10100'; // coperchio aperto, carta quasi finita
    await sleep(40);
    assert.deepStrictEqual(events.map((e) => e.code), [11, 25]);
    assert.strictEqual(events[0].status.coverOpen, true);

    events.length = 0;
    status = '10011'; // carta ok, giornale quasi finito + finito (22 poi 21)
    await sleep(40);
    assert.deepStrictEqual(events.map((e) => e.code), [26, 22, 21]);

    events.length = 0;
    status = '01100'; // coperchio ok, carta finita + quasi (24, 25), giornale ok
    await sleep(40);
    assert.deepStrictEqual(events.map((e) => e.code), [12, 24, 25, 23]);

    await printer.disconnect();
    const before = mock.sentCommands.length;
    const p = polls;
    await sleep(30);
    assert.strictEqual(polls, p);
    assert.strictEqual(mock.sentCommands.length, before);
  });

  it('non si interpone con una transazione in corso e rispetta la pausa (Z report)', async () => {
    let polls = 0;
    const { printer } = setup(
      (cmd) => {
        if (cmd === '1109') polls++;
        return { data: '' };
      },
      { statusPolling: { intervalMs: 5 } }
    );
    await printer.connect();
    await sleep(20);
    let during = -1;
    await printer.transaction(async (tx) => {
      const start = polls;
      await sleep(60);
      during = polls - start;
      await tx.executeCommand('1008');
    });
    assert.strictEqual(during, 0);
    await printer.disconnect();
  });

  it('polling disattivato di default: nessun 1109 e nessun timer', async () => {
    const { printer, mock } = setup();
    await printer.connect();
    await sleep(30);
    assert.ok(!mock.sentCommands.includes('1109'));
    await printer.disconnect();
  });
});

describe('F: identificazione alla connessione', () => {
  it('default: 1013, 1014, 1511 al connect; identifyOnConnect/autoIdentify false: nessun comando', async () => {
    const a = new CustomFiscalPrinter(new MockTransport(rtH((cmd) => (cmd === '1014' ? { data: '1601' } : { data: '' }))), { statusPolling: false });
    await a.connect();
    assert.strictEqual(a.getCapabilities().rtMode, 3);
    assert.strictEqual(a.getCapabilities().rxPrinter, true);

    const m1 = new MockTransport();
    const b = new CustomFiscalPrinter(m1, { statusPolling: false, identifyOnConnect: false, documentStateChecks: false });
    await b.connect();
    assert.deepStrictEqual(m1.sentCommands, []);
    const m2 = new MockTransport();
    const c = new CustomFiscalPrinter(m2, { statusPolling: false, autoIdentify: false });
    await c.connect();
    assert.deepStrictEqual(m2.sentCommands, []);
    const m3 = new MockTransport();
    const d = new CustomFiscalPrinter(m3, { statusPolling: false });
    await d.connect();
    assert.deepStrictEqual(m3.sentCommands, ['30160', '1013', '1014', '1511']);
    // identificazione lazy come fallback con identifyOnConnect: false
    await b.endFiscalReceipt({ printDetails: true });
    assert.deepStrictEqual(m1.sentCommands.slice(0, 3), ['1013', '1014', '1511']);
  });

  it('errore stampante (ERRxx) in identificazione: connect riesce con i default', async () => {
    const m = new MockTransport((cmd) => (cmd === '30160' ? { data: '' } : { error: 16 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false });
    await p.connect();
    assert.strictEqual(p.isConnected(), true);
    assert.strictEqual(p.getCapabilities().rtMode, 2);
  });
});

describe('G: LineDisplay (formatForDisplay / scrollLine / cursore)', () => {
  it('displayText scrive alla posizione del cursore sopra il contenuto e avanza il cursore', async () => {
    const { printer, calls } = setup();
    await printer.connect();
    await printer.displayText('Hello');
    await printer.displayText('World');
    assert.deepStrictEqual(calls, [
      ['7007' + 'Hello' + ' '.repeat(35), 8000],
      ['7007' + 'HelloWorld' + ' '.repeat(30), 8000]
    ]);
  });

  it('displayTextAt imposta il cursore; oltre la fine il display scorre (scrollLine azzera)', async () => {
    const { printer, cmds } = setup();
    await printer.connect();
    await printer.displayTextAt(1, 18, 'ABCDE'); // pos 38, end 43 -> scroll, resta 'CDE'
    await printer.displayText('x'); // cursore a colonna 3
    assert.deepStrictEqual(cmds(), ['7007' + 'CDE' + ' '.repeat(37), '7007' + 'CDEx' + ' '.repeat(36)]);
  });

  it('testo di 40 caratteri: cursore a riga 2; il testo successivo scorre', async () => {
    const { printer, cmds } = setup();
    await printer.connect();
    await printer.displayText('A'.repeat(40));
    await printer.displayText('z');
    await printer.displayText('y'.repeat(50)); // tronco a 40
    assert.deepStrictEqual(cmds(), [
      '7007' + 'A'.repeat(40),
      '7007' + 'z' + ' '.repeat(39),
      // cursore a (0,1): 40 'y' -> end 41 -> scroll, resta solo l'eccedenza ('y') + 39 spazi
      '7007' + 'y' + ' '.repeat(39)
    ]);
  });

  it('clearText riinvia il contenuto (Java non cancella) e azzera il cursore; clearDisplay cancella', async () => {
    const { printer, cmds } = setup();
    await printer.connect();
    await printer.displayText('abc');
    await printer.clearText();
    await printer.displayText('Q');
    await printer.clearDisplay();
    await printer.displayText('R');
    assert.deepStrictEqual(cmds(), [
      '7007' + 'abc' + ' '.repeat(37),
      '7007' + 'abc' + ' '.repeat(37),
      '7007' + 'Qbc' + ' '.repeat(37),
      '7007' + ' '.repeat(40),
      '7007' + 'R' + ' '.repeat(39)
    ]);
  });

  it('errore sul comando: buffer e cursore invariati', async () => {
    let fail = false;
    const { printer, cmds } = setup((cmd) => (cmd.startsWith('7007') && fail ? { error: 16 } : { data: '' }));
    await printer.connect();
    await printer.displayText('ab');
    fail = true;
    await assert.rejects(printer.displayText('cd'), CustomFiscalError);
    fail = false;
    await printer.displayText('e');
    assert.strictEqual(cmds()[cmds().length - 1], '7007' + 'abe' + ' '.repeat(37));
  });
});

describe('H: CashDrawer openDrawer', () => {
  it('errori ingoiati e registrati con logger.warn; 70081 a 8 s', async () => {
    const warns: string[] = [];
    const { printer, calls } = setup((cmd) => (cmd === '70081' ? { error: 16 } : { data: '' }), {
      logger: { warn: (m: string) => warns.push(m) }
    });
    await printer.connect();
    await assert.doesNotReject(printer.openDrawer());
    assert.deepStrictEqual(calls, [['70081', 8000]]);
    assert.strictEqual(warns.length >= 1, true);
  });
});

describe('I: resetPrinter, rami non RX (endFiscalReceiptbyReset, getNotPayed)', () => {
  /** Stampante non RX (modello 0x08/1), RT non in servizio, 1012 = `phase`. */
  const nonRx = (phase: string, extra: MockHandler = () => ({ data: '' })): MockHandler => {
    docOpen = false;
    return (cmd, c) => {
    if (cmd === '1014') return { data: '0801' };
    if (cmd === '1012') return { data: phase };
    if (cmd === '1011') return { data: docOpen ? '10' : '00' }; // documento aperto solo dopo beginFiscalReceipt
    return extra(cmd, c);
    };
  };
  let docOpen = false;

  it('fase vendita (1012=1): 310180100000000000 (15 s) poi endFiscalReceiptbyReset completo, 71020', async () => {
    const { printer, calls } = setup(nonRx('1'));
    await printer.connect();
    await printer.beginFiscalReceipt({ trailerLines: ['Grazie'] });
    docOpen = true;
    await printer.setPosId('POS1', 'Mario');
    printer.setRefundInfo({ number: 42, line1: 'Rif1' });
    calls.length = 0;
    await printer.resetPrinter();
    const i = calls.findIndex((c) => c[0] === '310180100000000000');
    assert.deepStrictEqual(calls.slice(0, i + 1).map((c) => c[0]), ['1109', '1011', '1012', '1010', '310180100000000000']);
    assert.strictEqual(calls[i][1], 15000);
    assert.deepStrictEqual(calls.slice(i + 1), [
      ['3010104POS1', 10000],
      ['3010105Mario', 10000],
      ['3010P12000000000042', 10000],
      ['30241' + '06Grazie', 8000],
      ['3011', 30000],
      ['3013', 30000],
      ['71020', 8000]
    ]);
  });

  it('fase pagamento (1012=2) non RX: getNotPayed (1003, 10 s) e pagamento "PAGAMENTO PER ANNULLO" del residuo', async () => {
    const { printer, calls } = setup(
      nonRx('2', (cmd) => (cmd === '1003' ? { data: '0'.repeat(47) + '000000250' + '0'.repeat(5) } : { data: '' }))
    );
    await printer.connect();
    await printer.beginFiscalReceipt();
    docOpen = true;
    calls.length = 0;
    await printer.resetPrinter();
    const c = calls.map((x) => x[0]);
    assert.deepStrictEqual(c.slice(0, 4), ['1109', '1011', '1012', '1010']);
    assert.deepStrictEqual(calls[4], ['1003', 10000]);
    assert.strictEqual(c[5], '3004' + '21PAGAMENTO PER ANNULLO' + '000000250');
    assert.strictEqual(c[c.length - 1], '71020');
  });

  it('fase chiusura (1012=3): endFiscalReceiptbyReset; 1012=5 (solo taglio): 3013', async () => {
    const a = setup(nonRx('3'));
    await a.printer.connect();
    await a.printer.beginFiscalReceipt();
    docOpen = true;
    a.calls.length = 0;
    await a.printer.resetPrinter();
    assert.deepStrictEqual(a.cmds().slice(4), ['3011', '3013', '71020']);

    const b = setup(nonRx('5'));
    await b.printer.connect();
    await b.printer.beginFiscalReceipt();
    docOpen = true;
    b.calls.length = 0;
    await b.printer.resetPrinter();
    assert.deepStrictEqual(b.calls.slice(4), [['3013', 30000], ['71020', 8000]]);
  });

  it('RX fase chiusura: 310180100000000000 (8 s) oppure solo taglio', async () => {
    const rx = (phase: string): MockHandler => (docOpen = false, rtH((cmd) => (cmd === '1014' ? { data: '1601' } : cmd === '1012' ? { data: phase } : cmd === '1011' ? { data: docOpen ? '10' : '00' } : { data: '' }), RT_NOT_IN_SERVICE));
    const a = setup(rx('3'));
    await a.printer.connect();
    await a.printer.beginFiscalReceipt();
    docOpen = true;
    a.calls.length = 0;
    await a.printer.resetPrinter();
    assert.deepStrictEqual(a.calls.slice(4), [['310180100000000000', 8000], ['71020', 8000]]);
    const b = setup(rx('6'));
    await b.printer.connect();
    await b.printer.beginFiscalReceipt();
    docOpen = true;
    b.calls.length = 0;
    await b.printer.resetPrinter();
    assert.deepStrictEqual(b.calls.slice(4), [['3013', 30000], ['71020', 8000]]);
  });
});
