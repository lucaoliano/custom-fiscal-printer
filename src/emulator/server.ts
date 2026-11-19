import * as net from 'net';
import { calculateChecksum, parseRequest } from '../protocol/frame';
import { EmulatedPrinter, EmulatorOptions } from './emulator';
import { replyFrame } from './transport';

export interface EmulatorServerOptions {
  /** Default 127.0.0.1: l'emulatore non ha autenticazione, non va esposto. */
  host?: string;
  /** Default 0 = porta libera scelta dal sistema. */
  port?: number;
  /** Chiamata per ogni comando ricevuto (per i log della riga di comando). */
  onCommand?: (command: string) => void;
}

export interface EmulatorServer {
  readonly printer: EmulatedPrinter;
  readonly host: string;
  readonly port: number;
  /** Frame ricevuti con checksum errato: la stampante vera non li eseguirebbe. Sono ignorati. */
  readonly badFrames: string[];
  connections(): number;
  close(): Promise<void>;
}

/** Espone un `EmulatedPrinter` su TCP, come una stampante Ethernet. */
export async function startEmulatorServer(
  printerOrOptions: EmulatedPrinter | EmulatorOptions = {},
  options: EmulatorServerOptions = {}
): Promise<EmulatorServer> {
  const printer = printerOrOptions instanceof EmulatedPrinter ? printerOrOptions : new EmulatedPrinter(printerOrOptions);
  const host = options.host ?? '127.0.0.1';
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const badFrames: string[] = [];

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let pending = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const etx = pending.indexOf(0x03);
        if (etx === -1) return;
        const frame = pending.subarray(0, etx + 1);
        // il NUL finale del frame fa parte del frame, non del successivo
        pending = pending.subarray(pending[etx + 1] === 0x00 ? etx + 2 : etx + 1);
        const stx = frame.indexOf(0x02);
        const inner = stx === -1 ? '' : frame.subarray(stx + 1, frame.length - 3).toString('latin1');
        const cks = frame.subarray(frame.length - 3, frame.length - 1).toString('latin1');
        if (stx === -1 || cks !== calculateChecksum(inner)) {
          badFrames.push(frame.toString('latin1'));
          continue;
        }
        const request = parseRequest(frame);
        options.onCommand?.(request.command);
        const reply = printer.handle(request.command);
        const bytes = replyFrame(reply, request.counter);
        const delivery = reply.delivery ?? 'normal';
        if (delivery === 'normal') socket.write(bytes);
        else if (delivery === 'close') socket.destroy();
        else if (delivery === 'truncate') {
          socket.write(bytes.subarray(0, Math.ceil(bytes.length / 2)), () => socket.destroy());
        } else if (delivery !== 'silence') {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!socket.destroyed) socket.write(bytes);
          }, delivery.delayMs);
          timers.add(timer);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    printer,
    host,
    port: (server.address() as net.AddressInfo).port,
    badFrames,
    connections: () => sockets.size,
    close: async () => {
      timers.forEach(clearTimeout);
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
