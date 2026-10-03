#!/usr/bin/env bash
# Instala o StraightTalk numa VPS Ubuntu (22.04 ou 24.04), do zero, com HTTPS.
#
# Uso (como root, na VPS):
#   curl -fsSL https://raw.githubusercontent.com/USUARIO/straighttalk/main/deploy/setup.sh | bash
# ou, de dentro do repositório já clonado:
#   sudo bash deploy/setup.sh
#
# Variáveis opcionais:
#   DOMAIN=chat.meudominio.com   domínio do app (padrão: <ip>.sslip.io, grátis e sem cadastro)
#   LK_DOMAIN=midia.meudominio.com  domínio do servidor de mídia (padrão: lk.<ip>.sslip.io)
#   REPO=https://github.com/USUARIO/straighttalk.git   de onde baixar o código
#   DIR=/opt/straighttalk        onde instalar
set -euo pipefail

REPO="${REPO:-https://github.com/thiagowelter2011-collab/straighttalk.git}"
DIR="${DIR:-/opt/straighttalk}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root (sudo)."; exit 1; fi

say "Instalando Docker e ferramentas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl ufw >/dev/null
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null

say "Baixando o StraightTalk"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../server.js" ]; then
  DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR/deploy"

say "Configurando domínios e chaves"
IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
DASHED="${IP//./-}"
if [ -f .env ]; then
  # Reinstalação: mantém chaves e domínios
  set -a; . ./.env; set +a
fi
APP_DOMAIN="${DOMAIN:-${APP_DOMAIN:-$DASHED.sslip.io}}"
LK_DOMAIN="${LK_DOMAIN:-lk.$DASHED.sslip.io}"
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-API$(openssl rand -hex 6)}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-$(openssl rand -hex 24)}"

cat > .env <<EOF
APP_DOMAIN=$APP_DOMAIN
LK_DOMAIN=$LK_DOMAIN
LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
EOF
chmod 600 .env

cat > livekit.yaml <<EOF
# Gerado pelo setup.sh
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
turn:
  enabled: true
  domain: $LK_DOMAIN
  udp_port: 3478
  tls_port: 0
  relay_range_start: 30000
  relay_range_end: 40000
logging:
  level: info
EOF
chmod 600 livekit.yaml
mkdir -p data

say "Abrindo portas no firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 7881/tcp >/dev/null        # mídia via TCP (redes que bloqueiam UDP)
ufw allow 7882/udp >/dev/null        # mídia via UDP
ufw allow 3478/udp >/dev/null        # TURN
ufw allow 30000:40000/udp >/dev/null # portas de retransmissão do TURN
ufw --force enable >/dev/null

say "Subindo os serviços (a primeira vez demora alguns minutos)"
docker compose up -d --build

say "Esperando o HTTPS ficar pronto"
for i in $(seq 1 60); do
  if curl -fsS "https://$APP_DOMAIN/healthz" >/dev/null 2>&1; then break; fi
  sleep 5
done

if curl -fsS "https://$APP_DOMAIN/healthz" >/dev/null 2>&1; then
  printf '\n\033[1;32mPronto! O StraightTalk está no ar em: https://%s\033[0m\n' "$APP_DOMAIN"
else
  printf '\n\033[1;33mOs serviços subiram, mas o HTTPS ainda não respondeu.\033[0m\n'
  echo "Confira: docker compose -f $DIR/deploy/docker-compose.yml logs caddy"
fi
echo "Banco de dados: $DIR/deploy/data/straighttalk.db (faça backup desse arquivo)"
echo "Atualizar depois: cd $DIR && git pull && cd deploy && docker compose up -d --build"
