# Miguel te Chama — variante do funil Arcanjo Miguel

> **ESTE NÃO É O REPOSITÓRIO PRINCIPAL.** É a variante que roda em
> `migueltechama.vercel.app`, separada do `rezas-sagradas-funil-arcanjo-miguel`
> (que serve o `rezassagradas.site`) em 19/08/2026 para um teste A/B.
>
> **Os dois compartilham o MESMO banco Neon.** Não é descuido: os dois domínios
> alimentam o mesmo painel, então o A/B se compara na mesma tabela e nenhum
> pedido fica órfão quando o tráfego mudar de lado. A consequência é que uma
> migração de esquema feita aqui atinge o outro site na hora — confira os dois
> antes de mexer em tabela.
>
> **O que diverge entre os dois** deve ser anotado aqui embaixo, sempre. Num
> teste A/B, divergência não registrada é o que transforma um resultado em
> palpite: quando os números diferirem, sem esta lista ninguém sabe se foi a
> mudança que se queria medir ou sujeira acumulada.
>
> Divergências até agora:
>
> | O quê | Aqui | No rezassagradas.site |
> | --- | --- | --- |
> | Domínio | `migueltechama.vercel.app` | `rezassagradas.site` |
> | E-mail | desligado | Resend, ativo |
> | Pixel do TikTok | cadastrado e disparando | mesmo pixel (vem do banco) |
> | Senha do painel | própria, trocada em 19/08 | a original |
>
> O resto do documento vale para os dois.

---

# Rezas Sagradas — Funil Arcanjo Miguel

Funil de vendas de produtos digitais devocionais, com quiz de 9 perguntas, VSL e
checkout PIX embutido. React (Vite) no navegador, Express/TypeScript no servidor,
Postgres (Neon), hospedado na Vercel como uma única função serverless.

**Dinheiro real passa por aqui.** O gateway não tem ambiente de teste: toda chave
é de produção e toda cobrança criada é dinheiro de verdade. Leia
[ESTADO-DO-PROJETO.txt](ESTADO-DO-PROJETO.txt) antes de mexer em qualquer coisa —
ele diz onde o projeto parou e o que ainda falta.

## Documentos de contexto

| Arquivo | Para quê |
| --- | --- |
| [ESTADO-DO-PROJETO.txt](ESTADO-DO-PROJETO.txt) | Retrato do estado atual: o que está pronto, o que falta, onde paramos |
| [.claude/CONTEXTO-OFERTA.md](.claude/CONTEXTO-OFERTA.md) | O negócio, o público, a escada de produtos, a copy |
| [.claude/ROADMAP.md](.claude/ROADMAP.md) | O que vem a seguir, em ordem, com o motivo |
| [.claude/DECISOES.md](.claude/DECISOES.md) | Decisões técnicas e o porquê de cada uma |
| [README.md](README.md) | Integração com a PixGo, limites, endpoints |
| [PROMPT-PAINEL-ADMIN.md](PROMPT-PAINEL-ADMIN.md) | Especificação completa do painel — o cabeçalho sobre gateway está desatualizado (voltou a ser PixGo) |

## Idioma

Respostas, explicações e mensagens de commit em **português do Brasil**. Código,
nomes de variáveis e comandos em inglês quando for o padrão da linguagem — mas
neste projeto boa parte do backend já usa nomes em português (`repositorioDoPainel`,
`conferirBloqueio`, `assinaturaConfere`). Siga o arquivo que estiver editando.

## Como escrever código aqui

Comentários explicam **por que**, não o que. O padrão do repositório é registrar a
consequência real de cada decisão — o que quebraria se fosse feito de outro jeito,
de preferência com o caso concreto que já aconteceu. Um comentário que só repete o
código não vale a linha que ocupa.

Mensagens de commit seguem o mesmo espírito: título curto no imperativo, corpo
explicando o problema que existia, por que a solução é essa e o que foi testado
com quais números.

## Regras que não se negociam

1. **O frontend nunca decide que um pagamento aconteceu.** Quem libera acesso é o
   servidor, sempre.
2. **Nada vindo do corpo de um webhook é verdade**, nem depois da assinatura
   conferir. Dele sai só o identificador; o status vem de consulta nossa à API.
3. **Preço só existe em [server/catalog.ts](server/catalog.ts).** O navegador
   manda IDs de produto, nunca valores.
4. **`PIX_MODE` tem padrão `live`.** Cair em `mock` por variável ausente entregaria
   produto de graça. Nunca inverta esse padrão "para facilitar o teste".
5. **Status desconhecido do gateway cai em `pending`.** Inventar "pago" a partir de
   um nome que não conhecemos entrega produto sem pagamento.
6. **Comparação de status é por igualdade exata.** `includes` transformaria
   `unpaid` em `paid`.
7. **Todo o contato com o gateway vive em [server/pix.ts](server/pix.ts).** O resto
   do sistema conhece `createPayment` e `fetchPaymentStatus` e mais nada.
8. **Na Vercel, nada de promessa solta.** A função pode congelar assim que
   responde: toda gravação precisa ser aguardada antes da resposta, com timeout
   curto e `try/catch` que não derruba a ação principal.
9. **Nunca commite `.env.local`, `.data/` ou qualquer coisa com CPF de cliente.**
10. **Não crie cobrança real para testar.** Use `PIX_MODE=mock` ou
    `node scripts/testar-pixgo.mjs`, que sobe uma PixGo falsa local.
11. **Rastreamento e e-mail nunca derrubam venda.** Todo envio ao Meta e ao
    provedor de e-mail é aguardado com orçamento curto, engole o próprio erro e
    vira pendência reenviável. Se falhar, a cobrança, a confirmação e a entrega
    seguem iguais — o cliente pagou, o produto é dele.
12. **A compra só existe se o servidor confirmou.** `POST /api/track` não aceita
    `Purchase` nem valor em dinheiro — a rota é pública.
13. **NADA sai daqui para plataforma de anúncio.** Meta Pixel, API de
    Conversões e TikTok Pixel foram removidos em 21/08/2026. A conversão vive
    na tabela `conversoes` e sai por `GET /admin/conversoes.csv`. Religar
    envio automático é decisão do dono, nunca efeito colateral de outra tarefa.
14. **A conversão só nasce em `applyStatus`, com pagamento confirmado.** QR
    gerado, PIX copiado ou checkout aberto não viram venda. `order_id` é
    PRIMARY KEY: a reentrega do webhook não duplica.
15. **Resposta de quiz não entra em tabela de medição.** O texto da pergunta e
    da opção saiu do tracking em 21/08/2026 — eram respostas sobre medo,
    dinheiro, inveja e fé ao lado de nome, e-mail e IP. O que fica é `step`.
    O **pedido de oração** é exceção deliberada: é fluxo funcional, o dono
    precisa ler o que a pessoa escreveu, e nunca sai para lugar nenhum.

## Comandos

```bash
npm run dev:server           # backend  -> http://localhost:3333
npm run dev                  # frontend -> http://localhost:3000
PIX_MODE=mock npm run dev:server   # sem gerar cobrança real
npm run lint                 # tsc --noEmit
npm run build                # gera dist/
```

Testes (rodados à mão, nenhum em CI). Os de navegador precisam do Playwright
instalado **fora** do projeto, para não pesar no build da Vercel.

O servidor que atende as baterias de navegador precisa de três variáveis fora do
padrão, e cada uma evita um alarme falso que já custou tempo aqui:
`MOCK_CONFIRM_DELAY_MS=600000` (senão a cobrança falsa se confirma no meio da
bateria e a tela troca para o upsell), `RATE_LIMIT_MAX_ORDERS=500` (senão o
freio de 12 pedidos por 10 min impede a criação do PIX) e
`STATUS_POLL_MIN_INTERVAL_MS=0`. Apague também o `orders.json` do `DATA_DIR`
entre execuções: ele fica na RAIZ da pasta, não em `.data/`, e um pedido velho
reaproveitado aponta para um pagamento falso que não existe mais na memória do
processo — a cobrança nunca se confirma e a bateria trava esperando o upsell.

```bash
mkdir ~/teste-funil && cd ~/teste-funil && npm i playwright && npx playwright install chromium

node scripts/testar-precos.mjs                                         # a tela diz o que o servidor cobra
node scripts/testar-pixgo.mjs                                          # 28 casos, PixGo falsa
node scripts/testar-zuckpay.mjs                                        # 40 casos, ZuckPay falsa
node scripts/testar-utmify.mjs                                         # 33 casos, Utmify falsa
# Precisa de `npm run build` antes: confere o BUNDLE, nao o codigo-fonte.
node scripts/testar-mensuracao.mjs                                     # 25 casos, mensuracao propria
node scripts/testar-email.mjs                                          # 26 casos, provedor de e-mail falso
node scripts/testar-rastreamento.mjs                                   # 110 casos, Meta falso
node scripts/testar-painel-anuncios.mjs                                # 78 casos, contas da aba Anúncios
node scripts/testar-custos.mjs                                         # 50 casos, a conta do lucro (npx tsx)
node scripts/testar-aba-resumo.mjs                                     # 33 casos, aba Resumo ponta a ponta
node scripts/testar-gasto-por-bm.mjs                                   # 45 casos, gasto de cada BM na conta dela
node scripts/testar-discord.mjs                                        # 34 casos, avisos de venda no Discord
node scripts/testar-lembrete-whatsapp.mjs                              # 33 casos, lembrete que NAO cobra
# O carimbo da BM manda no pixel do navegador. Faz o build sozinho, com
# VITE_META_PIXEL_ID definido -- sem essa variavel o defeito nao acontece.
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pixel-no-navegador.mjs
node scripts/testar-painel-funil.mjs                                   # 37 casos, contas da aba Funil
node scripts/testar-investimento-meta.mjs                              # 33 casos, gasto vindo do Meta
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-videos.mjs            # vídeo carrega tarde, mas carrega
# A tela do PIX: ordem QR -> copia e cola -> botão, cópia de verdade, tutorial.
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-tela-pix.mjs <url>
# A mensagem de recuperação: só para quem volta, e nunca para quem acabou de pagar.
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-retomada.mjs <url>
# O número é o `segundosAteOCta` de src/data/funnelData.ts, e precisa ser o de
# lá: passar o valor velho reprova um relógio que está certo.
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-cta.mjs <url> 242     # relógio do botão
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-audio.mjs <url>       # a gravação toca mesmo
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-prova-social.mjs <url> # avisos do checkout
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pulso.mjs <url>       # pulso dos botoes de compra
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-responsividade.mjs <url>
PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pagina-obrigado.mjs <url>
```

## Onde as coisas ficam

```
src/App.tsx                     ordem das 14 telas do funil + o evento de cada
                                etapa, que é o que alimenta a aba Funil
src/data/funnelData.ts          TODA a copy + segundosAteOCta (242 s)
src/components/OfferScreen.tsx  VSL e o relógio do botão de compra
src/components/InlineCheckout.tsx  checkout, bumps, upsell, downsell
src/lib/attribution.ts          carimbo do anúncio, capturado na primeira carga
src/lib/rastreio.ts             ponto único de disparo de evento no navegador
server/catalog.ts               preços — fonte única da verdade
server/pix.ts                   único arquivo que conhece o gateway de PIX
                                (PixGo, SyncPay e ZuckPay — `PIX_PROVIDER` escolhe)
server/mensuracao.ts            mensuração PRÓPRIA: passagem pelo funil e a
                                conversão interna. NÃO fala com plataforma
                                nenhuma (Meta e TikTok saíram em 21/08/2026)
server/metaAnuncios.ts          Marketing API: lê gasto e altera orçamento/status
                                de anúncio. NÃO envia evento nem conversão
server/email.ts                 único arquivo que conhece o provedor de e-mail
server/utmify.ts                único arquivo que conhece a Utmify — painel de
                                relatório DELES, não caminho para o Meta
server/brcode.ts                lê o copia e cola do PIX: nominal e liquidante
server/metaCredenciais.ts       de onde saem pixel e token (painel > ambiente)
server/investimento.ts          lê a planilha de gasto dos anúncios
server/metaAnuncios.ts          traz o gasto direto da API de Marketing do Meta
server/routes/cron.ts           o que roda sozinho (agendado no vercel.json)
server/painel/repositorio.ts    banco do painel, inclui a tabela `conversoes`
server/routes/track.ts          POST /api/track (público, lista branca)
server/orders.ts                criar, aplicar status, reconciliar, acesso
server/routes/webhook.ts        callback assinado
server/routes/admin.ts          backend do painel
server/config.ts                todas as variáveis de ambiente
api/index.ts                    entrada da Vercel
public/admin.*                  painel do dono (HTML/CSS/JS puros, sem build)
public/obg.html                 página de obrigado — conversão do Google Ads
```

## Agentes deste projeto

Em [.claude/agents/](.claude/agents/):

- **rezas-sagradas** — dono do contexto da oferta: copy, funil, roadmap, decisões
  de produto. Comece por ele quando a pergunta for "o que fazer".
- **checkout-pix** — gateway, webhook, pedidos, painel, entrega. Use quando
  dinheiro estiver envolvido.
- **conversao-funil** — quiz, VSL, timing do CTA, responsividade, o que medir.

## Antes de dizer que terminou

- `npm run lint` passa;
- se mexeu no checkout ou no gateway: `node scripts/testar-pixgo.mjs` E
  `node scripts/testar-zuckpay.mjs` passam (o segundo cobre o provedor ativo);
- se mexeu na aba Anúncios ou em como o gasto vira métrica:
  `node scripts/testar-painel-anuncios.mjs` passa;
- se mexeu em como o gasto e atribuido a cada BM:
  `node scripts/testar-gasto-por-bm.mjs` passa;
- se mexeu em custo, taxa, imposto ou no que a aba Resumo mostra:
  `npx tsx scripts/testar-custos.mjs` e `node scripts/testar-aba-resumo.mjs`
  passam — o segundo precisa de `npm run build` antes se for rodar a tela;
- se mexeu em tela: rodou o teste de navegador correspondente e diz os números;
- se mexeu em preço, prazo ou promessa: `node scripts/testar-precos.mjs` passa
  — ele confere sozinho se a tela ainda diz o que o servidor cobra, e se as
  âncoras riscadas e os selos de desconto continuam verdadeiros;
- atualizou [ESTADO-DO-PROJETO.txt](ESTADO-DO-PROJETO.txt) e
  [.claude/ROADMAP.md](.claude/ROADMAP.md) se o estado mudou.
