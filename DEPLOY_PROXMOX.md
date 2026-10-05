# Deploy su Proxmox VE con Debian 12

Questa guida descrive l'installazione di **Raben - Tracking Center** e **Camofox Browser** nello stesso container LXC Proxmox.

> [!IMPORTANT]
> Se Camofox è attivo, il container deve usare **Debian 12 Bookworm**. Alpine Linux non è supportato per questo deploy: Camoufox/Firefox e le sue dipendenze richiedono un ambiente Linux basato su glibc e pacchetti disponibili tramite `apt`.

La sola web app Node.js può funzionare anche senza Camofox, ma per mantenere un ambiente uniforme questa guida usa Debian 12 in tutti i casi.

## Architettura

```text
Proxmox VE
└── LXC Debian 12 non privilegiato
    ├── raben-tracking-center   0.0.0.0:3000
    │   └── UI, API, PrestaShop, import e automazioni
    └── camofox                 127.0.0.1:9377
        └── browser Camoufox usato per il portale Raben
```

- La porta `3000` è raggiungibile dalla LAN dagli operatori.
- La porta `9377` rimane sul loopback del container e non deve essere pubblicata.
- I servizi vengono gestiti da `systemd`.
- Configurazioni, spedizioni e profilo browser restano in `/opt/raben-tracking-center/data`.

## Requisiti consigliati

| Risorsa | Web app senza Camofox | Web app con Camofox |
|---|---:|---:|
| Sistema operativo | Debian 12 | **Debian 12 obbligatorio** |
| Architettura | amd64 o arm64 supportata dal pacchetto | amd64 consigliata |
| CPU | 1–2 vCPU | 2 vCPU |
| RAM | 512 MB | 1536–2048 MB |
| Swap | 256 MB | 256–512 MB |
| Disco | 4 GB | almeno 8 GB, consigliati 12–20 GB |
| Rete | bridge `vmbr0` | bridge `vmbr0` con accesso Internet |

Il primo `npm install` scarica anche il browser Camoufox, occupando circa 300 MB oltre alle dipendenze Node.js.

## Metodo 1 — Installazione automatica da Proxmox

Eseguire lo script dalla shell dell'host Proxmox VE:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/TUO_UTENTE/TUO_REPO/main/scripts/install-proxmox-lxc.sh)"
```

Durante la procedura:

1. scegliere un ID LXC libero;
2. indicare storage, bridge e indirizzo IP;
3. rispondere **Sì** all'installazione di Camofox;
4. selezionare obbligatoriamente **`debian`** quando viene richiesta la distribuzione;
5. indicare l'URL Git del repository.

> [!WARNING]
> Lo script crea sempre un container Debian 12, anche quando Camofox viene inizialmente disattivato. In questo modo potrà essere abilitato in seguito senza migrare il container.

Lo script:

- scarica il template Debian 12;
- crea un LXC non privilegiato con `nesting=1`;
- clona il progetto in `/opt/raben-tracking-center`;
- esegue `scripts/setup-debian.sh`;
- registra e avvia i servizi `raben-tracking-center` e `camofox`.

Al termine:

- web app: `http://<IP_CONTAINER>:3000`;
- Camofox: `http://127.0.0.1:9377`, accessibile solo dal container.

## Metodo 2 — Installazione manuale in un LXC Debian 12

### 1. Creare il container

Dalla GUI Proxmox creare un container con:

- template `debian-12-standard`;
- container non privilegiato;
- 2 core, almeno 1536 MB RAM e 8 GB disco;
- rete su `vmbr0`;
- avvio automatico abilitato;
- funzionalità `nesting=1`, come configurato dallo script automatico.

Avviare il container ed entrare nella shell:

```bash
pct start <ID_CONTAINER>
pct enter <ID_CONTAINER>
```

### 2. Clonare il progetto

```bash
apt-get update
apt-get install -y git curl ca-certificates
git clone https://github.com/TUO_UTENTE/TUO_REPO.git /opt/raben-tracking-center
cd /opt/raben-tracking-center
chmod +x scripts/*.sh
```

### 3. Eseguire il setup Debian

Con Camofox:

```bash
ENABLE_CAMOFOX=true bash scripts/setup-debian.sh
```

Solo web app:

```bash
ENABLE_CAMOFOX=false bash scripts/setup-debian.sh
```

Lo script installa:

- Node.js 22 LTS; il progetto richiede almeno Node.js 20;
- librerie GTK, NSS, X11, audio, D-Bus e font richieste dal browser;
- Xvfb per l'esecuzione headless;
- strumenti di compilazione `python3` e `build-essential`, necessari quando un modulo Node.js nativo come `better-sqlite3` non dispone di un binario precompilato;
- dipendenze npm di produzione;
- binario Camoufox tramite `camoufox-js`;
- utente di sistema `raben`;
- unità `systemd` per entrambi i servizi.

Il download del browser viene conservato in:

```text
/opt/raben-tracking-center/.cache/camoufox
```

## Configurazione

Creare `.env` partendo dall'esempio, se il setup non lo ha già fatto:

```bash
cd /opt/raben-tracking-center
cp -n .env.example .env
nano .env
```

Configurazione minima:

```env
PORT=3000
PRESTASHOP_URL=https://shop.example.com
PRESTASHOP_WEBSERVICE_KEY=

CAMOFOX_PORT=9377
CAMOFOX_URL=http://127.0.0.1:9377
CAMOFOX_ACCESS_KEY=
CAMOFOX_CRASH_REPORT_ENABLED=false
CAMOFOX_INTERACTIVE=off

RABEN_TRACKING_URL=https://oftc.myraben.com/link/ShipmentInformation?ShipmentNumber=TRACKINGDAINSERIRE&Language=IT
```

Note importanti:

- `src/start-camofox.js` forza Camofox su `127.0.0.1` e rimuove le variabili proxy.
- Non impostare `CAMOFOX_INTERACTIVE=on` nel container headless.
- Se si configura `CAMOFOX_ACCESS_KEY`, usare la stessa chiave nella web app e nel servizio Camofox.
- URL e chiave PrestaShop inseriti dalla UI vengono salvati in `data/settings.json`.

Dopo le modifiche:

```bash
chown raben:raben /opt/raben-tracking-center/.env
chmod 600 /opt/raben-tracking-center/.env
systemctl restart camofox raben-tracking-center
```

## Gestione dei servizi

| Operazione | Web app | Camofox |
|---|---|---|
| Stato | `systemctl status raben-tracking-center` | `systemctl status camofox` |
| Avvio | `systemctl start raben-tracking-center` | `systemctl start camofox` |
| Riavvio | `systemctl restart raben-tracking-center` | `systemctl restart camofox` |
| Arresto | `systemctl stop raben-tracking-center` | `systemctl stop camofox` |
| Avvio al boot | `systemctl enable raben-tracking-center` | `systemctl enable camofox` |
| Log live | `journalctl -u raben-tracking-center -f` | `journalctl -u camofox -f` |

Gli stessi comandi possono essere lanciati dall'host Proxmox:

```bash
pct exec <ID_CONTAINER> -- systemctl status raben-tracking-center
pct exec <ID_CONTAINER> -- systemctl status camofox
pct exec <ID_CONTAINER> -- journalctl -u camofox -n 100 --no-pager
```

## Verifica dell'installazione

### 1. Controllare i servizi

```bash
systemctl is-active raben-tracking-center
systemctl is-active camofox
```

Entrambi devono rispondere `active`.

### 2. Controllare Camofox

```bash
curl --fail --silent --show-error http://127.0.0.1:9377/health
curl --fail --silent --show-error -X POST http://127.0.0.1:9377/start
```

L'endpoint `/health` verifica il servizio HTTP, mentre `/start` verifica anche che il browser possa essere avviato. Entrambi sono locali e non richiedono la chiave di accesso. Se `/start` restituisce un errore:

```bash
tail -n 100 /var/log/camofox.err
tail -n 100 /var/log/camofox.log
```

L'installazione applica automaticamente uno strato di compatibilità fra `camoufox-js` e lo schema del binario Camoufox installato. Non modificare manualmente `properties.json`: il comando `npm ci` ripristina e applica in modo ripetibile la correzione tramite `postinstall`.

```bash
journalctl -u camofox -n 100 --no-pager
```

### 3. Controllare la web app

Nel container:

```bash
curl --fail --head http://127.0.0.1:3000/
```

Da un PC della LAN aprire `http://<IP_CONTAINER>:3000` e, nella sezione **Configurazione → Connessioni**, eseguire:

1. `Testa connessione e permessi` per PrestaShop;
2. `Testa Camofox locale` per la verifica Raben.

## Sicurezza di rete

Esporre sulla rete soltanto la porta della web app:

| Porta | Origine consentita | Uso |
|---:|---|---|
| `3000/tcp` | LAN operatori | Interfaccia e API della web app |
| `9377/tcp` | nessuna regola esterna | Camofox su loopback locale |

Verificare l'ascolto:

```bash
ss -lntp | grep -E ':3000|:9377'
```

Il risultato atteso per Camofox deve mostrare `127.0.0.1:9377`, non `0.0.0.0:9377`.

## Aggiornamento dell'applicazione

### Metodo 1 — Da repository Git

```bash
cd /opt/raben-tracking-center
bash scripts/update.sh
```

oppure passo-passo:

```bash
cd /opt/raben-tracking-center
systemctl stop camofox raben-tracking-center
git pull --ff-only
npm install --omit=dev
CAMOUFOX_INSTALL_DIR=/opt/raben-tracking-center/.cache/camoufox npx camoufox-js fetch
chown -R raben:raben /opt/raben-tracking-center
systemctl daemon-reload
systemctl start camofox raben-tracking-center
```

### Metodo 2 — Da archivio ZIP (aggiornamento pulito senza Git)

Lo zip di aggiornamento include tutto il codice aggiornato, frontend e script, escludendo cartelle dati (`data/`), credenziali (`.env`) e `node_modules` (che verranno compilate per Linux).

1. Copiare l'archivio ZIP sul server o nel container LXC (es. tramite Proxmox host: `pct push <ID_CT> raben-tracking-center-update.zip /tmp/raben-update.zip` o via SCP/SFTP in `/tmp`).
2. Eseguire nel container:

```bash
cd /opt/raben-tracking-center

# 1. Arresto prudenziale dei servizi
systemctl stop camofox raben-tracking-center

# 2. Estrazione dello zip sopra l'installazione (i dati esistenti e il .env sono al sicuro)
unzip -o /tmp/raben-update.zip -d /opt/raben-tracking-center

# 3. Permessi di esecuzione e completamento aggiornamento
chmod +x scripts/*.sh
bash scripts/update.sh
```

Verificare poi entrambi i servizi e l'endpoint `/health` di Camofox.

## Backup e persistenza

I dati da proteggere sono:

```text
/opt/raben-tracking-center/data/settings.json
/opt/raben-tracking-center/data/shipments.json
/opt/raben-tracking-center/data/camofox-profile/
/opt/raben-tracking-center/.env
```

È consigliato un backup Proxmox in modalità snapshot. Per creare anche un archivio manuale:

```bash
tar -czf /root/raben-data-$(date +%F).tar.gz \
  /opt/raben-tracking-center/data \
  /opt/raben-tracking-center/.env
```

La web app offre inoltre **Configurazione → Dati e backup → Scarica backup completo** per esportare spedizioni e impostazioni in JSON.

## Migrazione da un'installazione esistente

### Metodo consigliato: interfaccia web

1. Nell'installazione precedente aprire **Configurazione → Dati e backup**.
2. Scaricare il backup JSON.
3. Aprire la nuova installazione Debian.
4. Caricare il file in **Ripristina da backup**.
5. Verificare connessione PrestaShop, Camofox, mappature e Cron.

### Copia da host Proxmox

```bash
pct push <ID_CONTAINER> /tmp/shipments.json /opt/raben-tracking-center/data/shipments.json
pct push <ID_CONTAINER> /tmp/settings.json /opt/raben-tracking-center/data/settings.json
pct exec <ID_CONTAINER> -- chown -R raben:raben /opt/raben-tracking-center/data
pct exec <ID_CONTAINER> -- systemctl restart raben-tracking-center
```

Non copiare binari Camoufox provenienti da Windows o Alpine: reinstallare sempre il browser dentro Debian con `npx camoufox-js fetch`.

## Risoluzione dei problemi

### Camofox non parte

```bash
systemctl status camofox --no-pager
journalctl -u camofox -n 150 --no-pager
```

Controllare versione Node.js, directory del browser e permessi:

```bash
node --version
ls -la /opt/raben-tracking-center/.cache/camoufox
chown -R raben:raben /opt/raben-tracking-center/.cache /opt/raben-tracking-center/data
```

Se il browser non è presente o l'installazione è incompleta:

```bash
cd /opt/raben-tracking-center
systemctl stop camofox
CAMOUFOX_INSTALL_DIR=/opt/raben-tracking-center/.cache/camoufox npx camoufox-js fetch
chown -R raben:raben /opt/raben-tracking-center/.cache
systemctl start camofox
```

### Il test dalla web app non raggiunge Camofox

```bash
curl http://127.0.0.1:9377/health
grep '^CAMOFOX_URL=' /opt/raben-tracking-center/.env
```

Il valore deve essere:

```env
CAMOFOX_URL=http://127.0.0.1:9377
```

### Il processo viene terminato durante le verifiche

Controllare memoria e log del kernel:

```bash
free -h
journalctl -k | grep -i -E 'oom|out of memory'
```

Se compare un evento OOM, portare la RAM del container ad almeno 2 GB e aumentare lo swap.

## Checklist finale

- [ ] Container LXC basato su Debian 12.
- [ ] Node.js 20 o successivo.
- [ ] `raben-tracking-center` attivo e abilitato al boot.
- [ ] `camofox` attivo e abilitato al boot.
- [ ] `curl http://127.0.0.1:9377/health` riuscito.
- [ ] Porta `9377` non esposta alla LAN.
- [ ] Test PrestaShop riuscito dalla web app.
- [ ] Test Camofox riuscito dalla web app.
- [ ] Backup Proxmox e backup JSON verificati.
