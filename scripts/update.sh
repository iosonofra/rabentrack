#!/bin/sh
set -e

# ==============================================================================
# Raben Tracking Center - Script di aggiornamento rapido
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${APP_DIR}"

echo "${BLUE}${BOLD}Aggiornamento Raben - Tracking Center...${NC}"

echo "${YELLOW}==> 1/3 Verifica sorgenti e aggiornamenti...${NC}"
if [ "${RABEN_SKIP_GIT_UPDATE:-0}" = "1" ]; then
    echo "Aggiornamento Git saltato: uso dei file appena estratti dal pacchetto ZIP."
elif [ -d ".git" ]; then
    echo "Scaricamento ultimi aggiornamenti da Git..."
    CURRENT_BRANCH="$(git -c safe.directory="${APP_DIR}" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
    if ! git -c safe.directory="${APP_DIR}" diff --quiet || ! git -c safe.directory="${APP_DIR}" diff --cached --quiet; then
        echo "Errore: sono presenti modifiche locali ai file versionati; aggiornamento interrotto per non sovrascriverle." >&2
        git -c safe.directory="${APP_DIR}" status --short >&2
        echo "Salva o annulla le modifiche locali, poi riesegui scripts/update.sh." >&2
        exit 1
    fi
    git -c safe.directory="${APP_DIR}" fetch --prune origin
    git -c safe.directory="${APP_DIR}" merge --ff-only "origin/${CURRENT_BRANCH}"
else
    echo "Nessun repository Git rilevato: applicazione aggiornamento dai file locali estratti."
fi

echo "${YELLOW}==> 2/3 Aggiornamento dipendenze...${NC}"

if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
        echo "Installazione strumenti di compilazione richiesti dai moduli Node.js nativi..."
        apt-get update
        apt-get install -y --no-install-recommends python3 build-essential
    else
        echo "Errore: servono Python 3, make e un compilatore C++. Esegui come root: apt-get install -y python3 build-essential" >&2
        exit 1
    fi
fi

npm ci --omit=dev || npm install --omit=dev

if systemctl is-enabled --quiet camofox 2>/dev/null || [ -f /etc/systemd/system/camofox.service ]; then
    echo "Aggiornamento del browser Camoufox..."
    mkdir -p "${APP_DIR}/.cache/camoufox"
    if [ "$(id -u)" -eq 0 ] && id raben >/dev/null 2>&1; then
        chown -R raben:raben "${APP_DIR}/.cache/camoufox"
        runuser -u raben -- env CAMOUFOX_INSTALL_DIR="${APP_DIR}/.cache/camoufox" ./node_modules/.bin/camoufox-js fetch
    else
        CAMOUFOX_INSTALL_DIR="${APP_DIR}/.cache/camoufox" ./node_modules/.bin/camoufox-js fetch
    fi
fi

# Preserva permessi
chown -R raben:raben "${APP_DIR}" 2>/dev/null || true

echo "${YELLOW}==> 3/3 Riavvio dei servizi...${NC}"
if command -v systemctl >/dev/null 2>&1; then
    if [ -f "${APP_DIR}/scripts/raben-tracking-center.service" ]; then
        install -m 0644 "${APP_DIR}/scripts/raben-tracking-center.service" /etc/systemd/system/raben-tracking-center.service
    fi
    if [ -f "${APP_DIR}/scripts/camofox.service" ]; then
        install -m 0644 "${APP_DIR}/scripts/camofox.service" /etc/systemd/system/camofox.service
    fi
    systemctl daemon-reload 2>/dev/null || true
    if systemctl is-enabled --quiet camofox 2>/dev/null || [ -f /etc/systemd/system/camofox.service ]; then
        systemctl restart camofox
        CAMOFOX_READY=""
        ATTEMPT=1
        while [ "${ATTEMPT}" -le 12 ]; do
            CAMOFOX_READY="$(curl --fail --silent --show-error -X POST http://127.0.0.1:9377/start 2>/dev/null || true)"
            case "${CAMOFOX_READY}" in
                *'"ok":true'*) break ;;
            esac
            ATTEMPT=$((ATTEMPT + 1))
            sleep 1
        done
        case "${CAMOFOX_READY}" in
            *'"ok":true'*) ;;
            *)
                echo "Errore: Camofox risponde, ma il browser non riesce ad avviarsi." >&2
                echo "Risposta: ${CAMOFOX_READY:-nessuna risposta}" >&2
                journalctl -u camofox -n 40 --no-pager >&2 || true
                exit 1
                ;;
        esac
        echo "${GREEN}Servizio Camofox riavviato.${NC}"
    fi
    systemctl restart raben-tracking-center
    if ! systemctl is-active --quiet raben-tracking-center; then
        echo "Errore: il servizio raben-tracking-center non risulta attivo dopo il riavvio." >&2
        systemctl status raben-tracking-center --no-pager >&2 || true
        exit 1
    fi
    echo "${GREEN}Servizio systemd raben-tracking-center riavviato.${NC}"

    if command -v curl >/dev/null 2>&1; then
        API_CONFIG=""
        ATTEMPT=1
        while [ "${ATTEMPT}" -le 10 ]; do
            API_CONFIG="$(curl --fail --silent --show-error http://127.0.0.1:3000/api/raben-beta/config 2>/dev/null || true)"
            [ -n "${API_CONFIG}" ] && break
            ATTEMPT=$((ATTEMPT + 1))
            sleep 1
        done
        case "${API_CONFIG}" in
            *'"ultra"'*) echo "${GREEN}Verifica API completata: modalità Ultra disponibile.${NC}" ;;
            *)
                echo "Errore: il backend avviato non espone la modalità Ultra. Controlla sorgenti e log del servizio." >&2
                echo "Risposta API: ${API_CONFIG:-nessuna risposta}" >&2
                exit 1
                ;;
        esac
    fi
else
    echo "systemd non disponibile: riavvia manualmente i processi dell'applicazione."
fi

echo ""
echo "${GREEN}${BOLD}Aggiornamento completato con successo!${NC}"
