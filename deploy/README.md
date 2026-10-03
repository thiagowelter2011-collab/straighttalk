# Colocar o StraightTalk no ar (link fixo, sempre ligado)

Uma VPS com Ubuntu roda tudo: o app, o servidor de mídia (LiveKit, com TURN) e o HTTPS.
Recomendado: **Vultr, região São Paulo**, plano de 1 vCPU / 1–2 GB (cerca de US$ 5–6 por mês).

## Passo a passo

1. Crie a VPS: **Ubuntu 24.04**, região **São Paulo**.
2. Entre nela pelo console do painel (ou `ssh root@IP`) e rode:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/thiagowelter2011-collab/straighttalk/main/deploy/setup.sh | bash
   ```

3. No fim aparece o link, no formato `https://1-2-3-4.sslip.io` (o IP da VPS com traços).
   Não precisa comprar domínio. Se tiver um, rode com `DOMAIN=chat.seudominio.com LK_DOMAIN=midia.seudominio.com`
   e aponte os dois nomes para o IP da VPS antes.

## Portas usadas

| Porta | Para quê |
|---|---|
| 80, 443/tcp | Site (HTTPS) |
| 7881/tcp | Mídia por TCP (redes que bloqueiam UDP) |
| 7882/udp | Mídia por UDP (o caminho mais rápido) |
| 3478/udp e 30000–40000/udp | TURN (redes fechadas) |

O `setup.sh` já abre essas portas no firewall da VPS. Se o provedor tiver firewall no painel
(AWS Lightsail tem), abra as mesmas portas lá.

## Manutenção

```bash
cd /opt/straighttalk && git pull && cd deploy && docker compose up -d --build   # atualizar
docker compose -f /opt/straighttalk/deploy/docker-compose.yml logs -f           # ver logs
cp /opt/straighttalk/deploy/data/straighttalk.db ~/backup-$(date +%F).db         # backup
```
