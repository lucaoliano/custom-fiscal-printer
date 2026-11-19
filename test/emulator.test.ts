import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import {
  CustomConnectionError,
  CustomFiscalError,
  CustomOperationNotAllowedError,
  CustomTimeoutError
} from '../src/errors';
import { TcpTransport } from '../src/transports/tcp.transport';
import { EmulatedPrinter, EmulatorOptions, EmulatorTransport, startEmulatorServer, EmulatorServer } from '../src/emulator';
import { parseFault } from '../src/emulator/cli';

const QUIET = { statusPolling: false, pendingOperationDelayMs: 0, headerLineDelayMs: 0 } as const;

function rig(options?: EmulatorOptions) {
  const emu = new EmulatedPrinter(options);
  const transport = new EmulatorTransport(emu);
  const printer = new CustomFiscalPrinter(transport, QUIET);
  return { emu, transport, printer };
}

/** Vendita completa: righe, un pagamento per elemento di `payments`, chiusura. */
async function sell(
  printer: CustomFiscalPrinter,
  items: { description: string; priceInCents: number; vatRate?: number }[],
  payments: { amountInCents: number; paymentId?: number; description?: string }[]
) {
  const total = items.reduce((s, i) => s + i.priceInCents, 0);
  await printer.transaction(async (tx) => {
    await tx.beginFiscalReceipt();
    for (const item of items) await tx.printRecItem(item);
    for (const [i, p] of payments.entries()) {
      await tx.printRecTotal({ ...p, ...(i === 0 ? { expectedTotalInCents: total } : {}) });
    }
    await tx.endFiscalReceipt();
  });
}

const flow = ['30160', '1013', '1014', '1511'];

describe('emulatore: vendite', () => {
  it('vendita in contanti: il totale controllato con 1003 è quello vero e il documento è emesso', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await sell(
      printer,
      [
        { description: 'Occhiale da sole', priceInCents: 12000, vatRate: 1 },
        { description: 'Custodia', priceInCents: 1050, vatRate: 2 }
      ],
      [{ amountInCents: 13050 }]
    );
    assert.deepStrictEqual(emu.unknownCommands, []);
    assert.deepStrictEqual(emu.commandLog.slice(0, flow.length), flow);
    assert.strictEqual(emu.documents.length, 1);
    const doc = emu.documents[0];
    assert.strictEqual(doc.kind, 'sale');
    assert.strictEqual(doc.totalCents, 13050);
    assert.strictEqual(doc.number, 1);
    assert.strictEqual(doc.zReport, 1);
    assert.deepStrictEqual(
      doc.lines.map((l) => l.vatRatePercent),
      [22, 10]
    );
    assert.strictEqual(emu.snapshot().phase, null, 'dopo il taglio non resta nessun documento');
    const daily = await printer.readDailyTotals();
    assert.strictEqual(daily.receiptNumber, 1);
    assert.strictEqual(daily.dailyTotal, 13050);
  });

  it('quantità e prezzo unitario: il totale di riga è arrotondato come fa il gestionale', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.transaction(async (tx) => {
      await tx.beginFiscalReceipt();
      await tx.printRecItem({ description: 'Lenti', priceInCents: 1000, quantity: 2.5, unitPriceInCents: 400, vatRate: 1 });
      await tx.printRecTotal({ amountInCents: 1000, expectedTotalInCents: 1000 });
      await tx.endFiscalReceipt();
    });
    assert.strictEqual(emu.documents[0].totalCents, 1000);
    assert.strictEqual(emu.documents[0].lines[0].quantityThousandths, 2500);
    assert.deepStrictEqual(emu.unknownCommands, []);
  });

  it('pagamento con carta su forma di pagamento programmata (3007)', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await sell(printer, [{ description: 'Occhiale', priceInCents: 20000 }], [{ amountInCents: 20000, paymentId: 2, description: 'Carta' }]);
    assert.deepStrictEqual(
      emu.documents[0].payments.map((p) => [p.form, p.amountCents, p.description]),
      [[2, 20000, 'Carta']]
    );
    assert.ok(emu.commandLog.some((c) => c.startsWith('3007')));
    assert.ok(!emu.commandLog.some((c) => c.startsWith('3004')));
  });

  it('pagamenti multipli con resto sul contante', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await sell(
      printer,
      [{ description: 'Occhiale', priceInCents: 3000 }],
      [
        { amountInCents: 1000, paymentId: 2, description: 'Carta' },
        { amountInCents: 2500, description: 'Contanti' }
      ]
    );
    const doc = emu.documents[0];
    assert.strictEqual(doc.totalCents, 3000);
    assert.strictEqual(doc.changeCents, 500);
    assert.strictEqual(doc.payments.length, 2);
  });

  it('totale atteso diverso da quello della stampante: errore 212, nessun documento, stampante libera', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await assert.rejects(
      printer.transaction(async (tx) => {
        await tx.beginFiscalReceipt();
        await tx.printRecItem({ description: 'Occhiale', priceInCents: 5000 });
        await tx.printRecTotal({ amountInCents: 5000, expectedTotalInCents: 4000 });
      }),
      (e: unknown) => e instanceof CustomOperationNotAllowedError && e.extendedJposCode === 212
    );
    assert.strictEqual(emu.documents.length, 0);
    assert.strictEqual(emu.snapshot().phase, null);
    assert.strictEqual(emu.snapshot().midVoidCents, 5000);
  });

  it('chiusura con pagamento incompleto rifiutata dalla stampante, non dal client', () => {
    const { emu } = rig();
    emu.handle('71021');
    emu.handle(`33011000001000000${'18Occhiale          '.slice(0, 20)}${'000005000'}1`);
    assert.strictEqual(emu.snapshot().totalCents, 5000);
    assert.strictEqual(emu.handle('3011').error, 4);
    assert.strictEqual(emu.documents.length, 0);
  });
});

describe('emulatore: stretto sui comandi', () => {
  it('un comando sconosciuto è un errore e finisce in unknownCommands', () => {
    const emu = new EmulatedPrinter();
    const reply = emu.handle('9999');
    assert.strictEqual(reply.error, 9);
    assert.deepStrictEqual(emu.unknownCommands, ['9999']);
  });

  it('aliquota non programmata, forma di pagamento inesistente e righe malformate sono rifiutate', () => {
    const emu = new EmulatedPrinter();
    emu.handle('71021');
    const item = (vat: number) => `33011000001000000${'18Occhiale          '.slice(0, 20)}000005000${vat}`;
    assert.strictEqual(emu.handle(item(7)).error, 9);
    assert.strictEqual(emu.handle(item(0)).error, 9);
    assert.strictEqual(emu.handle('33011xyz').error, 9);
    assert.strictEqual(emu.handle(item(1)).error, undefined);
    assert.strictEqual(emu.handle('30071100' + '05Carta' + '000005000').error, 9, 'forma 11 non programmata');
    assert.strictEqual(emu.snapshot().totalCents, 5000);
  });

  it('totale oltre il limite e negativo sono rifiutati', () => {
    const emu = new EmulatedPrinter();
    emu.handle('71021');
    const line = (cmd: string, amount: number) => `${cmd}000001000000${'05Extra   '.slice(0, 7)}${String(amount).padStart(9, '0')}1`;
    assert.strictEqual(emu.handle(line('33012', 100)).error, undefined);
    assert.strictEqual(emu.handle(line('33013', 200)).error, 23);
    assert.strictEqual(emu.handle(line('33012', 999999999)).error, 10);
  });

  it('un frame con checksum errato sul TCP viene scartato e contato', async () => {
    const server = await startEmulatorServer();
    try {
      const net = await import('net');
      const socket = net.connect(server.port, server.host);
      await new Promise<void>((r) => socket.once('connect', () => r()));
      socket.write(Buffer.from('\x0201001013ZZ\x03\x00', 'latin1'));
      await new Promise((r) => setTimeout(r, 50));
      socket.destroy();
      assert.strictEqual(server.badFrames.length, 1);
      assert.deepStrictEqual(server.printer.commandLog, []);
    } finally {
      await server.close();
    }
  });
});

describe('emulatore: reso e annullo', () => {
  async function withSale() {
    const r = rig();
    await r.printer.connect();
    await sell(r.printer, [{ description: 'Occhiale', priceInCents: 12000 }], [{ amountInCents: 12000 }]);
    const doc = r.emu.documents[0];
    const docRef = { zReport: doc.zReport, ticketNumber: doc.number, date: doc.date };
    return { ...r, doc, docRef };
  }

  it('reso: documento aperto, righe rese, chiusura; il documento originale resta valido', async () => {
    const { emu, printer, docRef, doc } = await withSale();
    const r = await printer.printRefundReceipt({ docRef, deviceSerial: 'EMULATORE01' });
    assert.deepStrictEqual(r, { emitted: true, documentOpen: true });
    await printer.printRecItem({ description: 'Occhiale', priceInCents: 12000 });
    await printer.printRecTotal({ amountInCents: 12000 });
    await printer.endFiscalReceipt();
    assert.strictEqual(emu.documents.length, 2);
    assert.strictEqual(emu.documents[1].kind, 'refund');
    assert.strictEqual(emu.documents[1].reference?.number, doc.number);
    assert.strictEqual(emu.snapshot().refundTotalCents, 12000);
    assert.strictEqual(doc.voided, false);
    assert.deepStrictEqual(emu.unknownCommands, []);
  });

  it('reso oltre l’importo del documento: la stampante rifiuta la chiusura (ERR 11)', async () => {
    const { emu, printer, docRef } = await withSale();
    await printer.printRefundReceipt({ docRef, deviceSerial: 'EMULATORE01' });
    await printer.printRecItem({ description: 'Occhiale', priceInCents: 12001 });
    await printer.printRecTotal({ amountInCents: 12001 });
    await assert.rejects(printer.endFiscalReceipt(), (e: unknown) => e instanceof CustomFiscalError && e.code === 11);
    assert.strictEqual(emu.documents.length, 1, 'nessun reso emesso');
  });

  it('annullo: si completa da solo e un secondo annullo è rifiutato', async () => {
    const { emu, printer, docRef, doc } = await withSale();
    const r = await printer.printVoidReceipt({ docRef, deviceSerial: 'EMULATORE01' });
    assert.strictEqual(r.documentOpen, false);
    assert.strictEqual(doc.voided, true);
    assert.deepStrictEqual(
      emu.documents.map((d) => d.kind),
      ['sale', 'void']
    );
    await assert.rejects(
      printer.printVoidReceipt({ docRef, deviceSerial: 'EMULATORE01' }),
      (e: unknown) => e instanceof CustomOperationNotAllowedError
    );
    assert.strictEqual(emu.documents.length, 2);
  });

  it('riferimento a un documento inesistente: operazione non consentita', async () => {
    const { printer, doc } = await withSale();
    await assert.rejects(
      printer.printRefundReceipt({ docRef: { zReport: doc.zReport, ticketNumber: 99, date: doc.date }, deviceSerial: 'EMULATORE01' }),
      (e: unknown) => e instanceof CustomOperationNotAllowedError
    );
  });

  it('RT non in servizio: reso e annullo non vengono emessi', async () => {
    const r = rig({ rtInService: false });
    await r.printer.connect();
    const out = await r.printer.printVoidReceipt({
      docRef: { zReport: 1, ticketNumber: 1, date: '010126' },
      deviceSerial: 'EMULATORE01'
    });
    assert.strictEqual(out.emitted, false);
    assert.strictEqual(r.emu.documents.length, 0);
  });
});

describe('emulatore: chiusure', () => {
  it('lettura X non azzera nulla; Z azzera il contatore e passa al numero successivo', async () => {
    const { emu, printer } = rig({ lastZ: 6 });
    await printer.connect();
    await sell(printer, [{ description: 'A', priceInCents: 1000 }], [{ amountInCents: 1000 }]);
    await printer.printXReport();
    assert.strictEqual((await printer.readDailyTotals()).receiptNumber, 1);
    assert.strictEqual(emu.snapshot().xReports, 1);
    assert.strictEqual(await printer.getZReportNumber(), 6);
    assert.strictEqual(emu.documents[0].zReport, 7, 'il documento appartiene al prossimo Z');

    await printer.printZReport();
    assert.strictEqual(await printer.getZReportNumber(), 7);
    const daily = await printer.readDailyTotals();
    assert.deepStrictEqual([daily.receiptNumber, daily.dailyTotal], [0, 0]);

    await sell(printer, [{ description: 'B', priceInCents: 500 }], [{ amountInCents: 500 }]);
    assert.strictEqual(emu.documents[1].zReport, 8);
    assert.strictEqual(emu.documents[1].number, 1);
    assert.deepStrictEqual(emu.unknownCommands, []);
  });

  it('un documento del giorno prima si può ancora rendere dopo lo Z', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await sell(printer, [{ description: 'A', priceInCents: 1000 }], [{ amountInCents: 1000 }]);
    const doc = emu.documents[0];
    await printer.printZReport();
    const r = await printer.printRefundReceipt({
      docRef: { zReport: doc.zReport, ticketNumber: doc.number, date: doc.date },
      deviceSerial: 'EMULATORE01'
    });
    assert.strictEqual(r.emitted, true);
  });

  it('lo Z con un documento aperto è rifiutato dalla stampante', () => {
    const emu = new EmulatedPrinter();
    emu.handle('71021');
    assert.strictEqual(emu.handle('2002').error, 4);
  });

  it('documento non fiscale', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.beginNonFiscal();
    await printer.printNormal('Promemoria');
    assert.strictEqual(emu.snapshot().nonFiscalOpen, true);
    await printer.endNonFiscal();
    assert.strictEqual(emu.snapshot().nonFiscalOpen, false);
    assert.deepStrictEqual(emu.unknownCommands, []);
  });
});

describe('emulatore: guasti della stampante', () => {
  it('carta esaurita e coperchio aperto: ERR 16 / 64 e stato letto da 1109', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    emu.setPaper({ empty: true });
    assert.strictEqual((await printer.getPrinterStatus()).paperEmpty, true);
    await printer.beginFiscalReceipt();
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomFiscalError && e.code === 16 && e.kind === 'PAPER_EMPTY'
    );
    emu.setPaper({ empty: false });
    emu.setCoverOpen(true);
    assert.strictEqual((await printer.getPrinterStatus()).coverOpen, true);
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomFiscalError && e.code === 64 && e.kind === 'COVER_OPEN'
    );
    emu.setCoverOpen(false);
    await printer.printRecItem({ description: 'A', priceInCents: 100 });
    assert.strictEqual(emu.snapshot().totalCents, 100);
  });

  it('errore iniettato: il comando non viene eseguito e il guasto si consuma', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    emu.inject('33011', { kind: 'error', code: 8 });
    await printer.beginFiscalReceipt();
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomFiscalError && e.code === 8 && e.retryable
    );
    assert.strictEqual(emu.snapshot().totalCents, 0);
    await printer.printRecItem({ description: 'A', priceInCents: 100 });
    assert.strictEqual(emu.snapshot().totalCents, 100);
  });

  it('errore esteso 99: il client legge il codice con 1015', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    emu.inject('33011', { kind: 'error', code: 99, extendedCode: 123 });
    await printer.beginFiscalReceipt();
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomFiscalError && e.code === 99 && e.extendedCode === 123
    );
  });

  it('silenzio: timeout con sent=true, ma il comando è stato eseguito', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.beginFiscalReceipt();
    emu.inject('33011', { kind: 'silence' });
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomTimeoutError && e.sent === true
    );
    assert.strictEqual(emu.snapshot().totalCents, 100);
  });

  it('risposta in ritardo oltre il timeout: timeout; entro il timeout: riuscita', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.beginFiscalReceipt();
    emu.inject('33011', { kind: 'delay', ms: 60_000 });
    await assert.rejects(printer.printRecItem({ description: 'A', priceInCents: 100 }), CustomTimeoutError);
    emu.inject('33011', { kind: 'delay', ms: 10 });
    await printer.printRecItem({ description: 'B', priceInCents: 100 });
    assert.strictEqual(emu.snapshot().totalCents, 200);
  });
});

describe('emulatore: recupero con resetPrinter', () => {
  /** Un nuovo client sulla stessa stampante: come un riavvio dell'applicazione. */
  const restart = (emu: EmulatedPrinter) => new CustomFiscalPrinter(new EmulatorTransport(emu), QUIET);

  it('scontrino lasciato aperto nella vendita: viene abbandonato, nessun documento', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecItem({ description: 'A', priceInCents: 1000 });
    assert.strictEqual(emu.snapshot().phase, 'sale');

    const again = restart(emu);
    await again.connect();
    await again.resetPrinter();
    assert.strictEqual(emu.snapshot().phase, null);
    assert.strictEqual(emu.documents.length, 0);
    await sell(again, [{ description: 'B', priceInCents: 500 }], [{ amountInCents: 500 }]);
    assert.strictEqual(emu.documents.length, 1);
  });

  it('pagamento a metà: il recupero abbandona lo scontrino non emesso', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    await printer.beginFiscalReceipt();
    await printer.printRecItem({ description: 'A', priceInCents: 3000 });
    await printer.printRecTotal({ amountInCents: 1000, paymentId: 2 });
    assert.strictEqual(emu.snapshot().phase, 'payment');

    const again = restart(emu);
    await again.connect();
    await again.resetPrinter();
    assert.strictEqual(emu.snapshot().phase, null);
    assert.strictEqual(emu.documents.length, 0);
  });

  it('emesso ma non tagliato (3013 non arrivata): il recupero fa solo il taglio e non emette due volte', async () => {
    const { emu, printer } = rig();
    await printer.connect();
    emu.inject('3013', { kind: 'lose-command' });
    await assert.rejects(sell(printer, [{ description: 'A', priceInCents: 1000 }], [{ amountInCents: 1000 }]), CustomConnectionError);
    assert.strictEqual(emu.documents.length, 1, 'il documento è già emesso');
    assert.strictEqual(emu.snapshot().phase, 'emitted');

    const again = restart(emu);
    await again.connect();
    await again.resetPrinter();
    assert.strictEqual(emu.snapshot().phase, null);
    assert.strictEqual(emu.documents.length, 1);
    assert.deepStrictEqual(emu.unknownCommands, []);
  });
});

describe('emulatore su TCP', () => {
  let server: EmulatorServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const connect = async (opts?: EmulatorOptions) => {
    server = await startEmulatorServer(opts);
    const printer = new CustomFiscalPrinter(new TcpTransport('127.0.0.1', server.port, 2000), QUIET);
    await printer.connect();
    return { server, printer, emu: server.printer };
  };

  it('vendita completa, X e Z sul socket', async () => {
    const { printer, emu } = await connect();
    await sell(printer, [{ description: 'Occhiale', priceInCents: 9900 }], [{ amountInCents: 10000 }]);
    await printer.printXReport();
    await printer.printZReport();
    assert.strictEqual(emu.documents[0].changeCents, 100);
    assert.strictEqual(await printer.getZReportNumber(), 1);
    assert.deepStrictEqual(emu.unknownCommands, []);
    assert.deepStrictEqual(server!.badFrames, []);
    await printer.disconnect();
  });

  it('risposta persa dopo l’esecuzione: sent=true ed esito ignoto, ma il documento È stato emesso', async () => {
    const { printer, emu } = await connect();
    emu.inject('3011', { kind: 'lose-reply' });
    await assert.rejects(
      sell(printer, [{ description: 'A', priceInCents: 1000 }], [{ amountInCents: 1000 }]),
      (e: unknown) => e instanceof CustomConnectionError && e.sent === true
    );
    assert.strictEqual(emu.documents.length, 1);
  });

  it('comando perso prima dell’esecuzione: stesso errore del client, ma il documento NON è stato emesso', async () => {
    const { printer, emu } = await connect();
    emu.inject('3011', { kind: 'lose-command' });
    await assert.rejects(
      sell(printer, [{ description: 'A', priceInCents: 1000 }], [{ amountInCents: 1000 }]),
      (e: unknown) => e instanceof CustomConnectionError && e.sent === true
    );
    assert.strictEqual(emu.documents.length, 0);
    assert.strictEqual(emu.snapshot().phase, 'paid');
  });

  it('risposta troncata: il client non la scambia per una risposta valida', async () => {
    const { printer, emu } = await connect();
    await printer.beginFiscalReceipt();
    emu.inject('33011', { kind: 'truncate-reply' });
    await assert.rejects(
      printer.printRecItem({ description: 'A', priceInCents: 100 }),
      (e: unknown) => e instanceof CustomConnectionError && e.sent === true
    );
    assert.strictEqual(emu.snapshot().totalCents, 100);
  });

  it('close() chiude anche le connessioni aperte', async () => {
    const { printer } = await connect();
    assert.strictEqual(server!.connections(), 1);
    await server!.close();
    server = undefined;
    await printer.disconnect();
  });
});

describe('emulatore: riga di comando', () => {
  it('parseFault', () => {
    assert.deepStrictEqual(parseFault('3011:lose-reply'), { prefix: '3011', fault: { kind: 'lose-reply' }, times: 1 });
    assert.deepStrictEqual(parseFault('3004:error:16*3'), { prefix: '3004', fault: { kind: 'error', code: 16 }, times: 3 });
    assert.deepStrictEqual(parseFault('1109:delay:500'), { prefix: '1109', fault: { kind: 'delay', ms: 500 }, times: 1 });
    assert.throws(() => parseFault('3011:boh'));
    assert.throws(() => parseFault('3011:error:x'));
    assert.throws(() => parseFault('3011'));
  });
});
