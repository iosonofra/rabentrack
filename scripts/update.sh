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
if [ -d ".git" ]; then
    echo "Scaricamento ultimi aggiornamenti da Git..."
    git pull || true
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
    CAMOUFOX_INSTALL_DIR="${APP_DIR}/.cache/camoufox" npx camoufox-js fetch
fi

# Preserva permessi
chown -R raben:raben "${APP_DIR}" 2>/dev/null || true

echo "${YELLOW}==> 3/3 Riavvio dei servizi...${NC}"
if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    if systemctl is-enabled --quiet camofox 2>/dev/null || [ -f /etc/systemd/system/camofox.service ]; then
        systemctl restart camofox || true
        echo "${GREEN}Servizio Camofox riavviato.${NC}"
    fi
    systemctl restart raben-tracking-center
    echo "${GREEN}Servizio systemd raben-tracking-center riavviato.${NC}"
else
    echo "systemd non disponibile: riavvia manualmente i processi dell'applicazione."
fi

echo ""
echo "${GREEN}${BOLD}Aggiornamento completato con successo!${NC}"
