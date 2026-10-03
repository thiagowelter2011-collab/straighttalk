# Hospedar de graça (Render + Turso + LiveKit Cloud)

Três serviços grátis, cada um com uma parte:

| Serviço | Para quê | Limite do plano grátis |
|---|---|---|
| **Render** | O site (chat, contas, convites) | Dorme após 15 min sem visitas (o workflow "Manter acordado" evita) |
| **Turso** | Banco de dados (contas, servidores, mensagens) | 5 GB, sobra |
| **LiveKit Cloud** | Voz e compartilhamento de tela, com servidores no Brasil | ~5.000 minutos de participante por mês |

Todos aceitam entrar com a conta do GitHub.

## 1. Turso (banco)

1. Entre em https://turso.tech e crie a conta.
2. Crie um banco chamado `straighttalk` na região **AWS US East (Virginia)** (a mesma do site, para ficar rápido).
3. No banco, copie a **URL** (começa com `libsql://`) e gere um **token**. Guarde os dois.

## 2. LiveKit Cloud (voz e tela)

1. Entre em https://cloud.livekit.io e crie um projeto.
2. Em **Settings → API Keys**, crie uma chave. Guarde a **URL** (começa com `wss://`), a **API Key** e a **API Secret** (ela só aparece uma vez).

## 3. Render (site)

1. Clique: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/thiagowelter2011-collab/straighttalk)
2. Conecte o GitHub se ele pedir e preencha:

| Campo | O que colar |
|---|---|
| `DATABASE_URL` | URL do Turso (`libsql://...`) |
| `DATABASE_AUTH_TOKEN` | Token do Turso |
| `LIVEKIT_URL` | URL do LiveKit (`wss://...livekit.cloud`) |
| `LIVEKIT_API_KEY` | API Key do LiveKit |
| `LIVEKIT_API_SECRET` | API Secret do LiveKit |

3. Clique em **Deploy Blueprint** e espere ficar "Live". O link fica no topo da página do serviço, algo como `https://straighttalk.onrender.com`.

## 4. Deixar sempre acordado

No GitHub do projeto: **Settings → Secrets and variables → Actions → Variables → New repository variable**, nome `STRAIGHTTALK_URL`, valor o link do Render. O workflow "Manter acordado" passa a visitar o site a cada 10 minutos.

A mesma variável faz o app de Windows já abrir nesse endereço: rode de novo o workflow **App para Windows** na aba Actions.

## Atualizar

Todo commit na branch `main` é publicado sozinho no Render.
