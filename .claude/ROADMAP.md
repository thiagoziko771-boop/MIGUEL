# Roadmap — Rezas Sagradas

Atualizado em 07/08/2026. Ordem por consequência, não por facilidade.

Legenda: `[ ]` a fazer · `[~]` em andamento · `[x]` feito

---

## AGORA — trabalho aberto na mesa

- [x] **ZuckPay ligada** (20/08/2026), atrás de `PIX_PROVIDER=zuckpay`. Motivo:
  desde 17/08 22:50 nenhuma venda se confirma — 8 PIX gerados pela SyncPay, zero
  pagos, e o próprio gateway responde `pending`/`expired` na reconsulta. O código
  vive em `server/pix.ts` como terceiro dialeto; Basic auth a cada chamada, sem o
  Bearer de 1 h que a SyncPay exige. 40 checagens em `testar-zuckpay.mjs`, e as
  baterias da PixGo (28) e da SyncPay continuam passando.

  Quatro defeitos que só existiriam com ela ligada, corrigidos junto:
  1. o postback traz `transaction.external_id` (referência INTERNA deles) ao
     lado do `id`, e a lista genérica de chaves procurava `external_id` antes —
     TODO callback cairia em "pedido desconhecido" e nenhuma venda se
     confirmaria pelo webhook;
  2. `EXPIRADO` (em português, no meio de uma lista em inglês) caía no padrão
     "pendente": o pedido nunca seria marcado como vencido e ficaria sendo
     reconsultado para sempre;
  3. `REFUSED` idem, virando fila de recuperação com gente que não vai pagar;
  4. a tela do PIX só desenhava o QR localmente quando o gateway NÃO mandava
     imagem. A ZuckPay manda (`qrcode_image`, um `qr.php` no domínio deles) — e
     a tela passaria a depender de um terceiro para mostrar o QR. Agora o
     desenho local é sempre o principal.

  - [ ] **falta o dono**: pôr `PIX_PROVIDER=zuckpay`, `ZUCKPAY_CLIENT_ID` e
        `ZUCKPAY_CLIENT_SECRET` na Vercel; deixar a lista "IPs Autorizados"
        VAZIA no painel deles (a Vercel não tem IP fixo — qualquer entrada faz
        toda cobrança voltar 403); cadastrar o postback em
        `https://migueltechama.vercel.app/api/webhooks/zuckpay`.
  - [ ] **teste real de R$ 10 depois de subir**: qual nome a ZuckPay estampa no
        campo 59 do QR. É o motivo de a PixGo ter saído ("PRIME UNION TRADING
        FIN" fazia o banco do cliente marcar como suspeito), e é o único dado
        que nenhuma bateria consegue medir daqui.
  - [ ] opcional, e vale: gerar o segredo do postback em `/conta/keys.php` e
        pôr em `ZUCKPAY_WEBHOOK_SECRET`. Sem ele o aviso chega sem assinatura e
        é aceito (o status vem sempre de reconsulta, então não libera nada
        indevido) — mas qualquer um que descubra a URL nos faz gastar consulta.
  - [ ] a ZuckPay aceita `utm_*`, `fbc`, `fbp` e `gclid` na criação da cobrança
        e devolve tudo no postback. Não mandamos nada disso ainda: `attribution`
        não chega em `CreatePaymentInput`. Renderia atribuição de venda dentro
        do painel deles, sem depender do nosso.

- [x] **Aba Resumo e modelo de custo** (19/08/2026). "Lucro" no painel era
  `faturamento − anúncio`: sem taxa do gateway, sem imposto sobre a venda e sem
  o imposto que a Meta cobra por fora do leilão. Medido na bateria: sobre
  R$ 141,00 de faturamento o painel dizia R$ 91,00 e o certo era R$ 67,49 —
  16,7% de erro, sempre para mais. `server/custos.ts` + `server/resumo.ts` +
  aba Resumo. 50 checagens em `testar-custos.mjs`, 33 em `testar-aba-resumo.mjs`.
  - [ ] **falta o dono preencher** em /admin → Resumo → "Quanto custa vender":
        taxa da SyncPay (% e fixo), imposto sobre venda, imposto da fatura da
        Meta. Sem isso os cartões de custo ficam zerados — e a tela avisa.
  - [x] gasto por conta de anúncios (19/08/2026): cada BM importa da conta dela,
        com o token dela, e o Resumo passou a aceitar `?bm=`. 45 checagens em
        `testar-gasto-por-bm.mjs`.


- [x] **Mudanças da tela da oferta commitadas e no ar** (`448e1ae`): vídeo da VSL
  começando parado com play grande, e o relógio do botão recontando a cada
  entrada na VSL. Desfaz de propósito a parte do `sessionStorage` do `3b859d0`.
  - [ ] ainda devendo: rodar `testar-cta.mjs` (a fonte do relógio mudou)
  - [ ] ainda devendo: conferir no celular que o play aparece e o som sai

- [~] **Rastreamento do Meta — no ar, esperando as credenciais.** Publicado em
  08/08/2026 e testado (109/109 em `testar-rastreamento.mjs`). Falta o que só o
  dono faz, na ordem:
  - [ ] **colar pixel e token** em `/admin` → Anúncios → Credenciais do Meta e
        apertar "Testar conexão" — 2 minutos, sem deploy
  - [ ] **comprar o domínio próprio** (pré-requisito, ver abaixo)
  - [ ] criar o conjunto de dados no Gerenciador de Eventos e gerar o token
  - [ ] verificar o domínio e configurar os Eventos Agregados com `Purchase` em 1º
  - [x] `PAINEL_CHAVE_MESTRA` já está na Vercel — é ela que permite guardar o
        token cifrado pelo painel (conferido em 08/08/2026)
  - [ ] no anúncio: marcar "Eventos do site" e colar os parâmetros de URL
  - [ ] conferir com o código de teste e **apagá-lo depois**
  - [ ] confirmar a nota de correspondência acima de 8 no Gerenciador de Eventos

---

## BLOQUEIA ESCALAR ANÚNCIO — cliente paga e não recebe

Enquanto qualquer um destes estiver aberto, aumentar investimento em tráfego só
aumenta o número de pessoas insatisfeitas.

- [ ] **Envio de e-mail com os acessos.** A tela promete o e-mail e nada é
      enviado. Quem fecha a aba antes de anotar o link perde o que comprou.
      Decidir provedor (Resend/SES/SMTP), e lembrar da Vercel: a função pode
      congelar assim que responde, então o envio precisa ser aguardado antes da
      resposta, com timeout curto e falha que não derruba a confirmação.
- [ ] **Preencher as `DELIVERY_URL_*`** com os links reais dos cinco produtos.
      Dá para fazer sem deploy, pela aba Entregas do painel.
- [ ] **Conferir as variáveis de ambiente da Vercel**: `DATABASE_URL`,
      `ADMIN_SENHA`, `PAINEL_CHAVE_MESTRA`, `PUBLIC_BASE_URL`, `TRUST_PROXY=true`.
      O `.env.local` desta máquina só tem as duas chaves da PixGo.
- [ ] **Domínio próprio** (ex.: `rezassagradas.com.br`, ~R$ 40/ano). Deixou de
      ser detalhe: `.vercel.app` é DNS compartilhado e **não pode ser verificado
      no Meta**, e sem verificação de domínio não há Configuração de Eventos
      Agregados — que é o que faz a compra vinda de iPhone ser atribuída. Também
      pesa na confiança de quem vai pagar: link `.vercel.app` cheira a teste.
      Ao trocar, mudam junto `PUBLIC_BASE_URL` e a URL de callback da PixGo.
- [ ] **Primeira compra real de ponta a ponta**, com valor mínimo, conferindo:
      cobrança criada, webhook chegando assinado, status confirmado, acesso
      liberado, `/obg` mostrando os produtos. Sem sandbox, é o único jeito de
      validar a integração de verdade.

## JURÍDICO E CONFORMIDADE — risco de perder a conta de anúncio

- [ ] **Revisar a copy** frente ao CDC e às políticas de anúncio: promessa de cura
      e de dinheiro com prazo ("24 horas"), "milhares de selecionados",
      depoimentos com foto de banco de imagens. É o item mais capaz de derrubar o
      negócio de uma vez.
- [ ] **Política de privacidade e termos**, com a base legal do tratamento do CPF.
      **Esta pendência cresceu com o rastreamento**: agora o sistema também envia
      dados pessoais (hasheados) ao Meta, empresa fora do Brasil. A política
      precisa dizer isso — transferência internacional e compartilhamento com
      terceiros para publicidade. Um aviso de cookies com consentimento passa a
      ser recomendável.
- [ ] **Prazo de retenção e restrição de acesso** aos dados (LGPD). Guardamos CPF,
      nome, e-mail, telefone, IP e agora o user agent completo e os
      identificadores de anúncio.
- [ ] **Processo de reembolso** — a garantia de 30 dias é prometida e não existe
      procedimento.

## OPERAÇÃO DO DONO — o que ele precisa resolver sozinho

- [ ] **`/leads`** — o rewrite está no `vercel.json` e no `vite.config.ts`, mas não
      existe `public/leads.html` nem `server/routes/leads.ts`; em produção dá 404.
      Especificação pronta na PARTE 12 do `PROMPT-PAINEL-ADMIN.md`.
- [ ] **Aba Relatórios** do `/admin` (fechamento diário) — PARTE 7.
- [ ] **Aba Acessos** (auditoria de quem abriu o quê) — PARTE 10.
- [ ] **Cron de varredura de pendentes** (`/api/cron/varredura`, protegido por
      `CRON_SECRET`). Hoje a rede de segurança é o botão "Verificar pendentes",
      apertado à mão. Conferir o limite de crons do plano da Vercel.

## MEDIR ANTES DE OTIMIZAR

- [x] **Rastreador do funil** (`utm_*`, `fbclid`, `gclid`, etapa alcançada,
      origem grudada no pedido) — feito em 08/08/2026.
- [x] **Aba Anúncios** do `/admin`: visitas → quiz → VSL → checkout → PIX →
      vendas → receita, por campanha, conjunto e anúncio.
- [x] **Aba Anúncios virou painel de mídia paga** — feito em 09/08/2026.
      Separada em Desempenho e Configuração; 8 cartões no topo com comparação
      contra o período anterior; três conjuntos de colunas (Resultado, Tráfego,
      Funil) com CTR, CPC, CPM, custo por venda, lucro e margem; semáforo de
      ROAS contra meta configurável. `investimento_anuncios` ganhou impressões e
      cliques, que entram pela planilha ou à mão. Bateria própria:
      `scripts/testar-painel-anuncios.mjs` (47 casos).
      - [ ] falta: a planilha do dono passar a exportar impressões e cliques —
            sem isso CTR, CPC e CPM continuam mostrando "—"
- [x] **Investimento automático por planilha** — feito em 08/08/2026. A aba
      Anúncios importa o gasto de uma Google Sheet publicada em CSV (alimentada
      por Stract, Supermetrics ou similar) e preenche a coluna Investido. A
      digitação à mão continua valendo como caminho de custo zero.
- [ ] **Investimento pela API de Marketing do Meta** (opcional, só se a planilha
      incomodar): `/insights` com `level=ad` e campos `spend`/`impressions`/
      `clicks`, usando um usuário do sistema com `ads_read`. Tira a planilha do
      caminho, mas exige app no Meta for Developers e revisão — projeto próprio.
- [ ] **Aba Funil** do `/admin` (PARTE 8): o caminho etapa a etapa dentro do
      quiz. Os dados já estão em `eventos_funil`; falta a tela.
- [ ] Só depois disso: testar valores diferentes de `segundosAteOCta`. Segurar
      mais costuma reduzir quem chega ao checkout e aumentar a proporção dos que
      compram; soltar antes faz o contrário. Sem medição, é troca de um resultado
      desconhecido por outro.

## PRODUTO

- [ ] Gravar o terceiro vídeo de depoimento (Antônio Carlos não tem vídeo).
- [ ] Substituir as imagens do Unsplash que ainda restam — inclusive a quarta
      opção da primeira pergunta do quiz (`q1_op4`) e os avatares dos depoimentos.
- [x] ~~Domínio próprio~~ — subiu para bloqueante, ver acima.

---

## Feito (para não refazer)

- [x] Funil de 14 telas, quiz de 9 perguntas, áudio, depoimentos, tela de cálculo
- [x] Checkout inline com bumps, upsell, downsell e retomada de pedido
- [x] Integração PixGo: cobrança, webhook assinado, reconciliação, erros
      traduzidos, tratamento de 410, dois segredos de assinatura aceitos
- [x] Postgres (Neon) e deploy na Vercel como função única
- [x] Painel `/admin`: login, Pedidos, Entregas, Webhooks, Pagamentos, link de
      entrega assinado de 72 h
- [x] Página `/obg` como endereço de conversão do Google Ads
- [x] Responsividade auditada em 6 telas; alvos de toque e campos corrigidos
- [x] Quatro baterias de teste (PixGo falsa, CTA, responsividade, /obg)
