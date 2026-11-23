#!/usr/bin/env bash
# ====================================================================
# Autonomous PostgreSQL Backup & Disaster Recovery Script
# Runs periodic pg_dump with gzip compression and 7-day retention cleanup
# ====================================================================

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/qr_menu_postgres}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILENAME="qr_menu_backup_${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILENAME}"
RETENTION_DAYS=7

# Load database environment if present
if [ -f "$(dirname "$0")/../.env" ]; then
    export $(grep -v '^#' "$(dirname "$0")/../.env" | xargs)
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-postgres}"
DB_USER="${DB_USER:-postgres}"

echo "=========================================================="
echo "Starting PostgreSQL Database Backup at $(date)"
echo "Target File: ${BACKUP_PATH}"
echo "=========================================================="

# 1. Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# 2. Perform compressed streaming database dump
if command -v pg_dump >/dev/null 2>&1; then
    PGPASSWORD="${DB_PASSWORD:-}" pg_dump \
        -h "${DB_HOST}" \
        -p "${DB_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-privileges | gzip -9 > "${BACKUP_PATH}"

    BACKUP_SIZE=$(du -h "${BACKUP_PATH}" | cut -f1)
    echo "✓ Backup successfully created! File size: ${BACKUP_SIZE}"
else
    echo "⚠ pg_dump utility not installed on local path. Skipping live dump execution."
fi

# 3. Clean up backups older than RETENTION_DAYS to save disk space
echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -type f -name "qr_menu_backup_*.sql.gz" -mtime +${RETENTION_DAYS} -delete || true

echo "✓ Backup process completed successfully at $(date)."

