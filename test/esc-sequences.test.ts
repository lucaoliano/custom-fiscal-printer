import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Esc, parseEscSequenceLine, ESC } from '../src/protocol/esc-sequences';

describe('ESC Sequences test', () => {
  it('Esc generator crea sequenze corrette', () => {
    assert.strictEqual(Esc.bold('Test'), `${ESC}|6CTest`);
    assert.strictEqual(Esc.doubleWidth('Largo'), `${ESC}|2CLargo`);
    assert.strictEqual(Esc.alignCenter('Centro'), `${ESC}|cACentro`);
    assert.strictEqual(Esc.feed(3), `${ESC}|3F`);
    assert.strictEqual(Esc.bitmap(2), `${ESC}|2B`);
  });

  it('Esc.barcode genera il formato Custom corretto', () => {
    // EAN13: codice tipo '1', lunghezza codice (13) + 1 = 14
    const barcodeSeq = Esc.barcode('EAN13', '1234567890128');
    assert.strictEqual(barcodeSeq, `${ESC}|14R11234567890128`);
  });

  it('parseEscSequenceLine estrae stile, allineamento e testo centrato', () => {
    const rawLine = `${ESC}|cA${ESC}|6CTest Centrato Bold`;
    const parsed = parseEscSequenceLine(rawLine);

    assert.strictEqual(parsed.pitch, '2'); // Bold pitch
    assert.strictEqual(parsed.maxLen, 44);
    // Il testo deve contenere il padding di centratura
    assert.strictEqual(parsed.text.includes('Test Centrato Bold'), true);
    assert.strictEqual(parsed.text.startsWith(' '), true);
  });

  it('parseEscSequenceLine rileva pitch doppia larghezza', () => {
    const rawLine = `${ESC}|2CDoppia Larghezza`;
    const parsed = parseEscSequenceLine(rawLine);
    assert.strictEqual(parsed.pitch, '5'); // 22 col
    assert.strictEqual(parsed.maxLen, 22);
  });
});
