import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { calculateChecksum, buildFrame, parseResponse } from '../src/protocol/frame';

describe('Protocol Frame test', () => {
  it('calculateChecksum calcola la somma modulo 100 corretta', () => {
    // Es: "01030011"
    // '0'(48) + '1'(49) + '0'(48) + '3'(51) + '0'(48) + '0'(48) + '1'(49) + '1'(49)
    // 48+49+48+51+48+48+49+49 = 390 -> 390 % 100 = 90
    const cks = calculateChecksum('01030011');
    assert.strictEqual(cks, '90');
  });

  it('buildFrame assembla il pacchetto con STX, Cnt, Ident, Cks, ETX, NUL', () => {
    const frame = buildFrame('1109', 1);
    assert.strictEqual(frame[0], 0x02); // STX
    assert.strictEqual(frame[frame.length - 2], 0x03); // ETX
    assert.strictEqual(frame[frame.length - 1], 0x00); // NUL

    // Controlla il testo centrale: Cnt("01") + Ident("0") + Cmd("1109") + Cks(2)
    const innerText = frame.subarray(1, frame.length - 2).toString('latin1');
    assert.strictEqual(innerText.startsWith('0101109'), true);
  });

  it('parseResponse gestisce correttamente un frame positivo', () => {
    // Risposta simulata: STX + "01" + "0" + "0000" (4 status bytes) + "OK" + cks + ETX
    const payload = '0100000OK';
    const cks = calculateChecksum(payload);
    const rawFrame = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(payload + cks, 'latin1'),
      Buffer.from([0x03])
    ]);

    const parsed = parseResponse(rawFrame);
    assert.strictEqual(parsed.complete, true);
    assert.strictEqual(parsed.isError, false);
    assert.strictEqual(parsed.counter, 1);
    assert.strictEqual(parsed.statusBytes, '0000');
    assert.strictEqual(parsed.data, 'OK');
  });

  it('parseResponse rileva correttamente un errore ERxx / ERRxx', () => {
    // Frame errore: STX + "01" + "0" + "ERR05" + cks + ETX
    const payload = '010ERR05';
    const cks = calculateChecksum(payload);
    const rawFrame = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(payload + cks, 'latin1'),
      Buffer.from([0x03])
    ]);

    const parsed = parseResponse(rawFrame);
    assert.strictEqual(parsed.complete, true);
    assert.strictEqual(parsed.isError, true);
    assert.strictEqual(parsed.errorCode, 5);
  });

  it('parseResponse restituisce complete=false se il frame è parziale', () => {
    const partial = Buffer.from([0x02, 0x30, 0x31]); // solo STX + "01"
    const parsed = parseResponse(partial);
    assert.strictEqual(parsed.complete, false);
  });
});
