#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Install Docker Engine with the Compose plugin first: https://docs.docker.com/engine/install/"
  exit 1
fi

env_file=.env.production
if [[ ! -f "$env_file" ]]; then
  read -r -p "Public domain pointing to this server: " domain
  read -r -s -p "Administrator password (16+ characters): " admin_password
  echo
  if [[ ${#admin_password} -lt 16 ]]; then echo "Password is too short."; exit 1; fi
  secret() { openssl rand -hex 32; }
  cat > "$env_file" <<EOF
DOMAIN=$domain
ADMIN_PASSWORD=$admin_password
SESSION_SECRET=$(secret)
RUNNER_TOKEN=$(secret)
POSTGRES_PASSWORD=$(secret)
CODEX_AUTH_MOUNT=sdlc-codex-auth
MAX_ACTIVE_RUNS=2
EOF
  chmod 600 "$env_file"
fi

docker compose --env-file "$env_file" -f compose.yaml -f compose.production.yaml up --build -d
echo "SDLC Control Plane is starting at https://$(grep '^DOMAIN=' "$env_file" | cut -d= -f2-)"
