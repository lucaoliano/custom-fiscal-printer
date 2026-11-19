import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as net from 'net';
import { CustomFiscalPrinter } from '../src/client/fiscal-printer';
import { ITransport } from '../src/transports/transport.interface';
import { TcpTransport } from '../src/transports/tcp.transport';
import { ReconnectingTransport } from '../src/transports/reconnecting.transport';
import { FrameReader, MAX_FRAME_BUFFER } from '../src/transports/frame-buffer';
import { buildFrame, parseRequest, parseResponse } from '../src/protocol/frame';
import { CustomConnectionError, CustomProtocolError, CustomTimeoutError } from '../src/errors';

const quiet = { autoIdentify: false, statusPolling: false } as const;

/** Stampante finta su TCP: `answer(cmd, connIndex)` decide se rispondere; false = silenzio. */
async function fakePrinterServer(answer: (cmd: string, connIndex: number) => boolean, listenPort = 0) {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    const idx = sockets.push(socket) - 1;
    let acc = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        const etx = acc.indexOf(0x03);
        if (etx === -1) return;
        const req = parseRequest(acc.subarray(0, etx + 1));
        acc = acc.subarray(etx + 2 <= acc.length ? etx + 2 : etx + 1); // salta il NUL finale
        if (answer(req.command, idx)) socket.write(buildFrame('0000', req.counter));
      }
    });
  });
  await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections: () => sockets.length,
    close: async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
}

describe('TcpTransport', () => {
  it('connect concorrenti condividono un solo socket', async () => {
    const srv = await fakePrinterServer(() => true);
    const t = new TcpTransport('127.0.0.1', srv.port, 2000);
    try {
      await Promise.all([t.connect(), t.connect(), t.connect()]);
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(srv.connections(), 1);
    } finally {
      await t.close();
      await srv.close();
    }
  });

  it("l'evento close del vecchio socket non rompe la nuova connessione", async () => {
    const srv = await fakePrinterServer(() => true);
    const t = new TcpTransport('127.0.0.1', srv.port, 2000);
    try {
      await t.connect();
      await t.close();
      await t.connect();
      await new Promise((r) => setTimeout(r, 50)); // lascia arrivare il close asincrono del primo socket
      assert.strictEqual(t.isConnected(), true);
    } finally {
      await t.close();
      await srv.close();
    }
  });
});

describe('FrameReader', () => {
  it("l'overflow senza letture pendenti fallisce la read successiva", async () => {
    const r = new FrameReader();
    r.feed(Buffer.concat([Buffer.from([0x02]), Buffer.alloc(MAX_FRAME_BUFFER + 10, 0x41)]));
    await assert.rejects(() => r.read(50, () => new Error('timeout')), CustomProtocolError);
    await assert.rejects(() => r.read(20, () => new Error('timeout')), /timeout/);
  });
});

describe('parseResponse', () => {
  it('contatore non numerico: errore di protocollo', () => {
    const raw = Buffer.concat([Buffer.from([0x02]), Buffer.from('AB0000'), Buffer.from('00'), Buffer.from([0x03])]);
    assert.throws(() => parseResponse(raw), CustomProtocolError);
  });
});

describe('esito dei comandi (sent)', () => {
  /** Trasporto scriptato: `onWrite`/`onRead` decidono cosa succede. */
  function scripted(opts: { write?: () => void; read: (lastCounter: number, n: number) => Buffer }): ITransport {
    let last = 1;
    let reads = 0;
    return {
      async connect() {},
      async write(d: Buffer) {
        opts.write?.();
        last = parseRequest(d).counter;
      },
      async read() {
        return opts.read(last, reads++);
      },
      flush() {},
      async close() {},
      isConnected: () => true
    };
  }

  it('scrittura fallita: sent = false (comando mai partito)', async () => {
    const p = new CustomFiscalPrinter(
      scripted({ write: () => { throw new Error('EPIPE'); }, read: () => Buffer.alloc(0) }),
      quiet
    );
    await assert.rejects(() => p.executeCommand('1109'), (e: CustomConnectionError) => {
      assert.ok(e instanceof CustomConnectionError);
      assert.strictEqual(e.sent, false);
      return true;
    });
  });

  it('timeout dopo la scrittura: sent = true (esito ignoto)', async () => {
    const p = new CustomFiscalPrinter(
      scripted({ read: () => { throw new CustomTimeoutError('lettura', 20); } }),
      quiet
    );
    await assert.rejects(() => p.executeCommand('1109', 20), (e: CustomTimeoutError) => {
      assert.ok(e instanceof CustomTimeoutError);
      assert.strictEqual(e.sent, true);
      assert.strictEqual(e.command, '1109');
      return true;
    });
  });

  it('errore di canale dopo la scrittura: CustomConnectionError con sent = true', async () => {
    const p = new CustomFiscalPrinter(
      scripted({ read: () => { throw new Error('ECONNRESET'); } }),
      quiet
    );
    await assert.rejects(() => p.executeCommand('1109'), (e: CustomConnectionError) => {
      assert.ok(e instanceof CustomConnectionError);
      assert.strictEqual(e.sent, true);
      return true;
    });
  });

  it('frame malformato: scartato, la risposta valida successiva viene usata', async () => {
    const p = new CustomFiscalPrinter(
      scripted({
        read: (counter, n) =>
          n === 0
            ? Buffer.from([0x02, 0x30, 0x03]) // troppo corto
            : n === 1
              ? Buffer.concat([Buffer.from([0x02]), Buffer.from('XX00000'), Buffer.from('00'), Buffer.from([0x03])]) // contatore non numerico
              : buildFrame('0000OK', counter)
      }),
      quiet
    );
    const res = await p.executeCommand('1109');
    assert.strictEqual(res.data, 'OK');
  });
});

describe('riconnessione', () => {
  it('dopo un timeout il comando successivo riparte da una connessione nuova', async () => {
    // la prima connessione tace; le successive rispondono
    const srv = await fakePrinterServer((_cmd, conn) => conn > 0);
    const printer = new CustomFiscalPrinter(
      { type: 'tcp', host: '127.0.0.1', port: srv.port, timeout: 300, reconnect: { baseDelayMs: 10, attempts: 3 } },
      quiet
    );
    let reconnected = 0;
    printer.on('reconnected', () => reconnected++);
    try {
      await printer.connect();
      await assert.rejects(() => printer.executeCommand('1109', 150), (e: CustomTimeoutError) => {
        assert.ok(e instanceof CustomTimeoutError);
        assert.strictEqual(e.sent, true);
        return true;
      });
      const res = await printer.executeCommand('1109', 1000);
      assert.strictEqual(res.isError, false);
      assert.strictEqual(srv.connections(), 2);
      assert.strictEqual(reconnected, 1);
    } finally {
      await printer.disconnect();
      await srv.close();
    }
  });

  it('server caduto e tornato su: ritenta con backoff prima di scrivere', async () => {
    const srv = await fakePrinterServer(() => true);
    const port = srv.port;
    const t = new ReconnectingTransport(new TcpTransport('127.0.0.1', port, 200), { baseDelayMs: 20, attempts: 6 });
    await t.connect();
    await srv.close(); // la stampante sparisce
    await new Promise((r) => setTimeout(r, 30));
    // riparte sulla stessa porta dopo un po'
    let revived: Promise<Awaited<ReturnType<typeof fakePrinterServer>>> | undefined;
    setTimeout(() => {
      revived = fakePrinterServer(() => true, port);
    }, 60);
    try {
      await t.write(buildFrame('1109', 1)); // la write attende la riconnessione
      assert.ok(t.isConnected());
    } finally {
      await t.close();
      await (await revived)?.close();
    }
  });

  it('dopo close() non si riconnette più', async () => {
    const srv = await fakePrinterServer(() => true);
    const t = new ReconnectingTransport(new TcpTransport('127.0.0.1', srv.port, 200), { baseDelayMs: 5, attempts: 2 });
    try {
      await t.connect();
      await t.close();
      await assert.rejects(() => t.write(buildFrame('1109', 1)), /chiuso/);
      assert.strictEqual(t.isConnected(), false);
    } finally {
      await srv.close();
    }
  });
});
