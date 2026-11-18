import { CustomFiscalPrinter } from '../src';

async function runSerialExample() {
  // Configurazione per collegamento USB Virtual COM o Seriale RS232
  const printer = new CustomFiscalPrinter({
    type: 'serial',
    path: process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0', // su macOS: '/dev/tty.usbserial-...'
    baudRate: 19200, // Baud rate predefinito Custom (o 57600)
    dataBits: 8,
    parity: 'none',
    stopBits: 1
  });

  try {
    console.log('Apertura porta seriale...');
    await printer.connect();
    console.log('Porta aperta con successo!');

    // Reset stampante
    await printer.reset();

    // Stampa scontrino veloce
    await printer.beginFiscalReceipt();
    await printer.printRecItem({
      description: 'Caffè al banco',
      priceInCents: 120, // 1,20 €
      quantity: 1,
      vatRate: 1
    });
    await printer.printRecTotal({
      amountInCents: 120,
      description: 'Contanti'
    });
    await printer.endFiscalReceipt();

    await printer.openDrawer();
    console.log('Scontrino emesso!');
  } catch (error: any) {
    console.error('Errore:', error.message);
  } finally {
    await printer.disconnect();
  }
}

if (require.main === module) {
  runSerialExample();
}
