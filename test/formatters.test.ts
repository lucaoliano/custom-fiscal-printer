import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  replaceEuroCharacter,
  formatPrice,
  formatQuantity,
  formatDepartment,
  formatVat,
  formatDescription,
  formatDynamicDescription,
  formatDateDDMMYY,
  formatNumberPad
} from '../src/utils/formatters';

describe('Formatters test', () => {
  it('replaceEuroCharacter sostituisce il simbolo € con 0x7F', () => {
    assert.strictEqual(replaceEuroCharacter('Totale: 10€'), 'Totale: 10\x7F');
    assert.strictEqual(replaceEuroCharacter('€ 5,00'), '\x7F 5,00');
    assert.strictEqual(replaceEuroCharacter('Nessun euro'), 'Nessun euro');
  });

  it('formatPrice restituisce 9 cifre con zeri a sinistra', () => {
    assert.strictEqual(formatPrice(100), '000000100'); // 1.00 €
    assert.strictEqual(formatPrice(0), '000000000');
    assert.strictEqual(formatPrice(12345), '000012345'); // 123.45 €
    assert.strictEqual(formatPrice(999999999), '999999999');
  });

  it('formatQuantity moltiplica per 1000 e restituisce 9 cifre', () => {
    assert.strictEqual(formatQuantity(1), '000001000'); // 1 pezzo
    assert.strictEqual(formatQuantity(0.5), '000000500'); // 0.5 kg
    assert.strictEqual(formatQuantity(2.55), '000002550');
    assert.strictEqual(formatQuantity(10), '000010000');
  });

  it('formatDepartment restituisce 3 cifre', () => {
    assert.strictEqual(formatDepartment(0), '000');
    assert.strictEqual(formatDepartment(1), '001');
    assert.strictEqual(formatDepartment(15), '015');
  });

  it('formatVat valida e formatta 1..9', () => {
    assert.strictEqual(formatVat(1), '1');
    assert.strictEqual(formatVat(4), '4');
    assert.throws(() => formatVat(0), RangeError); // niente clamp silenzioso
    assert.throws(() => formatVat(12), RangeError);
  });

  it('formatDescription formatta con lunghezza prefissa e padding a destra', () => {
    const formatted = formatDescription('Pane', 22);
    assert.strictEqual(formatted.length, 24); // 2 cifre len + 22 char
    assert.strictEqual(formatted.substring(0, 2), '22');
    assert.strictEqual(formatted.substring(2).trim(), 'Pane');
    assert.strictEqual(formatted.substring(2).length, 22);
  });

  it('formatDynamicDescription formatta lunghezza effettiva', () => {
    const formatted = formatDynamicDescription('Contanti', 22);
    assert.strictEqual(formatted, '08Contanti');
  });

  it('formatDateDDMMYY formatta correttamente la data', () => {
    const testDate = new Date(2023, 4, 15); // 15 Maggio 2023
    assert.strictEqual(formatDateDDMMYY(testDate), '150523');
    assert.strictEqual(formatDateDDMMYY('010121'), '010121');
  });

  it('formatNumberPad aggiunge zeri a sinistra per il numero specificato di cifre', () => {
    assert.strictEqual(formatNumberPad(1, 4), '0001');
    assert.strictEqual(formatNumberPad(42, 6), '000042');
  });
});
