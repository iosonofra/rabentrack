# Importatore tracking PrestaShop

Web app Node.js per importare tracking Raben da Excel, ricercare gli ordini con il loro riferimento e impostare tracking, corriere e stato.

## Avvio

1. Facoltativamente copia `.env.example` in `.env` per definire la configurazione iniziale. URL e chiave inseriti dall'interfaccia vengono conservati localmente in `data/settings.json`, escluso dal controllo versione.
2. Installa le dipendenze con `npm install`.
3. Avvia con `npm run dev`.
4. Apri `http://localhost:3000`.

La chiave Webservice deve avere almeno permessi di lettura su `orders`, `order_states`, `carriers`, `order_carriers` e di scrittura su `order_carriers` e `order_histories`.

## Flusso

1. Configura e verifica la connessione al negozio.
2. L'app scarica gli stati e i corrieri disponibili.
3. Carica il file Raben e seleziona stato e corriere.
4. Controlla l'anteprima: riferimenti non PrestaShop restano visibili ma non sono applicabili. I suffissi `-R` e `-` vengono ricondotti al riferimento base di nove caratteri.
5. Conferma l'importazione. L'esecuzione dettagliata verrà registrata nel registro importazioni.

Il parser usa `Numero di spedizione (1)` come tracking principale e conserva `Numero di spedizione (2)` come identificativo alternativo. Se più colli appartengono allo stesso ordine, vengono tutti archiviati nel Tracking Center ma l'aggiornamento automatico del tracking PrestaShop viene bloccato per evitare sovrascritture ambigue.

## Centro di controllo spedizioni

Ogni verifica PrestaShop, verifica pubblica Raben e aggiornamento confermato alimenta un archivio locale in `data/shipments.json` (escluso dal controllo versione). Il centro di controllo mostra conteggi operativi, filtri, eccezioni e lo storico delle operazioni per singolo tracking. È in sola lettura: non invia aggiornamenti né esegue controlli automatici.

## Nota di compatibilita'

Il modulo `src/prestashop-client.js` e' l'unico punto che conosce le API di PrestaShop. Il parser/importatore non dipende dalla versione del negozio: questo permette di adattare il connettore durante il passaggio dalla 1.7.6.5 alla versione successiva.

## Verifica pubblica Raben tramite Camofox

La verifica usa il portale pubblico `oftc.myraben.com` tramite un servizio Camofox in esecuzione **solo sul computer locale**. Non richiede credenziali e non può modificare ordini, tracking, corrieri o stati in PrestaShop.

- Seleziona esplicitamente fino a 10 righe già verificate nell'importatore.
- Dal Centro di controllo puoi verificare una singola spedizione dal suo dettaglio oppure selezionare fino a 10 righe e avviare una verifica multipla.
- Le richieste vengono elaborate una alla volta, a distanza di 5 secondi; i risultati sono riutilizzati dalla cache locale per 24 ore.
- Tutti gli avvii, inclusi quelli dall'importatore e dal Centro di controllo, passano da una sola coda locale: non vengono mai eseguite automazioni Camofox in parallelo.
- Non tenta di superare CAPTCHA e si ferma quando la pagina richiede un intervento umano.
- L'URL predefinito è `https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT`.
- Se il tracking principale non viene trovato, il sistema prova una sola volta `Numero di spedizione (2)`.

Il progetto include già Camofox Browser. Per avviarlo usa `npm run camofox`: lo script imposta la porta `9377`, limita l'ascolto a `127.0.0.1`, disabilita la telemetria e rimuove qualunque configurazione proxy. Se Camofox è protetto da chiave, imposta `CAMOFOX_ACCESS_KEY` nell'ambiente dell'app, senza inserirla nell'interfaccia. Non esporre la porta 9377 in rete.
