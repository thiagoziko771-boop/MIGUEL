---
name: testar-funil
description: Roda as baterias de teste do Rezas Sagradas — integração PixGo contra um servidor falso, relógio do botão de compra, responsividade em 6 telas e a compra inteira até /obg. Use antes de commitar qualquer mudança em checkout, gateway ou tela, ou quando pedirem "testa o funil", "roda os testes", "confere se está tudo passando".
---

# Testar o funil

Nenhum destes testes cria cobrança real. **Nunca teste com a chave de produção
apontada para a PixGo de verdade** — não existe sandbox lá.

## 1. Sempre primeiro: tipos

```bash
npm run lint    # tsc --noEmit
```

## 2. Integração com a PixGo (não precisa de navegador)

Sobe uma PixGo falsa local que confere o que mandamos e devolve as respostas
documentadas, inclusive o 410 dos estados finais, e assina callbacks como eles
assinam.

```bash
node scripts/testar-pixgo.mjs
```

Esperado: **24 de 24**. Ele roda o servidor a partir de uma pasta vazia de
propósito — não mude isso (veja `.claude/DECISOES.md`).

## 2b. Rastreamento do Meta (não precisa de navegador)

Sobe uma PixGo falsa **e** um Meta falso. Cobre desde o carimbo do anúncio no
navegador (com `window` e `localStorage` simulados) até o `Purchase` que sai do
servidor, incluindo os casos em que o Facebook está fora do ar.

```bash
node scripts/testar-rastreamento.mjs
```

Esperado: **51 de 51**. Se falhar por "já existe um servidor na porta 3337", é
sobra de execução anterior — no Windows, matar o processo deixa o filho vivo.

## 3. Testes de navegador

Precisam do Playwright instalado **fora** do projeto (ele baixa um Chromium
inteiro; como dependência pesaria em todo build da Vercel):

```bash
mkdir ~/teste-funil && cd ~/teste-funil
npm i playwright && npx playwright install chromium
```

### Relógio do botão de compra

O segundo argumento é o valor de `OFFER_DATA.segundosAteOCta`, em
`src/data/funnelData.ts`. Passe o valor atual — as asserções se ajustam sozinhas,
inclusive para zero.

```bash
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-cta.mjs http://localhost:4300 260
```

Esperado: **12 de 12**.

### Responsividade e compra completa

Estes dois precisam do backend em modo mock e do front apontado para ele. Em dois
terminais:

```bash
PIX_MODE=mock PORT=3334 npx tsx server/index.ts
PORT=3334 npx vite --port=4300 --strictPort
```

Depois:

```bash
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-responsividade.mjs http://localhost:4300
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pagina-obrigado.mjs http://localhost:4300
```

Esperado: **6 de 6 telas** e **8 de 8**.

## 4. Produção (só leitura)

```bash
curl -s https://rezassagradas.vercel.app/api/health
```

Deve responder `status: ok`, `mode: live`, `storage: postgres`,
`webhookConfigured: true`, e o consumo de consultas do dia.

## Ao relatar o resultado

Diga os números de cada bateria que rodou e o que deixou de rodar, com o motivo.
Se um teste passar mas você não tiver certeza de que ele mediu a página de
verdade, desconfie: o de responsividade já aprovou o funil inteiro enquanto ele
não renderizava. Cada etapa precisa provar que renderizou antes de ser medida.

No Windows, se um teste reclamar de porta ocupada, é sobra de execução anterior —
matar o processo costuma deixar o filho vivo escutando.
