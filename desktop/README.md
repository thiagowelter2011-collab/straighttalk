# StraightTalk para Windows

App de desktop (Electron) que abre o seu servidor StraightTalk numa janela própria.

- Seletor de tela/janela para compartilhar, com **áudio do computador** (Windows)
- Continua com a voz fluida mesmo minimizado
- Lembra o endereço do servidor (troque com **Ctrl+Shift+S**)

## Baixar

Na aba **Actions** do repositório, rode o fluxo **App para Windows** e baixe o artefato
`StraightTalk-Windows`, ou pegue o `.exe` na página de **Releases**.

- `StraightTalk-…-nsis.exe`: instalador (cria atalho na área de trabalho)
- `StraightTalk-…-portatil.exe`: abre direto, sem instalar

> O Windows pode mostrar "O Windows protegeu o computador" porque o app não tem assinatura
> digital paga. Clique em **Mais informações → Executar assim mesmo**.

## Desenvolver

```bash
cd desktop
npm install
npm start          # abre o app (pergunta o servidor na primeira vez)
npm run dist       # gera os .exe em desktop/dist (rode no Windows)
```

O endereço padrão do servidor fica em `package.json` → `straighttalk.serverUrl`
(ou na variável `STRAIGHTTALK_URL`).
