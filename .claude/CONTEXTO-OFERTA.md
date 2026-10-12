# Contexto da oferta — Rezas Sagradas

Atualizado em 07/08/2026.

## O negócio

Venda de produtos digitais devocionais cristãos por PIX, com tráfego pago (Google
Ads). O produto de entrada é uma "Oração Sagrada do Arcanjo Miguel" apresentada
como personalizada a partir das respostas que a própria pessoa deu num quiz.

## O cliente / dono

O repositório **não registra** o nome da pessoa ou da empresa. O que o código
assume sobre ela — e vale confirmar por escrito:

- não é programadora;
- opera o negócio pelo painel `/admin`, no celular;
- anuncia no Google Ads (a página `/obg` existe só para ser o endereço de
  conversão da campanha);
- é quem responde o cliente no WhatsApp quando o PIX não entra.

Por isso todo texto de painel e de erro é escrito na língua dela: "Aguardando" e
não "pending", "O sistema de Pix recusou" e não "gateway error 502", "Oração" e
não "offer main".

**Lacunas:** nome e contato do cliente, domínio próprio (hoje roda em
`rezassagradas.vercel.app`), conta do Google Ads, quem responde o WhatsApp, quem
grava os vídeos de depoimento.

## O público que compra

Adulto, majoritariamente mais velho, de fé, no celular, com pouca intimidade com
tecnologia. Consequências diretas no produto:

- PIX em vez de cartão;
- CPF pedido de forma explícita, com o motivo dito na tela (é o CPF que trava
  quem pode pagar o QR);
- tutorial em vídeo vendido junto do aplicativo, no upsell;
- alvos de toque grandes, campos de 16 px, nada de jargão;
- a pessoa some para o app do banco e volta — o checkout precisa retomar de onde
  estava, e retoma.

## Escada de produtos

| ID | Tipo | Título | Preço |
| --- | --- | --- | --- |
| `main` | principal | Oração Sagrada do Arcanjo Miguel | R$ 27,00 |
| `salmos_150` | order bump (pré-marcado) | Guia dos 150 Salmos | R$ 10,00 |
| `vela_7dias` | order bump | Vela Sagrada de 7 Dias | R$ 14,90 |
| `upsell` | upsell | Aplicativo Espiritual completo + tutorial | R$ 47,00 |
| `downsell` | downsell | Aplicativo Espiritual Essencial | R$ 14,90 |

Ticket de R$ 27,00 a R$ 98,90. Fonte da verdade: `server/catalog.ts` — o navegador
manda IDs, o servidor recalcula.

A PixGo recusa qualquer cobrança abaixo de **R$ 10,00** (INVALID_AMOUNT). Isso
vale para downsell e upsell, que são cobrados sozinhos. Os order bumps não têm
esse piso porque só somam ao pedido principal.

Um cliente gera **até três pedidos separados** (`main`, `upsell`, `downsell`),
ligados por `parentOrderId`. Somar todos os pedidos pagos como "vendas" infla o
número e destrói o ticket médio — regra que vale para qualquer relatório futuro.

## A promessa (e o que ela custa)

A copy promete, hoje, em `src/data/funnelData.ts` e em `public/`:

- "destravar bênçãos financeiras e curas inexplicáveis em apenas 24 horas";
- "Entre milhares... você foi um dos selecionados";
- depoimentos de cura ("os exames voltaram normais"), de dinheiro ("aposentadoria
  liberada", "quitei a dívida da casa em 15 dias") e de paz familiar;
- garantia incondicional de 30 dias com devolução integral.

Três problemas conhecidos, todos ainda abertos:

1. **Promessa de resultado de saúde e de dinheiro com prazo** é o tipo de
   afirmação que derruba conta de anúncio e atrai questionamento pelo CDC.
2. **Os depoimentos usam fotos de banco de imagens** (Unsplash) como se fossem
   pessoas reais; um dos três vídeos nem existe.
3. **A garantia de 30 dias não tem processo de reembolso** por trás. Prometida na
   copy, inexistente na operação.

Isso não é opinião sobre a fé de ninguém — é sobre o que pode ser afirmado como
fato numa peça de venda.

## Dados pessoais que o sistema guarda

Nome, e-mail, telefone, **CPF completo** e IP do cliente. A API pública nunca
devolve o CPF completo (existe `maskDocument`), mas as rotas autenticadas do
painel devolvem — é o ponto do painel. Falta: política de privacidade, base legal
do tratamento do CPF, prazo de retenção e restrição de acesso.

## Onde está publicado

- Produção: `https://rezassagradas.vercel.app` (projeto Vercel `rezassagradas`)
- Conferido em 07/08/2026: `mode: live`, `storage: postgres`,
  `webhookConfigured: true`
- `/obg` responde 200, `/admin` responde 200, **`/leads` responde 404** — o
  rewrite existe, a página não.
