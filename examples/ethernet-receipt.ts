import { CustomFiscalPrinter, Esc } from '../src';

async function runEthernetExample() {
  const printer = new CustomFiscalPrinter({
    type: 'tcp',
    host: '192.168.0.1', // Indirizzo IP della stampante Custom
    port: 9100           // Porta standard Ethernet
  });

  try {
    console.log('Connessione alla stampante Custom in corso...');
    await printer.connect();
    console.log('Connesso con successo!');

    // 1. Diagnostica iniziale
    const status = await printer.getPrinterStatus();
    console.log('Stato stampante:', {
      coperchioAperto: status.coverOpen,
      cartaEsaurita: status.paperEmpty,
      cartaInEsaurimento: status.paperNearEnd
    });

    if (status.paperEmpty) {
      console.warn('ATTENZIONE: Carta esaurita!');
      return;
    }

    // Reset di sicurezza per annullare transazioni precedenti lasciate aperte
    await printer.reset();

    // 2. Display cliente
    await printer.displayText('BENVENUTO ALLA CASSA');

    // 3. Stampa Scontrino Non Fiscale (Gestionale)
    console.log('Stampa scontrino non fiscale...');
    await printer.beginNonFiscal({ printHeader: true });
    await printer.printNormal(Esc.alignCenter(Esc.bold('SCONTRINO DI PROVA')));
    await printer.printNormal(Esc.alignCenter('Riepilogo Punti Fedeltà'));
    await printer.printNormal(Esc.doubleWidth('PUNTI: 250'));
    await printer.printNormal(Esc.barcode('EAN13', '8012345678901'));
    await printer.printNormal(Esc.feed(2));
    await printer.endNonFiscal();

    // 4. Stampa Scontrino Fiscale RT (Documento Commerciale Online)
    console.log('Emissione scontrino fiscale RT...');
    await printer.beginFiscalReceipt({
      lotteryCode: 'ABCD1234', // Codice lotteria degli scontrini
      fiscalCode: 'RSSMRA80A01H501U', // Codice fiscale per detrazione
      headerLines: [Esc.alignCenter('Benvenuti al Negozio')]
    });

    // Articolo 1: vendita a pezzo (1 pezzo a 2,50 €)
    await printer.printRecItem({
      description: 'Articolo Standard',
      priceInCents: 250, // 2,50 €
      quantity: 1,
      vatRate: 1, // IVA 22%
      department: 0
    });

    // Articolo 2: vendita a peso (1,5 Kg a 3,00 €/Kg = 4,50 €)
    await printer.printRecItem({
      description: 'Mele Golden',
      priceInCents: 450, // 4,50 €
      quantity: 1.5,
      unitName: 'Kg',
      unitPriceInCents: 300, // 3,00 € al Kg
      vatRate: 2, // IVA 10%
      department: 1
    });

    // Sconto promozionale di 1,00 €
    await printer.printRecItemAdjustment({
      type: 'DISCOUNT',
      description: 'Sconto Fedeltà',
      amountInCents: 100,
      vatRate: 1
    });

    // Subtotale: 2,50 + 4,50 - 1,00 = 6,00 €
    await printer.printRecSubtotal();

    // Pagamento totale: 6,00 € in Contanti
    await printer.printRecTotal({
      amountInCents: 600,
      description: 'Contanti'
    });

    // Chiusura scontrino con riga di cortesia e taglio carta
    await printer.endFiscalReceipt({
      trailerLines: [Esc.alignCenter('Grazie per la visita!'), Esc.alignCenter('Arrivederci')]
    });

    // 5. Apertura cassetto rendiresto
    await printer.openDrawer();

    // 6. Messaggio di chiusura a display
    await printer.displayText('GRAZIE E ARRIVEDERCI');

    console.log('Scontrino fiscale emesso con successo!');
  } catch (error: any) {
    console.error('Errore durante la stampa:', error.message);
    if (error.code) {
      console.error(`Codice errore stampante: ${error.code} (${error.rawError})`);
    }
  } finally {
    await printer.disconnect();
    console.log('Disconnesso dalla stampante.');
  }
}

if (require.main === module) {
  runEthernetExample();
}
