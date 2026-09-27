#!/bin/bash
set -e

# ==============================================================================
# Raben Tracking Center - Script di applicazione aggiornamento da file ZIP
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}====================================================${NC}"
echo -e "${BLUE}${BOLD}   Raben Tracking Center - Applicazione Update      ${NC}"
echo -e "${BLUE}${BOLD}====================================================${NC}"

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}Errore: questo script deve essere eseguito come root.${NC}" >&2
    exit 1
fi

APP_DIR="/opt/raben-tracking-center"
ZIP_FILE="${1:-}"

if [ -n "${ZIP_FILE}" ]; then
    if [ ! -f "${ZIP_FILE}" ]; then
        echo -e "${RED}Errore: file ZIP non trovato: ${ZIP_FILE}${NC}" >&2
        exit 1
    fi

    echo -e "${YELLOW}==> Arresto temporaneo servizi...${NC}"
    systemctl stop camofox raben-tracking-center 2>/dev/null || true

    echo -e "${YELLOW}==> Estrazione ${ZIP_FILE} in ${APP_DIR}...${NC}"
    unzip -o "${ZIP_FILE}" -d "${APP_DIR}"
fi

cd "${APP_DIR}"
chmod +x "${APP_DIR}/scripts/"*.sh 2>/dev/null || true

echo -e "${YELLOW}==> Esecuzione script di aggiornamento dipendenze e servizi...${NC}"
bash "${APP_DIR}/scripts/update.sh"
