#!/usr/bin/env node
import * as readline from 'readline';
import { EmulatedPrinter, Fault } from './emulator';
import { startEmulatorServer } from './server';

const USAGE = `Emulatore di registratore telematico Custom (per sviluppo, non è una stampante vera)

Uso: custom-fiscal-emulator [opzioni]

  --host <indirizzo>     default 127.0.0.1 (l'emulatore non ha autenticazione)
  --port <porta>         default 9100
  --model rx|legacy      identificazione della stampante (default rx)
  --serial <matricola>   matricola dell'RT, 11 caratteri
  --last-z <numero>      ultimo azzeramento Z già fatto (default 0)
  --paper-out            parte con la carta esaurita
  --cover-open           parte con il coperchio aperto
  --fault <prefisso>:<guasto>[:<arg>][*<volte>]
                         guasti: error:<codice> | lose-command | lose-reply | truncate-reply | silence | delay:<ms>
                         esempio: --fault 3011:lose-reply   --fault 3004:error:16*3
  --verbose              stampa ogni comando ricevuto

Comandi da tastiera mentre gira: paper-out, paper-ok, cover-open, cover-close, state, fault <come sopra>, quit.`;

export function parseFault(spec: string): { prefix: string; fault: Fault; times: number } {
  const [body, count] = spec.split('*');
  const [prefix, kind, arg] = body.split(':');
  const times = count === undefined ? 1 : parseInt(count, 10);
  if (!prefix || !kind || !Number.isInteger(times) || times < 1) throw new Error(`Guasto non valido: ${spec}`);
  const number = (what: string) => {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${what} non valido in: ${spec}`);
    return n;
  };
  switch (kind) {
    case 'error':
      return { prefix, fault: { kind, code: number('Codice') }, times };
    case 'delay':
      return { prefix, fault: { kind, ms: number('Ritardo') }, times };
    case 'lose-command':
    case 'lose-reply':
    case 'truncate-reply':
    case 'silence':
      return { prefix, fault: { kind }, times };
    default:
      throw new Error(`Guasto sconosciuto: ${kind}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} richiede un valore`);
    return v;
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const model = value('--model');
  if (model !== undefined && model !== 'rx' && model !== 'legacy') throw new Error('--model: rx oppure legacy');
  const lastZ = value('--last-z');
  const printer = new EmulatedPrinter({
    model,
    serial: value('--serial'),
    lastZ: lastZ === undefined ? undefined : parseInt(lastZ, 10)
  });
  if (args.includes('--paper-out')) printer.setPaper({ empty: true });
  if (args.includes('--cover-open')) printer.setCoverOpen(true);
  args.forEach((a, i) => {
    if (a !== '--fault') return;
    const spec = args[i + 1];
    if (!spec) throw new Error('--fault richiede un valore');
    const { prefix, fault, times } = parseFault(spec);
    printer.inject(prefix, fault, times);
  });

  const verbose = args.includes('--verbose');
  const port = Number(value('--port') ?? 9100);
  const server = await startEmulatorServer(printer, {
    host: value('--host'),
    port,
    onCommand: verbose ? (c) => console.log(`RX ${c}`) : undefined
  });
  console.log(`Emulatore in ascolto su ${server.host}:${server.port} (modello ${model ?? 'rx'})`);

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (process.stdin.isTTY) {
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const [cmd, ...rest] = line.trim().split(/\s+/);
      try {
        switch (cmd) {
          case 'paper-out':
            return printer.setPaper({ empty: true });
          case 'paper-ok':
            return printer.setPaper({ empty: false, nearEnd: false });
          case 'cover-open':
            return printer.setCoverOpen(true);
          case 'cover-close':
            return printer.setCoverOpen(false);
          case 'state':
            return console.log(printer.snapshot());
          case 'fault': {
            const { prefix, fault, times } = parseFault(rest.join(' '));
            return printer.inject(prefix, fault, times);
          }
          case 'quit':
            return void stop();
          case '':
            return;
          default:
            console.log(`Comando sconosciuto: ${cmd}`);
        }
      } catch (e) {
        console.log((e as Error).message);
      }
    });
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
