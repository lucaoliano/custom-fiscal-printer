/**
 * Utility di formattazione per comandi del protocollo Custom
 */

/**
 * Sostituisce il carattere Euro (€ / \u20AC) con il carattere 0x7F,
 * come specificato dalla libreria ufficiale Custom (CheckPutEuroCharacter).
 */
export function replaceEuroCharacter(text: string): string {
  if (!text) return '';
  return text.replace(/\u20AC/g, '\x7F');
}

/**
 * Normalizza e valida un testo fornito dall'utente prima dell'invio alla stampante.
 * - € -> 0x7F (come CheckPutEuroCharacter);
 * - translitterazione dei caratteri tipografici comuni (apostrofi, virgolette, trattini, puntini, spazi unicode);
 * - RangeError se resta un carattere fuori da 0x20-0xFF, oppure nel range di controllo 0x7F-0x9F
 *   (a parte lo 0x7F prodotto dall'Euro). Impedisce l'iniezione di byte STX/ETX/controllo nel frame.
 */
export function sanitizeText(text: string, fieldName: string = 'testo'): string {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') {
    throw new RangeError(`${fieldName}: deve essere una stringa`);
  }
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x20ac) {
      out += '\x7F';
    } else if (cp === 0x2018 || cp === 0x2019 || cp === 0x201a || cp === 0x201b) {
      out += "'";
    } else if (cp === 0x201c || cp === 0x201d || cp === 0x201e || cp === 0x201f) {
      out += '"';
    } else if (cp === 0x2013 || cp === 0x2014 || cp === 0x2212) {
      out += '-';
    } else if (cp === 0x2026) {
      out += '...';
    } else if (cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200b)) {
      out += ' ';
    } else if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
    } else if (cp >= 0xa0 && cp <= 0xff) {
      out += ch;
    } else {
      throw new RangeError(
        `${fieldName}: carattere non consentito U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
      );
    }
  }
  return out;
}

/** Verifica che il valore sia un intero finito nell'intervallo [min, max]. */
function assertIntRange(value: number, min: number, max: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${name}: deve essere un numero intero (ricevuto ${value})`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name}: fuori intervallo ${min}..${max} (ricevuto ${value})`);
  }
}

/**
 * Formatta un importo in centesimi a 9 cifre zero-padded.
 * Es: 100 centesimi (1,00 €) -> "000000100"
 * @throws {RangeError} se non è un intero finito tra 0 e 999999999.
 */
export function formatPrice(cents: number): string {
  assertIntRange(cents, 0, 999999999, 'Importo in centesimi');
  return cents.toString().padStart(9, '0');
}

/**
 * Formatta la quantità per la vendita RT.
 * In base al protocollo Custom RT, la quantità è moltiplicata per 1000
 * e formattata a 9 cifre zero-padded.
 * Es: 1.0 -> 1000 -> "000001000"
 * Es: 0.5 -> 500  -> "000000500"
 * @throws {RangeError} se non finita, <= 0 o se il risultato non entra in 9 cifre.
 */
export function formatQuantity(quantity: number = 1): string {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError(`Quantità: deve essere un numero finito > 0 (ricevuto ${quantity})`);
  }
  const q = Math.round(quantity * 1000);
  if (q < 1 || q > 999999999) {
    throw new RangeError(`Quantità: fuori intervallo (ricevuto ${quantity})`);
  }
  return q.toString().padStart(9, '0');
}

/**
 * Formatta l'indice reparto per i comandi RT (3 cifre zero-padded).
 * Es: 0 -> "000", 1 -> "001"
 * @throws {RangeError} se non è un intero 0..999.
 */
export function formatDepartment(dept: number = 0): string {
  assertIntRange(dept, 0, 999, 'Reparto');
  return dept.toString().padStart(3, '0');
}

/**
 * Formatta l'aliquota IVA per il protocollo (1..9).
 * @throws {RangeError} se non è un intero 1..9.
 */
export function formatVat(vat: number = 1): string {
  assertIntRange(vat, 1, 9, 'Aliquota IVA');
  return vat.toString();
}

/**
 * Formatta una descrizione articolo o riga secondo le specifiche Custom:
 * [lunghezza a 2 cifre] + [testo paddato con spazi fino a maxLen]
 * Es: "Pane" (maxLen 22) -> "22Pane                  "
 */
export function formatDescription(text: string, maxLen: number = 22): string {
  const cleaned = sanitizeText(text || '');
  const truncated = cleaned.substring(0, maxLen);
  const padded = truncated.padEnd(maxLen, ' ');
  const lenStr = maxLen.toString().padStart(2, '0');
  return lenStr + padded;
}

/**
 * Formatta una stringa a lunghezza dinamica (non paddata) preceduta dalla sua lunghezza.
 * Es: "Contanti" -> "08Contanti"
 */
export function formatDynamicDescription(text: string, maxLen: number = 22): string {
  const cleaned = sanitizeText(text || '');
  const truncated = cleaned.substring(0, maxLen);
  const lenStr = truncated.length.toString().padStart(2, '0');
  return lenStr + truncated;
}

/**
 * Formatta una data nel formato DDMMYY richiesto dai riferimenti RT (annullo/reso).
 */
export function formatDateDDMMYY(date: Date | string): string {
  if (typeof date === 'string') {
    // Se è già 6 caratteri numerici, la restituisce
    if (/^\d{6}$/.test(date)) return date;
    const parsed = new Date(date);
    if (!isNaN(parsed.getTime())) {
      date = parsed;
    } else {
      return date.replace(/[^0-9]/g, '').substring(0, 6);
    }
  }

  const d = date.getDate().toString().padStart(2, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const y = (date.getFullYear() % 100).toString().padStart(2, '0');
  return `${d}${m}${y}`;
}

/**
 * Formatta un numero progressivo zero-padded (es. Z-Report o scontrino a 4 cifre).
 * Es: 1 -> "0001"
 * @throws {RangeError} se non è un intero non negativo (o stringa di sole cifre) che entra in `digits`.
 */
export function formatNumberPad(num: number | string, digits: number): string {
  let n: string;
  if (typeof num === 'number') {
    if (!Number.isInteger(num) || num < 0) {
      throw new RangeError(`Numero: deve essere un intero non negativo (ricevuto ${num})`);
    }
    n = num.toString();
  } else if (typeof num === 'string' && /^\d+$/.test(num)) {
    n = num;
  } else {
    throw new RangeError(`Numero: stringa di sole cifre richiesta (ricevuto ${JSON.stringify(num)})`);
  }
  if (n.length > digits) {
    throw new RangeError(`Numero ${n} non entra in ${digits} cifre`);
  }
  return n.padStart(digits, '0');
}

/**
 * Port di `formatQty(int)` del driver Java: formatta la quantita' (gia' moltiplicata per 1000) con la virgola
 * decimale e senza zeri finali non significativi, per la riga di dettaglio `3002`.
 * Es: 1500 -> "1,5"; 2000 -> "2"; 50 -> "0,05"; 12345 -> "12,345".
 */
export function formatQty(qtyTimes1000: number): string {
  const s = String(qtyTimes1000);
  let r: string;
  if (s.length < 4) {
    if (s.length < 2) r = '0,00' + s;
    else if (s.length < 3) r = '0,0' + s;
    else r = '0,' + s;
  } else {
    r = s.substring(0, s.length - 3) + ',' + s.substring(s.length - 3);
  }
  if (r.endsWith(',000')) return r.substring(0, r.length - 4);
  if (r.endsWith('00')) return r.substring(0, r.length - 2);
  if (r.endsWith('0')) return r.substring(0, r.length - 1);
  return r;
}

/**
 * Port di `formatSinglePrice(long)` del driver Java: importo in centesimi con virgola decimale (sempre 2 decimali).
 * Es: 200 -> "2,00"; 5 -> "0,05"; 12345 -> "123,45".
 */
export function formatSinglePrice(cents: number): string {
  const s = String(cents);
  if (s.length < 3) {
    return s.length < 2 ? '0,0' + s : '0,' + s;
  }
  return s.substring(0, s.length - 2) + ',' + s.substring(s.length - 2);
}
