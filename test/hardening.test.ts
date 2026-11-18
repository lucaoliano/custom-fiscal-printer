import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as net from 'net';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import { ITransport } from '../src/transports/transport.interface';
import { TcpTransport } from '../src/transports/tcp.transport';
import { MockTransport } from '../src/transports/mock.transport';
import { FrameBuffer, FrameReader, extractFrame } from '../src/transports/frame-buffer';
import { buildFrame, parseRequest } from '../src/protocol/frame';
import { Mutex } from '../src/utils/mutex';
import {
  CustomFiscalError,
  CustomProtocolError,
  CustomTimeoutError,
  CUSTOM_ERROR_DESCRIPTIONS,
  classifyCustomError
} from '../src/errors';
import {
  sanitizeText,
  formatPrice,
  formatQuantity,
  formatDepartment,
  formatVat,
  formatNumberPad
} from '../src/utils/formatters';

/** Trasporto finto con risposte ritardate, per testare serializzazione e contatori. */
class FakeTransport implements ITransport {
  connected = true;
  wire: string[] = [];
  private queue: Buffer[] = [];
  private waiter: ((b: Buffer) => void) | null = null;
  flushCount = 0;
  /** delayFor(cmd, n) -> ritardo risposta in ms; null = nessuna risposta */
  constructor(private delayFor: (cmd: string, n: number) => number | null = () => 5) {}
  async connect() {}
  async close() {}
  isConnected() {
    return this.connected;
  }
  flush() {
    this.flushCount++;
    this.queue = [];
  }
  async write(data: Buffer) {
    const req = parseRequest(data);
    this.wire.push(req.command);
    const d = this.delayFor(req.command, this.wire.length - 1);
    if (d === null) return;
    // 1010/1011/1012 (stato documento) senza dati: l'eco del comando sarebbe letto come "documento aperto"
    const echo = ['1010', '1011', '1012'].includes(req.command) ? '' : req.command;
    setTimeout(() => this.deliver(buildFrame('0000' + echo, req.counter)), d);
  }
  deliver(b: Buffer) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(b);
    } else this.queue.push(b);
  }
  read(timeoutMs: number): Promise<Buffer> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        reject(new CustomTimeoutError('timeout', timeoutMs));
      }, timeoutMs);
      this.waiter = (b) => {
        clearTimeout(t);
        resolve(b);
      };
    });
  }
}

describe('Mutex e transazioni', () => {
  it('Mutex esegue le sezioni critiche in ordine e rilascia su errore', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const a = m.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const b = m
      .runExclusive(async () => {
        order.push(2);
        throw new Error('x');
      })
      .catch(() => order.push(3));
    const c = m.runExclusive(async () => {
      order.push(4);
    });
    await Promise.all([a, b, c]);
    assert.deepStrictEqual(order, [1, 2, 3, 4]);
  });

  it('i comandi concorrenti non si interlacciano sul filo', async () => {
    const t = new FakeTransport(() => 15);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false });
    await Promise.all([p.executeCommand('1008'), p.executeCommand('1013'), p.executeCommand('1014')]);
    assert.deepStrictEqual(t.wire, ['1008', '1013', '1014']);
  });

  it('transaction tiene fuori i comandi esterni fino alla fine', async () => {
    const t = new FakeTransport(() => 10);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false, autoIdentify: false });
    const tx = p.transaction(async (h) => {
      await h.beginFiscalReceipt({ lotteryCode: 'ABCD1234' }); // chiama setLotteryCode annidato
      await h.printRecItem({ description: 'Caffe', priceInCents: 120 });
      await h.printRecTotal({ amountInCents: 120 });
      await h.endFiscalReceipt();
      return 'ok';
    });
    await new Promise((r) => setTimeout(r, 1));
    const outside = p.getPrinterStatus(); // emesso mentre la transazione e' in corso
    assert.strictEqual(await tx, 'ok');
    await outside;
    assert.strictEqual(t.wire[t.wire.length - 1], '1109');
    // senza identificazione (RTMode 2) niente 71020/71021: controllo giornata (1010) e stato documento (1011), poi lotteria
    assert.deepStrictEqual(t.wire.slice(0, 3), ['1010', '1011', '301908ABCD1234']);
    // senza identificazione (autoIdentify: false) la chiusura e' sempre 3011 (30112 solo RX con RT in servizio)
    assert.strictEqual(t.wire.includes('3011'), true);
    assert.strictEqual(t.wire.includes('30112'), false);
  });

  it('un errore dentro la transazione rilascia il lock e le chiamate annidate non vanno in deadlock', async () => {
    const t = new FakeTransport(() => 2);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false });
    await assert.rejects(
      p.transaction(async (h) => {
        await h.printSimpleInvoice({ invoiceNumber: 1, taxId: 'X', customerLines: ['a'] }); // reset annidato
        await h.transaction(async (h2) => {
          await h2.reset();
        }); // transazione annidata
        throw new Error('boom');
      }),
      /boom/
    );
    await p.getPrinterStatus();
    assert.strictEqual(t.wire[t.wire.length - 1], '1109');
  });

  it('i metodi composti non vengono interlacciati con comandi esterni', async () => {
    const t = new FakeTransport(() => 8);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false, autoIdentify: false });
    const a = p.beginFiscalReceipt({ lotteryCode: 'ABCD1234' });
    const b = p.getPrinterStatus();
    await Promise.all([a, b]);
    assert.deepStrictEqual(t.wire, ['1010', '1011', '301908ABCD1234', '1109']);
  });
});

describe('Contatore e resync dopo timeout', () => {
  it('scarta la risposta tardiva di un comando andato in timeout', async () => {
    const t = new FakeTransport((cmd) => (cmd === '1109' ? 150 : 5));
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false });
    await assert.rejects(p.executeCommand('1109', 40), CustomTimeoutError);
    await new Promise((r) => setTimeout(r, 200)); // la risposta tardiva e' ora in coda
    const r = await p.executeCommand('1008');
    assert.strictEqual(r.data, '1008'); // non '1109'
  });

  it('frame obsoleto che arriva durante la lettura viene scartato entro il timeout residuo', async () => {
    const t = new FakeTransport(() => null);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false });
    const pr = p.executeCommand('1008', 500);
    await new Promise((r) => setTimeout(r, 10));
    t.deliver(buildFrame('0000STALE', 77)); // contatore diverso
    setTimeout(() => t.deliver(buildFrame('0000GOOD', 1)), 20); // primo contatore usato = 1
    const r = await pr;
    assert.strictEqual(r.data, 'GOOD');
  });

  it('chiama flush() prima di ogni scrittura e non ritenta mai', async () => {
    const t = new FakeTransport(() => null);
    const p = new CustomFiscalPrinter(t, { statusPolling: false, identifyOnConnect: false });
    await assert.rejects(p.executeCommand('1008', 30), CustomTimeoutError);
    assert.strictEqual(t.flushCount, 1);
    assert.strictEqual(t.wire.length, 1);
  });

  it('MockTransport riecheggia il contatore della richiesta', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    for (let i = 0; i < 3; i++) await p.executeCommand('1008');
    assert.strictEqual(m.sentCommands.length, 3);
  });
});

describe('Classificazione errori', () => {
  it('16 -> PAPER_EMPTY, 64 -> COVER_OPEN, 8 -> BUSY retryable', () => {
    const e16 = new CustomFiscalError(16, 'ERR16');
    assert.strictEqual(e16.kind, 'PAPER_EMPTY');
    assert.strictEqual(e16.retryable, false);
    assert.match(e16.message, /Carta esaurita/);
    const e64 = new CustomFiscalError(64, 'ERR64');
    assert.strictEqual(e64.kind, 'COVER_OPEN');
    assert.match(e64.message, /Coperchio aperto/);
    const e8 = new CustomFiscalError(8, 'ERR08');
    assert.strictEqual(e8.kind, 'BUSY');
    assert.strictEqual(e8.retryable, true);
  });

  it('mappatura completa verificata sul driver Java', () => {
    const expected: Record<string, number[]> = {
      TECHNICAL_ASSISTANCE: [2, 6, 15, 18, 19, 65, 66, 67, 68],
      ILLEGAL: [3, 5, 9, 24, 25, 30, 31, 32, 33, 35, 36, 40, 52, 53, 57],
      WRONG_STATE: [4, 54, 55, 21, 99, 1000],
      WORD_NOT_ALLOWED: [7],
      BUSY: [8],
      RECEIPT_TOTAL_OVERFLOW: [10],
      BAD_ITEM_AMOUNT: [11],
      BAD_DATE: [12, 13, 14, 22],
      PAPER_EMPTY: [16],
      MISSING_DEVICES: [17, 56],
      COMMUNICATION: [20],
      NEGATIVE_TOTAL: [23],
      FISCAL_MEMORY_DISCONNECTED: [50],
      FISCAL_MEMORY_FULL: [51],
      COVER_OPEN: [64]
    };
    for (const [kind, codes] of Object.entries(expected)) {
      for (const c of codes) assert.strictEqual(classifyCustomError(c), kind, `codice ${c}`);
    }
    assert.ok(CUSTOM_ERROR_DESCRIPTIONS[16]);
  });

  it('policy java: ERR05 ignorato tranne su vendite/pagamenti/non pagato', async () => {
    const m = new MockTransport(() => ({ error: 5 }));
    const warnings: string[] = [];
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, logger: { warn: (msg) => warnings.push(msg) } });
    await p.connect();
    for (const cmd of ['3011', '71020', '3003', '30160']) {
      const r = await p.executeCommand(cmd);
      assert.strictEqual(r.isError, false, cmd);
      assert.strictEqual(r.ignoredErrorCode, 5, cmd);
    }
    assert.strictEqual(warnings.length, 4);
    for (const cmd of ['33011000001000', '300408Contanti000000100', '3007010008Contanti', '3005']) {
      await assert.rejects(
        p.executeCommand(cmd),
        (e: any) => e instanceof CustomFiscalError && e.code === 5 && e.kind === 'ILLEGAL',
        cmd
      );
    }
  });

  it('policy java: ERR03 ignorato tranne su 3301x / 71023 / 7102A / 7102R', async () => {
    const m = new MockTransport(() => ({ error: 3 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    assert.strictEqual((await p.executeCommand('3003')).ignoredErrorCode, 3);
    for (const cmd of ['33011000001000', '7102300001', '7102A0001', '7102R0001']) {
      await assert.rejects(p.executeCommand(cmd), (e: any) => e.code === 3, cmd);
    }
  });

  it('policy java: ERR56/57/85 ignorati solo su 30160/30161', async () => {
    const m = new MockTransport(() => ({ error: 57 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    assert.strictEqual((await p.executeCommand('30161')).ignoredErrorCode, 57);
    await assert.rejects(p.executeCommand('3003'), (e: any) => e.code === 57);
  });

  it('policy strict: ogni errore viene propagato', async () => {
    const m = new MockTransport(() => ({ error: 5 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, errorPolicy: 'strict' });
    await p.connect();
    await assert.rejects(p.executeCommand('3011'), (e: any) => e.code === 5);
    await assert.rejects(p.executeCommand('71020'), (e: any) => e.code === 5);
  });

  it('ERR99 interroga 1015 sotto lo stesso lock', async () => {
    const m = new MockTransport((cmd) => (cmd === '1015' ? { data: '0042' } : { error: 99 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    await assert.rejects(p.executeCommand('3003'), (e: any) => e.extendedCode === 42);
    assert.deepStrictEqual(m.sentCommands, ['3003', '1015']);
  });

  it('ERR99: codice esteso letto anche se 1015 risponde in formato ERRxxx', async () => {
    const m = new MockTransport((cmd) => (cmd === '1015' ? { error: 123 } : { error: 99 }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    await assert.rejects(p.executeCommand('3003'), (e: any) => e.code === 99 && e.extendedCode === 123);
  });
});

describe('Sanitizzazione testo e frame', () => {
  it('sanitizeText traslittera e converte il simbolo euro', () => {
    assert.strictEqual(sanitizeText('10€'), '10\x7F');
    assert.strictEqual(sanitizeText('l’“uno” – due… x y z'), 'l\'"uno" - due... x y z');
    assert.strictEqual(sanitizeText('Caffè'), 'Caffè');
  });

  it('sanitizeText rifiuta caratteri di controllo e non latin1', () => {
    for (const bad of ['a\x03b', 'a\x02b', 'a\x1Bb', 'a\x00b', 'a\x7Fb', 'a\x85b', '日本', '\u{1F600}']) {
      assert.throws(() => sanitizeText(bad), RangeError, JSON.stringify(bad));
    }
  });

  it('buildFrame rifiuta ETX/STX/byte di controllo nel payload', () => {
    assert.throws(() => buildFrame('3002\x03xx', 1), CustomProtocolError);
    assert.throws(() => buildFrame('3002\x02xx', 1), CustomProtocolError);
    assert.throws(() => buildFrame('3002\x1Bxx', 1), CustomProtocolError);
    assert.doesNotThrow(() => buildFrame('3002\x7Fxx', 1));
  });

  it('i campi testo utente non possono iniettare ETX', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, documentStateChecks: false });
    await p.connect();
    await assert.rejects(p.printRecItem({ description: 'A\x03B', priceInCents: 100 }), RangeError);
    await assert.rejects(p.displayText('x\x03'), RangeError);
    await assert.rejects(p.setHeaderLine(1, 'a\x02'), RangeError);
    await assert.rejects(p.printNormal('ciao\x1B[x'), RangeError);
    assert.strictEqual(m.sentCommands.length, 0);
  });
});

describe('Validazione input', () => {
  it('formatter lanciano RangeError', () => {
    for (const v of [NaN, Infinity, -1, 1.5, 1000000000]) assert.throws(() => formatPrice(v), RangeError, String(v));
    for (const v of [NaN, 0, -1, Infinity, 1e7]) assert.throws(() => formatQuantity(v), RangeError, String(v));
    assert.throws(() => formatDepartment(1000), RangeError);
    assert.throws(() => formatDepartment(-1), RangeError);
    assert.throws(() => formatVat(0), RangeError);
    assert.throws(() => formatVat(10), RangeError);
    assert.throws(() => formatNumberPad(12345, 4), RangeError);
    assert.throws(() => formatNumberPad(-1, 4), RangeError);
    assert.throws(() => formatNumberPad('12a', 4), RangeError);
    assert.strictEqual(formatNumberPad('7', 4), '0007');
  });

  it('client: reparto, lotteria, intestazioni, aliquote, sconti', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    await assert.rejects(p.printRecItem({ description: 'a', priceInCents: 1, department: 100 }), RangeError);
    await assert.rejects(p.printRecItem({ description: 'a', priceInCents: 1, vatRate: 0 }), RangeError);
    await assert.rejects(p.setLotteryCode('ABC'), RangeError);
    await assert.rejects(p.setLotteryCode('ABCD123!'), RangeError);
    await assert.rejects(p.beginFiscalReceipt({ lotteryCode: 'short' }), RangeError);
    await assert.rejects(p.setHeaderLine(0, 'x'), RangeError);
    await assert.rejects(p.setHeaderLine(10, 'x'), RangeError);
    await assert.rejects(p.setHeaderLineCount(0), RangeError);
    await assert.rejects(p.setHeaderLineCount(10), RangeError);
    await assert.rejects(p.setVatTable([100]), RangeError);
    await assert.rejects(p.setVatTable([1, 2, 3, 4, 5, 6, 7]), RangeError);
    await assert.rejects(p.setVatTable([-1]), RangeError);
    await assert.rejects(p.printRecItemAdjustment({ type: 'DISCOUNT', description: 'x', amountInCents: 0 }), RangeError);
    await assert.rejects(p.printRecItemAdjustment({ type: 'DISCOUNT', description: 'x', amountInCents: -5 }), RangeError);
    assert.strictEqual(m.sentCommands.length, 0);
  });

  it('printRecItem: unitPriceInCents obbligatorio con quantity !== 1 e inviato in 33011', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, documentStateChecks: false });
    await p.connect();
    await assert.rejects(p.printRecItem({ description: 'Mele', priceInCents: 300, quantity: 1.5 }), RangeError);
    await p.printRecItem({
      description: 'Mele',
      priceInCents: 300,
      quantity: 1.5,
      unitPriceInCents: 200,
      unitName: 'Kg'
    });
    const detail = m.sentCommands.find((c) => c.startsWith('30021'))!;
    assert.match(detail, /^30021131,5 Kg x 2,00$/); // '3002' + pitch '1' + len(13) + riga Java (virgola decimale, niente '€')
    const sale = m.sentCommands.find((c) => c.startsWith('33011'))!;
    assert.ok(sale.endsWith('0000002001'), sale); // prezzo unitario 200 + IVA 1
  });
});

describe('Frame buffer e trasporti', () => {
  it('extractFrame cerca ETX dopo STX e scarta il rumore iniziale', () => {
    const noisy = Buffer.concat([
      Buffer.from([0x06, 0x03, 0x41]),
      Buffer.from([0x02, 0x30, 0x31, 0x03]),
      Buffer.from([0x99])
    ]);
    const { frame, rest } = extractFrame(noisy);
    assert.deepStrictEqual([...frame!], [0x02, 0x30, 0x31, 0x03]);
    assert.deepStrictEqual([...rest], [0x99]);
  });

  it('FrameBuffer gestisce chunk spezzati', () => {
    const fb = new FrameBuffer();
    fb.push(Buffer.from([0x03, 0x02, 0x41]));
    assert.strictEqual(fb.take(), null);
    fb.push(Buffer.from([0x42, 0x03, 0x02, 0x43]));
    assert.strictEqual(fb.take()!.toString('latin1'), '\x02AB\x03');
    assert.strictEqual(fb.take(), null);
    fb.push(Buffer.from([0x03]));
    assert.strictEqual(fb.take()!.toString('latin1'), '\x02C\x03');
  });

  it('FrameBuffer limita la dimensione dell accumulatore', () => {
    const fb = new FrameBuffer(100);
    assert.throws(() => fb.push(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(200, 0x41)])), CustomProtocolError);
    assert.strictEqual(fb.length, 0);
  });

  it('FrameReader: lettura pendente rifiutata subito con failAll', async () => {
    const r = new FrameReader();
    const started = Date.now();
    const p = r.read(5000, () => new CustomTimeoutError('t', 5000));
    r.failAll(new Error('chiuso'));
    await assert.rejects(p, /chiuso/);
    assert.ok(Date.now() - started < 500);
  });

  it('TcpTransport: read pendente rifiutata subito se il server chiude il socket', async () => {
    const srv = net.createServer((s) => {
      setTimeout(() => s.destroy(), 30);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    const t = new TcpTransport('127.0.0.1', port, 5000);
    await t.connect();
    const started = Date.now();
    await assert.rejects(t.read(5000), (e: any) => !(e instanceof CustomTimeoutError));
    assert.ok(Date.now() - started < 2000);
    await t.close();
    srv.close();
  });

  it('TcpTransport: close() rifiuta le letture pendenti', async () => {
    const srv = net.createServer(() => {});
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    const t = new TcpTransport('127.0.0.1', port, 5000);
    await t.connect();
    const assertion = assert.rejects(t.read(5000), /chiuso/);
    await t.close();
    await assertion;
    srv.close();
  });

  it('TcpTransport end-to-end: rumore con ETX prima dello STX e frame spezzato', async () => {
    const srv = net.createServer((s) => {
      s.on('data', () => {
        const f = buildFrame('0000OK', 1);
        s.write(Buffer.concat([Buffer.from([0x06, 0x03]), f.subarray(0, 4)]));
        setTimeout(() => s.write(f.subarray(4)), 20);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    const p = new CustomFiscalPrinter({ type: 'tcp', host: '127.0.0.1', port }, { statusPolling: false, identifyOnConnect: false });
    await p.connect();
    const r = await p.executeCommand('1008', 1000);
    assert.strictEqual(r.data, 'OK');
    await p.disconnect();
    srv.close();
  });
});

describe('Checksum risposte', () => {
  const badChecksumFrame = (counter: number) => {
    const f = Buffer.from(buildFrame('0000ABC', counter));
    const cksPos = f.length - 4; // ... Cks(2) ETX NUL
    f[cksPos] = f[cksPos] === 0x30 ? 0x31 : 0x30;
    return f;
  };

  it('policy warn (default): risposta accettata e segnalata', async () => {
    const m = new MockTransport();
    const warnings: string[] = [];
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, logger: { warn: (msg) => warnings.push(msg) } });
    await p.connect();
    m.queueResponse(badChecksumFrame(1));
    const r = await p.executeCommand('1008');
    assert.strictEqual(r.data, 'ABC');
    assert.strictEqual(r.checksumValid, false);
    assert.ok(warnings.some((w) => w.includes('Checksum')));
  });

  it('policy strict: CustomProtocolError', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, checksumPolicy: 'strict' });
    await p.connect();
    m.queueResponse(badChecksumFrame(1));
    await assert.rejects(p.executeCommand('1008'), (e: any) => e instanceof CustomProtocolError);
  });

  it('frame valido: checksumValid true', async () => {
    const m = new MockTransport();
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, checksumPolicy: 'strict' });
    await p.connect();
    assert.strictEqual((await p.executeCommand('1008')).checksumValid, true);
  });
});

describe('Attesa operazioni pendenti (1513)', () => {
  it('Z-report invia 2002 e poi 1513', async () => {
    const m = new MockTransport(() => ({ data: '' }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0 });
    await p.connect();
    await p.printZReport();
    assert.deepStrictEqual(m.sentCommands, ['2002', '1513']);
  });

  it('1513 ripetuto fino a 3 volte solo in caso di errore', async () => {
    let failures = 2;
    const m = new MockTransport((cmd) => (cmd === '1513' && failures-- > 0 ? { error: 8 } : { data: '' }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0 });
    await p.connect();
    await p.printZReport();
    assert.deepStrictEqual(m.sentCommands, ['2002', '1513', '1513', '1513']);
  });

  it('al terzo errore 1513 l\'eccezione viene propagata', async () => {
    const m = new MockTransport((cmd) => (cmd === '1513' ? { error: 8 } : { data: '' }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0 });
    await p.connect();
    await assert.rejects(p.printZReport(), (e: any) => e instanceof CustomFiscalError && e.kind === 'BUSY');
    assert.strictEqual(m.sentCommands.filter((c) => c === '1513').length, 3);
  });

  it('beginTraining / endTraining attendono come il driver Java', async () => {
    const m = new MockTransport(() => ({ data: '' }));
    const p = new CustomFiscalPrinter(m, { statusPolling: false, identifyOnConnect: false, pendingOperationDelayMs: 0 });
    await p.connect();
    await p.beginTraining();
    await p.endTraining();
    assert.deepStrictEqual(m.sentCommands, ['64300', '1513', '64301', '1513']);
  });
});
