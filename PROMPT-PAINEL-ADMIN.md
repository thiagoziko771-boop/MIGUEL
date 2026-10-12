# PROMPT: CONSTRUIR O PAINEL /ADMIN E /LEADS DO REZAS SAGRADAS

> **Aviso de desatualização (gateway).** Este documento foi escrito quando o
> checkout usava a PixGo. O gateway agora é a **BitFlow Pay**, com autenticação
> OAuth2, callback em `/api/webhooks/bitflow` e sem assinatura documentada no
> webhook (por isso o status vem sempre de reconsulta). Onde se lê "PixGo",
> entenda "BitFlow"; e desconsidere os números específicos da PixGo (mínimo de
> R$ 10,00, teto por nível, limite de 1.000 consultas por 24 h), que não se
> aplicam. A fonte da verdade sobre o gateway é o
> [README.md](README.md) e o módulo [server/bitflow.ts](server/bitflow.ts).
> Todo o resto do documento (painel, funil, relatórios, LGPD) continua válido.

Como usar este arquivo: abra uma sessão nova do Claude Code **na pasta deste
projeto** (`rezas-sagradas---funil-arcanjo-miguel`) e cole o texto inteiro.

Este documento descreve um painel de operação que já roda em produção em outro
negócio, reescrito para o funil do Arcanjo Miguel, para a PixGo e para o deploy
na Vercel. A missão é recriar o mesmo sistema neste projeto, não inventar outro
painel e não reescrever o checkout que já existe.

---

## PARTE 0. O NEGÓCIO (JÁ PREENCHIDO)

- **Negócio:** Rezas Sagradas. Funil de quiz espiritual (9 perguntas) que termina
  numa VSL e num checkout PIX inline, vendendo produtos digitais devocionais.
- **Produtos e preços** (fonte da verdade em [server/catalog.ts](server/catalog.ts)):

  | ID | Tipo | Título | Preço |
  | --- | --- | --- | --- |
  | `main` | principal | Oração Sagrada do Arcanjo Miguel | R$ 27,00 |
  | `salmos_150` | order bump | Guia Sagrado dos 150 Salmos | R$ 10,00 |
  | `vela_7dias` | order bump | Consagração na Vela Sagrada de 7 Dias | R$ 14,90 |
  | `upsell` | upsell | Aplicativo Espiritual completo | R$ 47,00 |
  | `downsell` | downsell | Aplicativo Espiritual Essencial | R$ 14,90 |

- **Variações de processamento:** não existem. O que varia é a **oferta**
  (`main`, `upsell`, `downsell`) e a combinação de order bumps. Onde o painel
  original falava em "serviço" e "processamento", aqui se fala em "oferta" e
  "adicionais".
- **O que o cliente recebe ao pagar:** links de entrega dos produtos digitais
  (áudio da oração, PDF dos salmos, confirmação da vela, acesso ao aplicativo).
  Hoje os links vêm das variáveis `DELIVERY_URL_*` e aparecem na tela final do
  checkout. Não há envio de e-mail implementado.
- **Como o cliente paga:** PIX pela **PixGo** (gateway único, sem sandbox, sem
  cadeia de reserva). Ver [server/pixgo.ts](server/pixgo.ts).
- **Etapas do funil, na ordem real** (ver [src/App.tsx](src/App.tsx)):
  hero -> q1 a q6 -> intermissão de áudio -> q7 a q9 -> depoimentos -> tela de
  cálculo -> VSL/oferta -> checkout aberto -> formulário -> Pix principal ->
  pago -> upsell -> Pix do upsell (ou recusa) -> downsell -> Pix do downsell ->
  tela de acesso liberado.
- **Campos do formulário** (ver [src/components/InlineCheckout.tsx](src/components/InlineCheckout.tsx)):
  nome completo, e-mail, telefone com DDD (opcional, 10 ou 11 dígitos), CPF
  (obrigatório e validado), mais as caixas dos dois order bumps
  (`salmos_150` vem pré-marcado).
- **Etiquetas de atendimento do /leads** (vocabulário fechado no servidor):
  `contato` "Falei com o cliente" (verde), `pix_ajuda` "Ensinei a pagar o Pix"
  (azul), `sem_resposta` "Não respondeu" (âmbar), `desistiu` "Desistiu da
  compra" (vermelho), `entregue` "Confirmou que recebeu o acesso" (roxo).
- **Hospedagem:** Vercel. O Express inteiro roda como **uma única função
  serverless** em [api/index.ts](api/index.ts), com o rewrite `/api/(.*)` ->
  `/api` definido em [vercel.json](vercel.json). Persistência em **Postgres
  (Neon)** via `@neondatabase/serverless`.
- **Já existe checkout e servidor rodando?** Sim. Ler a Parte 0.5 antes de
  escrever qualquer linha.

---

## PARTE 0.5. O QUE JÁ EXISTE (NÃO REESCREVER)

Leia estes arquivos antes de começar. Eles são a base do painel e nenhum deles
deve ser refeito do zero:

| Arquivo | O que já resolve |
| --- | --- |
| [server/app.ts](server/app.ts) | Monta o Express (headers de segurança, CORS, raw body do webhook, handler de erro). É onde os routers novos entram. |
| [api/index.ts](api/index.ts) | Entrada da Vercel. Recusa com 503 quando falta `DATABASE_URL`. Roda `initStore()` uma vez por cold start. |
| [server/index.ts](server/index.ts) | Entrada do processo local (`npm run dev:server`). |
| [server/config.ts](server/config.ts) | Leitura e validação de env. Toda variável nova do painel entra aqui, com aviso no boot. |
| [server/store/](server/store/) | Contrato `OrderStore` com duas implementações: `pgStore.ts` (Postgres, produção) e `fileStore.ts` (arquivo, só desenvolvimento). |
| [server/catalog.ts](server/catalog.ts) | Fonte da verdade dos preços. O painel lê daqui, nunca duplica preço. |
| [server/orders.ts](server/orders.ts) | `createOrder`, `applyStatus`, `reconcileOrder`, `buildAccessBundle`. |
| [server/routes/webhook.ts](server/routes/webhook.ts) | Webhook da PixGo com HMAC, janela anti replay de 300 s e dedupe por chave no Postgres. |
| [server/routes/orders.ts](server/routes/orders.ts) | `POST /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/access`. |
| [server/delivery.ts](server/delivery.ts) | Monta os entregáveis a partir das `DELIVERY_URL_*`. |
| [server/validation.ts](server/validation.ts) | Validação de CPF, CNPJ, e-mail, telefone. |
| [src/](src/) | O funil React inteiro. Só recebe o tracker e nenhuma mudança de layout. |

Fatos do código que mudam decisões do painel:

1. **Um cliente gera até três pedidos separados** (`main`, `upsell`,
   `downsell`), ligados por `parentOrderId`. Contar "vendas" somando todos os
   pedidos pagos infla o número e destrói o ticket médio. Ver a regra na Parte 6.
2. **Upsell e downsell herdam os dados do cliente** do pedido principal
   (`customer`, e por decisão desta especificação também o `rastreio` de
   anúncio). O cliente não digita nada de novo.
3. **A PixGo limita a consulta de status a 1.000 requisições por 24 h.** O
   projeto já reserva um orçamento diário (`STATUS_POLL_DAILY_BUDGET`, padrão
   800) contado na tabela `status_polls`. Todo botão do painel que reconsulta a
   PixGo gasta esse orçamento e precisa dizer isso ao dono.
4. **Valor mínimo R$ 10,00 e teto por QR Code conforme o nível** da conta
   (`PIXGO_MIN_AMOUNT_BRL`, `PIXGO_MAX_AMOUNT_BRL`, hoje 300). Pedido acima do
   teto é recusado antes de virar cobrança e precisa aparecer no funil como
   rejeição do servidor.
5. **Cobrança pendente idêntica é reaproveitada por 10 minutos**
   (`ORDER_REUSE_WINDOW_MS`). O painel não deve tratar isso como pedido novo.
6. **Não existe envio de e-mail.** A ação "reenviar e-mail" do painel só entra
   se um provedor for configurado (ver Parte 15); sem ele o botão fica
   desabilitado com o motivo escrito na tela, nunca escondido.
7. **O pedido guarda o CPF completo** e o `clientIp`. Isso nunca sai pela API
   pública (existe `maskDocument`), mas sai pelas rotas autenticadas do painel,
   que é o ponto do painel.

---

## PARTE 1. PAPEL E OBJETIVO

Você vai construir um painel de operação completo para o dono do Rezas
Sagradas. São duas páginas:

- **/admin**: painel completo do dono (pedidos, relatórios, funil, saúde da
  PixGo, acessos).
- **/leads**: painel da equipe de atendimento (só leitura, etiquetas e cópia de
  dados).

O dono não é programador. Todo texto do painel fala a língua dele
("Aguardando" e não "pending", "O sistema de Pix recusou" e não "gateway error
502", "Oração" e não "offer main"). O painel existe para responder três
perguntas o dia inteiro: quanto vendi, quem falta pagar e como cobro agora, e
onde o funil está vazando.

---

## PARTE 2. STACK E RESTRIÇÕES DA VERCEL

- **Backend:** Node + Express + TypeScript, já montado em `server/app.ts`. As
  rotas novas entram como routers em `server/routes/admin.ts`,
  `server/routes/leads.ts` e `server/routes/coleta.ts`.
- **Frontend do painel:** HTML, CSS e JS puros, **fora do bundle React**.
  Uma página é um HTML, um JS e um CSS, sem framework e sem build. Os arquivos
  ficam em `public/` (o Vite copia `public/` para `dist/` sem tocar em nada) e
  são servidos pelo CDN da Vercel:

  ```
  public/admin.html   public/admin.js   public/admin.css
  public/leads.html   public/leads.js   public/leads.css
  ```

  Em `vercel.json`, acrescente os rewrites de URL limpa, **depois** do rewrite
  de `/api`:

  ```json
  { "source": "/admin", "destination": "/admin.html" },
  { "source": "/leads", "destination": "/leads.html" }
  ```

  Motivo de não usar React aqui: o painel não pode depender do build do funil,
  precisa carregar rápido em 3G no celular do dono e tem que ser editável sem
  reinstalar nada.
- Servir o HTML pelo CDN significa que **o HTML do painel é público**. Isso é
  aceitável e proposital: o HTML não contém dado nenhum, todos os dados vêm de
  rotas autenticadas. Ainda assim, ponha `<meta name="robots" content="noindex">`
  nas duas páginas e um `public/robots.txt` com `Disallow: /admin` e
  `Disallow: /leads`.

Restrições da Vercel, todas com consequência direta no código:

1. **Nada de estado importante em memória.** Cada requisição pode cair numa
   instância diferente e as instâncias congelam entre invocações. Memória por
   processo só serve para cache descartável. O limitador de tentativas de senha
   **precisa** ir para o Postgres (o `createRateLimiter` atual, em memória,
   continua valendo só como freio extra da criação de cobrança).
2. **Não existe disco.** Nenhum arquivo de dados, nem NDJSON, nem upload em
   pasta. Tudo vira tabela no Postgres (Parte 3).
3. **Depois que a resposta é enviada, a função pode congelar na hora.** Promessa
   solta ("fire and forget") pode simplesmente não executar. Todo alerta do
   Discord, toda gravação de evento e toda auditoria precisa ser **aguardada
   antes de responder**, com timeout curto (1,5 s) e `try/catch` que nunca
   derruba a ação principal.
4. **Corpo da requisição limitado a cerca de 4,5 MB.** O upload de comprovante
   tem teto de 4 MB, não 8 MB.
5. **`maxDuration` está em 20 s** em `vercel.json`. Rota que consulta a PixGo
   várias vezes precisa caber nisso: a verificação de pendentes processa no
   máximo 12 pedidos por clique, em lotes paralelos de 4, e devolve quantos
   faltaram para o dono clicar de novo.
6. **Não existe `setInterval` de fundo.** A varredura periódica de pendentes
   vira Vercel Cron (`crons` no `vercel.json`) apontando para
   `/api/cron/varredura`, protegida por `CRON_SECRET` comparado em tempo
   constante. **Confira o limite do seu plano**: no plano Hobby a Vercel dispara
   cron poucas vezes por dia. Se for esse o caso, o cron é apenas rede de
   segurança e a confirmação continua vindo do webhook, do polling do checkout e
   do botão "Verificar pendentes".
7. **O CDN cacheia GET por URL.** Toda rota GET do painel responde
   `Cache-Control: no-store` e o frontend anexa um timestamp na query quando
   precisa garantir resposta fresca.
8. **`TRUST_PROXY` precisa ser `true`** na Vercel, senão todo cliente vira o IP
   da borda.

---

## PARTE 3. PERSISTÊNCIA (POSTGRES APPEND ONLY)

O princípio do painel original continua: **nada de ler, modificar e regravar um
documento único para dados que crescem**. Em Postgres isso vira: tabelas de
histórico só recebem `INSERT`, e o estado atual é uma consulta
`DISTINCT ON (...) ORDER BY t DESC`. Duas instâncias escrevendo ao mesmo tempo
convergem sozinhas.

A tabela `orders` já existe e **continua sendo a fonte da verdade financeira**.
Não duplique pedido em log de eventos.

Crie as tabelas abaixo dentro da migração de `server/store/pgStore.ts`, no mesmo
padrão `CREATE TABLE IF NOT EXISTS` que já está lá (a migração roda no cold
start e precisa continuar idempotente):

```sql
-- Linha do tempo do pedido (só o que a tabela orders não conta)
CREATE TABLE IF NOT EXISTS pedido_eventos (
  id        BIGSERIAL PRIMARY KEY,
  t         TIMESTAMPTZ NOT NULL DEFAULT now(),
  pedido_id TEXT        NOT NULL,
  evento    TEXT        NOT NULL,   -- pago | marcado_manual | entrega_aberta | link_gerado | email_reenviado
  origem    TEXT,                   -- webhook | polling | manual | painel
  dados     JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS pedido_eventos_pedido_idx ON pedido_eventos (pedido_id, t DESC);

-- Eventos do funil (quiz + checkout). Sem PII, ver Parte 14.
CREATE TABLE IF NOT EXISTS funil_eventos (
  id     BIGSERIAL PRIMARY KEY,
  t      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sid    TEXT        NOT NULL,
  oid    TEXT,
  evento TEXT        NOT NULL,
  props  JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS funil_eventos_t_idx   ON funil_eventos (t DESC);
CREATE INDEX IF NOT EXISTS funil_eventos_sid_idx ON funil_eventos (sid, t);
CREATE INDEX IF NOT EXISTS funil_eventos_oid_idx ON funil_eventos (oid) WHERE oid IS NOT NULL;

-- Gasto diário de anúncio, append only. Vale a última linha de cada dia.
CREATE TABLE IF NOT EXISTS ads_diario (
  id                BIGSERIAL PRIMARY KEY,
  t                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  dia               DATE        NOT NULL,
  investido_centavos INTEGER,              -- NULL apaga o registro do dia
  cliques           INTEGER,
  impressoes        INTEGER,
  por               TEXT
);
CREATE INDEX IF NOT EXISTS ads_diario_dia_idx ON ads_diario (dia, t DESC);

-- Etiquetas de atendimento, append only. Estado = última linha de cada par.
CREATE TABLE IF NOT EXISTS pedido_tags (
  id        BIGSERIAL PRIMARY KEY,
  t         TIMESTAMPTZ NOT NULL DEFAULT now(),
  pedido_id TEXT        NOT NULL,
  tag       TEXT        NOT NULL,
  ativa     BOOLEAN     NOT NULL,
  por       TEXT        NOT NULL          -- dono | equipe
);
CREATE INDEX IF NOT EXISTS pedido_tags_idx ON pedido_tags (pedido_id, tag, t DESC);

-- Auditoria do painel. Nunca guarda senha nem token.
CREATE TABLE IF NOT EXISTS painel_auditoria (
  id     BIGSERIAL PRIMARY KEY,
  t      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acao   TEXT        NOT NULL,
  papel  TEXT,                            -- dono | equipe | anonimo
  ip     TEXT,
  dev    JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- {tipo, so, nav}
  dados  JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS painel_auditoria_t_idx ON painel_auditoria (t DESC);

-- Freio de força bruta do login. Precisa ser compartilhado entre instâncias.
CREATE TABLE IF NOT EXISTS painel_bloqueios (
  chave        TEXT PRIMARY KEY,          -- ip do tentante
  erros        INTEGER     NOT NULL DEFAULT 0,
  primeiro_erro TIMESTAMPTZ NOT NULL DEFAULT now(),
  bloqueado_ate TIMESTAMPTZ
);

-- Comprovantes enviados pelo cliente (teto de 4 MB, ver Parte 2).
CREATE TABLE IF NOT EXISTS comprovantes (
  id        BIGSERIAL PRIMARY KEY,
  t         TIMESTAMPTZ NOT NULL DEFAULT now(),
  pedido_id TEXT        NOT NULL,
  mime      TEXT        NOT NULL,
  tamanho   INTEGER     NOT NULL,
  conteudo  BYTEA       NOT NULL
);
CREATE INDEX IF NOT EXISTS comprovantes_pedido_idx ON comprovantes (pedido_id, t);

-- Links de entrega editáveis pelo painel. Sobrescrevem as DELIVERY_URL_*.
CREATE TABLE IF NOT EXISTS entrega_links (
  item_id       TEXT PRIMARY KEY,
  url           TEXT        NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Regras de leitura:

- Toda consulta do painel é **agregada em SQL e limitada pelo período pedido**.
  Nunca traga a tabela inteira para a memória da função.
- Estado das etiquetas: `SELECT DISTINCT ON (pedido_id, tag) ... ORDER BY
  pedido_id, tag, t DESC` e depois filtre `ativa = true`.
- Ads do dia: `SELECT DISTINCT ON (dia) ... ORDER BY dia, t DESC` e descarte
  linhas com `investido_centavos IS NULL`.
- Auditoria: no máximo as últimas 500 linhas do período.
- Retenção: o cron apaga `funil_eventos` com mais de 180 dias e
  `painel_auditoria` com mais de 180 dias. Comprovantes de pedidos pagos há mais
  de 90 dias também saem.

**Campos novos no objeto do pedido.** O pedido é um JSONB em `orders.data`, então
acrescentar chave não exige migração de coluna. Some ao tipo `Order` de
[server/store/types.ts](server/store/types.ts):

```ts
rastreio: { gclid: string | null; gbraid: string | null; wbraid: string | null } | null;
utm: { source, medium, campaign, term, content } | null;   // strings ou null
aparelho: { tipo: 'celular' | 'tablet' | 'computador'; so: string; nav: string } | null;
trackId: string | null;        // sid da sessão do funil
entregas: { total: number; ultimoEm: string | null; ultimoIp: string | null };
```

Pedido antigo não tem essas chaves: toda leitura precisa tolerar `undefined`.
Upsell e downsell **herdam** `rastreio`, `utm` e `trackId` do pedido pai, senão
a venda seguinte some da atribuição do Google Ads.

---

## PARTE 4. AUTENTICAÇÃO E SESSÕES

- Duas senhas de ambiente: `ADMIN_SENHA` (dono, obrigatória para o painel
  existir) e `LEADS_SENHA` (equipe, opcional; sem ela o /leads só aceita a senha
  do dono).
- **Sessão stateless**, que é o que funciona em serverless sem tabela de sessão:
  token = `expEpochMs.HMAC-SHA256(exp, segredo)`, validade 12 h. Segredo do dono
  derivado de `HMAC(PAINEL_CHAVE_MESTRA, "sessao-admin:" + ADMIN_SENHA)`; o da
  equipe com `"sessao-leads:" + LEADS_SENHA`. Trocar uma senha derruba só as
  sessões daquele papel, e **token de equipe nunca valida como dono**.
- **Chave mestra:** variável `PAINEL_CHAVE_MESTRA`, 32 bytes em hex
  (`openssl rand -hex 32`). Não existe fallback em arquivo, porque não há disco.
  Sem ela, o painel recusa login com mensagem clara no log do boot.
- Comparação de senha e de assinatura sempre em tempo constante (SHA-256 dos
  dois lados mais `crypto.timingSafeEqual`), no mesmo padrão de
  `signaturesMatch` que já existe em `server/routes/webhook.ts`.
- Header de sessão: `X-Admin-Sessao`. Middleware `exigirAdmin` (rotas do dono) e
  `exigirLeads` (rotas que a equipe também usa, marcando
  `req.papelSessao = 'dono' | 'equipe'`).
- **Freio de força bruta:** 5 senhas erradas por IP bloqueiam 15 min (HTTP 429
  dizendo quantos minutos faltam). Sucesso zera o contador. O estado vive na
  tabela `painel_bloqueios`, com `INSERT ... ON CONFLICT (chave) DO UPDATE`, e
  não em memória.
- Auditoria de login: `login_ok`, `login_falha`, `login_bloqueio`. Primeiro
  acesso de um par IP + SO + navegador marca `novo: true` e dispara alerta no
  canal de controle do Discord.
- **IP do cliente:** na Vercel use `x-vercel-forwarded-for` quando existir (o
  cliente não consegue forjar esse header). Sem ele, percorra o
  `X-Forwarded-For` do fim para o começo e devolva o primeiro IP que não seja
  salto interno (`10.`, `192.168.`, `127.`, `172.16` a `172.31`, `::1`, `fc`,
  `fd`, `fe80`). Sem isso, todo mundo vira o IP da borda e o bloqueio por IP
  fica global.

**Login no frontend:** card centrado com cadeado, título, um campo de senha,
botão Entrar de largura total. Token em `sessionStorage` (morre ao fechar a aba;
a senha nunca é gravada). Qualquer 401 em qualquer chamada derruba para o login.
Botão Sair na topbar só limpa o token.

---

## PARTE 5. /ADMIN: ESTRUTURA GERAL

- SPA de arquivo único: view de login e view do painel no mesmo HTML.
- Topbar fixa: nome "Rezas Sagradas" com selo "Admin", texto "Atualizado às
  HH:MM:SS", botão de tema claro e escuro (salvo em `localStorage`, aplicado por
  script inline no `<head>` antes da primeira pintura, sem flash, sincronizando
  `meta theme-color`), botão de atualizar e botão Sair.
- **5 abas** (`role="tablist"`): Pedidos (padrão), Relatórios, Funil, PixGo,
  Acessos. Cada aba tem seletor de período próprio e independente.
- Carregamento preguiçoso: Funil e Acessos só buscam na primeira abertura;
  Relatórios rebusca ao abrir; PixGo desenha o cache e rebusca em seguida.
- Auto refresh de 30 s, só com o painel aberto e só da aba visível. Trava:
  Relatórios não recarrega enquanto um formulário de Ads está aberto, senão
  apaga o que o dono digitou.
- Sem sons e sem Notification API. Alerta em tempo real é papel do Discord, no
  servidor, não do navegador.

---

## PARTE 6. ABA PEDIDOS

**Regra de contagem que vale para o painel inteiro** (consequência do upsell e
do downsell serem pedidos separados):

- **Cliente / venda** = pedido principal (`offer = 'main'`, `parentOrderId =
  null`). É o denominador de tudo que fala em pessoas.
- **Faturamento** = soma de todos os pedidos pagos, incluindo upsell e downsell.
- **Ticket médio** = faturamento dividido pelo número de clientes pagantes, não
  pelo número de cobranças. É o número que diz quanto vale cada pessoa que entra.
- **Taxa de pagamento** = pedidos principais pagos sobre pedidos principais
  criados. Upsell e downsell nunca entram nessa conta, porque só existem para
  quem já pagou.
- **Take rate do upsell** = upsells pagos sobre clientes pagantes. O mesmo para
  o downsell, com denominador de quem recusou o upsell.

Período: chips Hoje (padrão), 7 dias, 30 dias, 90 dias, Tudo, mais um campo
`date` para ver um dia específico. Botão "Verificar pendentes" (reconsulta a
PixGo, vira "Verificando...", depois "N novos pagos!" ou "Nenhum novo
pagamento"). Ao lado do botão, sempre visível: "Consultas à PixGo hoje: N de
800". Com menos de 50 restantes, o botão fica desabilitado explicando que o
limite diário da PixGo está no fim e que o webhook continua confirmando sozinho.

**Faixa de leitura** (frase pronta acima dos KPIs, só sem busca ou filtro):

- Hoje: "Hoje até agora: N Orações vendidas (R$ X) e N Pix esperando pagamento
  (R$ Y)."
- Complemento de ritmo (só com 7 ou mais dias de histórico): compara com a média
  dos 7 dias anteriores **no mesmo horário** ("Abaixo do ritmo para este
  horário" em alerta, ou "Ritmo normal pro seu horário.").
- 7 e 30 dias: veredito de uma frase contra a janela anterior apontando a causa
  dominante (menos pedidos, taxa de pagamento caiu, as duas, ticket menor).

**KPIs** (5 cards, os 3 primeiros em destaque):

1. Faturamento (soma dos pagos) com comparação contra o período anterior, com
   cor (verde acima, vermelho abaixo).
2. Orações vendidas (clientes pagantes).
3. Aguardando Pix, card **clicável** que filtra a lista em pendentes, operável
   por Enter e Espaço.
4. Ticket médio por cliente.
5. Taxa de pagamento ("N de M pagaram").

Abaixo dos KPIs, uma linha discreta com os adicionais: "Adicionais: N guias dos
Salmos, N velas, N apps (upsell), N apps essencial (downsell). Take rate do
upsell: X%."

**Regra de ouro:** no chip Hoje a comparação vira **neutra** ("ontem: R$ X"),
sem cor e sem direção. Dia parcial contra dia inteiro abriria o painel no
vermelho toda manhã.

**Faixa "Para cobrar agora":**

- Só aparece se há Pix pendente nas últimas 48 h, ignorando o filtro de período.
- "N pessoas geraram o Pix nas últimas 48h e ainda não pagaram: R$ X esperando".
- No máximo 6 itens (nome, "há X min, Oração + adicionais", valor, botão verde
  "Cobrar no WhatsApp"). Memória local de quem já foi cobrado ("cobrado há X
  min", botão muda de estado; quem paga sai sozinho). Havendo mais, botão "Ver
  todos na lista".
- No celular esta faixa desce para **depois** da lista de pedidos.

**3 widgets:**

- **Vendas dia a dia** (sempre 30 dias): gráfico SVG de barras duplas por dia
  (criados contra pagos, pagos pela data de **pagamento**), tooltip por coluna,
  rodapé comparando a última semana com a anterior. Redesenha ao trocar de tema
  e ao redimensionar (debounce de 150 ms).
- **De onde vieram os pedidos:** Anúncio (`gclid`, `gbraid` ou `wbraid`
  presente) contra Direto, com R$ de cada lado. Comparação de taxa de pagamento
  só com 5 ou mais pedidos de cada lado. Botão "Exportar vendas pro Google Ads"
  (CSV, Parte 15) mais o lembrete "N vendas novas desde a última exportação"
  (em alerta se passaram mais de 7 dias).
- **O que está vendendo:** barra por produto do catálogo ordenada por
  faturamento (Oração, Salmos, Vela, App completo, App essencial). Frase de
  carro chefe só quando há liderança real; empate não coroa ninguém.

**Aviso acionável acima da tabela:** "N clientes pagaram há mais de 24 h e ainda
não abriram o link de entrega." Clicável, filtra pagos dos últimos 30 dias. Este
aviso é o que separa venda de entrega neste negócio: como não há e-mail, quem
fecha a aba antes de clicar no link fica sem o produto.

**Tabela de pedidos:**

- Filtros: status (Todos, Só pagos, Só aguardando), busca (nome, e-mail, CPF ou
  ID), botão Limpar.
- Colunas: Data (curta relativa mais os 8 primeiros caracteres do id), Cliente
  (nome e e-mail), CPF, Oferta (Oração com os adicionais listados, ou App
  completo, ou App essencial), Valor, Origem (Anúncio ou Direto), Status (badge
  Pago verde, Aguardando âmbar, Expirado cinza, Estornado vermelho; badge extra
  "Comprovante" quando o cliente enviou comprovante e segue pendente), Ações.
- Por padrão a tabela lista **pedidos principais**, com os filhos recolhidos numa
  segunda linha do próprio card ("+ App completo R$ 19,90 pago"). Um chip
  "Mostrar upsell e downsell como linhas" abre a visão plana, para quando o dono
  quiser conferir cobrança por cobrança.
- Ordenação por clique no cabeçalho (data e valor começam decrescentes).
- Ações por linha: Cobrar ou Enviar acesso (WhatsApp), copiar link de entrega
  (só pagos, vira check por 2 s), abrir detalhes (a linha inteira também abre).
- Rodapé: "N pedidos neste período, M no total" mais "Atualização automática a
  cada 30 segundos".
- Em telas de até 640 px a tabela **vira lista de cartões** (sem rolagem
  lateral) e a ordem da página muda: período, leitura, KPIs, lista, cobrança,
  gráficos.

**Painel recolhível "Links de entrega":** um cartão por item do catálogo (main,
salmos_150, vela_7dias, upsell, downsell) com o título do produto, o link atual
(vindo de `entrega_links`, com fallback na `DELIVERY_URL_*`), campo para colar
um link novo e botão Salvar. Sem link configurado, o cartão fica em vermelho com
"Nenhum link configurado: quem pagar este item não recebe nada". Salvar grava em
`entrega_links` e passa a valer na hora, sem deploy. `server/delivery.ts` passa a
ler a tabela primeiro e o env depois.

---

## PARTE 7. ABA RELATÓRIOS

3 modos por chips: Fechamento diário, Semanas, Google Ads. Sempre os últimos 30
dias, agregados por dia calendário local do negócio (**UTC-3 fixo**, sem horário
de verão; o Brasil não tem mais horário de verão e `server/utils.ts` já assume
UTC-3 ao normalizar as datas da PixGo).

**Fechamento diário:** um card por dia (só dias com movimento ou com Ads; hoje
sempre aparece).

- Selos: "Hoje, em andamento", "Melhor CPA do período" (verde), "Maior receita
  do período", "Nenhuma venda paga" (âmbar, só em dia passado que teve pedidos).
- Régua de 7 células: Investido (R$ do Ads ou traço "Ads não registrado", com
  sub linha de N cliques) | Vendas (sub "de N pedidos") | Receita (sub ticket) |
  **CPA** (sempre a célula em destaque, é o número que o dono lê primeiro) |
  Mídia (percentual da receita gasto em anúncio) | Retorno (R$ de receita por
  real investido, **nunca ROAS em percentual**) | Lucro (receita menos anúncio,
  fundo verde se maior ou igual a zero, vermelho se menor).
- Réguas de cor: conversão do dia igual ou acima de 20% verde, abaixo de 15%
  âmbar, entre os dois neutro.
- Registro do gasto: botão "Registrar Ads do dia" abre formulário inline no card
  com Investido em R$ (obrigatório, aceita vírgula decimal), Cliques e
  Impressões (opcionais), Salvar, Cancelar e Apagar registro. Enter salva. Grava
  por `INSERT` em `ads_diario` e tudo recalcula sozinho.
- Mini gráfico de 24 colunas por hora (criados contra pagos) com tooltip.
- Chips de detalhe adaptados a este funil: sessões no funil, quantos
  completaram o quiz, quantos abriram o checkout, mix por produto, "Anúncio N de
  M vendas", aparelhos (Android, iPhone, outros), "Recuperações (pagas 1h ou
  mais depois)", "Upsell N de M" e "Downsell N de M".

**Semanas** (segunda a domingo): card por semana com selo Em andamento, Fechada
ou Cortada pela janela; "Melhor semana" (maior receita entre as fechadas); a
mesma régua de 7 células, com CPA e Lucro marcados "parcial, faltam dias de Ads"
quando falta registro; deltas contra a semana anterior (CPA **caindo** pinta
verde, subindo pinta vermelho); grade de 7 dias com barra de receita por dia.

**Google Ads:** régua herói somando **só os dias com Ads registrado**
(Investido, CPC médio, CTR com impressões, Vendas de anúncio, CPA do anúncio em
destaque, Receita do anúncio, Lucro do anúncio em verde ou vermelho), mais a
nota "Vendas diretas ficam fora desta visão", mais tabela dia a dia (Dia,
Investido, Cliques, CPC, Impressões, CTR, Vendas de anúncio, CPA em negrito,
Lucro verde ou vermelho; dado ausente vira traço; rola na horizontal no
celular).

**Cálculo por dia:** criados contam no dia de `createdAt`; pagos e receita no
dia de `paidAt`; `anuncio.*` são pedidos com `gclid`, `gbraid` ou `wbraid`;
recuperações são pagos com 60 min ou mais entre criação e pagamento; sessões
vêm do funil (dia do primeiro evento do `sid`); `cpa = investido / clientes
pagantes`; tudo `null` quando o dia não tem Ads registrado, nunca zero.

---

## PARTE 8. ABA FUNIL

Chips: Hoje, 7 dias (padrão), 30, 90.

Este funil tem duas metades e o painel mostra as duas, nesta ordem, porque a
maior perda deste negócio acontece **antes** do checkout:

**Bloco 1: funil do quiz até a oferta**

Etapas, na ordem real do `src/App.tsx`:

1. Abriu o funil (tela do hero)
2. Respondeu a pergunta 1
3. Respondeu a pergunta 6
4. Chegou no áudio
5. Respondeu a pergunta 9
6. Viu os depoimentos
7. Chegou na oferta (VSL)
8. Abriu o checkout

Cada linha mostra quantos pararam ali ("(maior perda)" em vermelho na pior
queda), o total, o percentual de retenção e uma barra proporcional. Abaixo, a
tabela "Abandono por pergunta": pergunta, quantos viram, quantos responderam,
percentual de saída, para o dono saber exatamente qual pergunta está espantando
gente.

**Bloco 2: funil do checkout**

Entrou no checkout > Preencheu e tentou pagar > Pix gerado > Pagou > Viu o
upsell > Pagou o upsell (ou Recusou > Viu o downsell > Pagou o downsell).

**Cards e blocos, iguais ao painel original:**

- Card de conversão geral: percentual gigante mais o fluxo "N abriram > N
  chegaram na oferta > N geraram o Pix > N pagaram". Com menos de 20 sessões,
  aviso de amostra pequena ("o percentual oscila muito, olhe os números
  absolutos").
- 2 tiles: "Desistem antes do Pix" (alerta) e "Pagam depois de ver o Pix"
  (positivo).
- **Tempos em mediana**, nunca média (uma aba esquecida aberta destrói a média):
  tempo por etapa, tempo do início até gerar o Pix, tempo olhando o QR. Dica
  operacional: "Quem paga costuma pagar em X min depois de gerar o Pix. Passou
  disso, chame no WhatsApp."
- "Onde o cliente parou": abandono é sessão sem eventos há 30 min ou mais e sem
  pagamento, classificada pela última etapa. Topo acionável: "N pessoas geraram
  o Pix e não pagaram. São as mais fáceis de recuperar." mais o botão "Ver
  pendentes na aba Pedidos", que troca de aba já filtrado.
- "Campos que mais travam": ranking de erros de validação com rótulo amigável.
  Os campos deste checkout são: Nome completo, E-mail, Telefone, CPF. Rótulos
  dos erros reais do código: "CPF inválido", "CPF não informado", "E-mail
  inválido", "Nome muito curto", "Telefone sem DDD".
- "Falhas na hora de gerar o Pix", com motivos traduzidos a partir dos erros que
  este servidor realmente devolve:
  - `PixGoError` -> "O sistema de Pix recusou"
  - `AMOUNT_BELOW_MINIMUM` -> "Valor abaixo do mínimo de R$ 10 da PixGo"
  - `AMOUNT_ABOVE_LIMIT` -> "Valor acima do teto do seu nível na PixGo"
  - `RATE_LIMITED` -> "Muitas tentativas do mesmo aparelho"
  - `PARENT_NOT_PAID` -> "Tentou o app sem ter pago a Oração"
  - `STORAGE_NOT_CONFIGURED` -> "Checkout fora do ar (banco não configurado)"
  - erro de rede -> "Falha de internet ou demora"

  A escala das barras tem piso 10, para um caso isolado não virar barra cheia.
- Aparelho usado e origem das visitas: barra dupla (visitas e pagos) por
  segmento.

---

## PARTE 9. ABA PIXGO (GATEWAY ÚNICO)

Este negócio usa **um gateway só**, sem cadeia de reserva. Não construa seletor
de gateway, nem vigia que rebaixa, nem fallback: não há para onde cair. A aba
vira a saúde da PixGo e existe para responder "o meu Pix está funcionando?".

**Estado agora:**

- Modo: "Cobranças reais" (`live`) em verde, ou **"MODO DE TESTE: nenhuma
  cobrança real está sendo gerada"** em vermelho gritante (`mock`). Este é o
  aviso mais importante da aba: `PIXGO_MODE=mock` em produção significa que
  ninguém está pagando de verdade.
- Confirmação automática: "Webhook configurado" (verde) ou "Sem webhook: a
  confirmação depende só da consulta de status, que é limitada" (alerta), lendo
  o que `/api/health` já devolve.
- Armazenamento: "Postgres" (verde) ou "Arquivo local, os pedidos somem no
  próximo deploy" (vermelho).
- Consultas de status hoje: barra com "N de 800 usadas". Acima de 80%, alerta
  explicando que o painel vai parar de reconsultar e que o webhook continua
  valendo.
- Limites do seu nível: mínimo R$ 10,00 e teto por QR Code R$ X (do config).
  Aviso quando algum pedido foi recusado por teto nos últimos 30 dias: "Seu
  nível na PixGo já está apertado para o valor que você vende."

**Conversão e falhas:**

- Tabela por dia (últimos 14 dias): Pedidos, Pagos, Conversão, Faturamento,
  Falhas ao gerar o Pix, Tempo médio até o pagamento.
- Lista das últimas 20 falhas de geração, com motivo traduzido, horário e
  quantas vezes o mesmo motivo apareceu.
- Sentinela: se a conversão das últimas 24 h cair abaixo da metade da média dos
  14 dias anteriores, com pelo menos 10 pedidos no período, a aba mostra em
  alerta "A conversão caiu pela metade nas últimas 24 h. Faça um pagamento de
  teste de R$ 10 para conferir se o Pix está entregando." e dispara **um** aviso
  no canal de controle do Discord a cada 6 h.
- Nota honesta no rodapé: "Volumes diferentes em dias diferentes mudam muito o
  percentual. Compare com cuidado."

**Se um dia entrar um segundo gateway**, o contrato a seguir é: um arquivo por
gateway com `configurada()`, `criarCobranca({valor, nome, email, cpf, telefone})
-> {identifier, pix_code}` lançando erro com status HTTP na recusa, e
`consultarStatus(id)`. Só então valem a escolha manual, o vigia e o fallback do
painel original.

**Regra que vale desde já:** reconhecer "pago" é igualdade **exata** do status
normalizado contra a lista, nunca `includes()`. "unpaid" contém "paid" e
"disapproved" contém "approved". O `STATUS_MAP` de `server/pixgo.ts` já faz
igualdade exata; mantenha assim e não relaxe.

---

## PARTE 10. ABA ACESSOS

Chips: 7, 30 (padrão), 90 dias, 6 meses.

- 4 blocos: "Conectado agora" (aparelho e IP, com pontinho pulsante), "Senha
  errada" (mais N bloqueios, em alerta se maior que zero), "Acessos novos"
  (verde se zero), "Ações no painel".
- Aparelhos: um item por IP mais navegador, com ícone, nome ("Android, Chrome
  (Celular)"), IP e "N entradas, última hoje 09:12". Marcas: "você, agora",
  "primeiro acesso", "N senhas erradas", "bloqueado". Aviso fixo: aparelho
  desconhecido na lista significa trocar a `ADMIN_SENHA` nas variáveis de
  ambiente da Vercel e fazer um redeploy.
- Histórico com filtro Tudo, Entradas, Senha errada, Ações. Linha de risco em
  vermelho, entrada em verde.
- **Ações auditadas** (todas gravadas em `painel_auditoria`, nunca com senha nem
  token, e a auditoria nunca derruba a ação): entrou no painel, errou a senha,
  bloqueado, trocou link de entrega de um produto, gerou link de entrega, marcou
  pago, reenviou e-mail, verificou pendentes, exportou conversões, registrou o
  Ads, etiquetou um lead.

---

## PARTE 11. MODAL DE DETALHES DO PEDIDO

Abre por clique na linha; fecha por X, por clique no fundo ou por Esc; trava o
scroll da página.

- Cabeçalho: nome, badge de status e ID.
- Chips de leitura rápida (neutro, ok, atenção), adaptados a este negócio:
  "Pagou em 4 min" (ok) ou "Aguardando há 2 h" (atenção); "Abriu o link de
  entrega" ou "Ainda não abriu o link" (atenção quando pago há mais de 24 h);
  "Comprou o app" ou "Recusou o upsell"; "Cliente enviou comprovante".
- Grupos: **Pedido** (criado, pago, oferta, adicionais, valor, origem, aparelho
  por extenso), **Entrega** (só pagos: quantas aberturas, última, IP, e o link
  de cada produto pago), **Cliente** (nome, e-mail formatado, telefone
  formatado, CPF formatado), **Compras ligadas** (pedido pai e filhos, com
  status e valor de cada um), **Comprovante** (foto abre inline, PDF baixa, com
  a nota "confira valor e horário na PixGo antes de marcar como pago").
- **5 ações**, com visibilidade condicional ao status:
  1. **Gerar link de entrega de 72 h** (só pagos): copia e vira "Link copiado!"
     por 3 s. O link abre uma página que lista os produtos pagos daquele cliente.
  2. **Reenviar e-mail** (só pagos com e-mail): "Enviando..." e depois "Enviado
     para...". Enquanto não houver provedor de e-mail configurado, o botão fica
     desabilitado com o texto "Configure o envio de e-mail para usar isto".
  3. **WhatsApp** com mensagem pronta **diferente por status**. Escreva como
     pessoa real: abertura natural, contexto do pedido (primeiro nome, produto,
     valor), fechamento com pergunta que puxa resposta. Nunca texto genérico de
     robô, nunca jargão técnico, nunca promessa de resultado espiritual que a
     página não fez. Modelos:
     - Pendente: "Oi, {primeiro nome}! Aqui é da equipe das Rezas Sagradas. Vi
       que você gerou o Pix da Oração ({valor}) há {tempo} e ele ainda está
       aberto. Precisa de ajuda pra pagar ou prefere que eu gere um código novo?"
     - Pago e link não aberto: "Oi, {primeiro nome}! Seu pagamento foi
       confirmado e a sua Oração já está liberada. Aqui está o acesso:
       {link}. Consegue abrir aí?"
     - Pago com comprovante enviado: "Oi, {primeiro nome}! Recebi seu
       comprovante e já confirmei por aqui. Seu acesso está liberado:
       {link}."
  4. **Marcar como pago** (só pendentes): confirmação "Use apenas se você
     confirmou o pagamento na PixGo". Dispara a **mesma** cadeia de um pagamento
     real (Parte 15).
  5. **Copiar pedido**: texto em blocos PEDIDO / CLIENTE / OFERTAS, com telefone
     e CPF **só dígitos**, para colar em formulário.

---

## PARTE 12. /LEADS (EQUIPE)

- Senha própria (`LEADS_SENHA`) ou a do dono; o servidor devolve o papel. Token
  de equipe nunca abre o /admin. Se o dono logar, aparece o atalho "Painel
  completo".
- Cabeçalho com resumo: "N leads no período: X pagos, Y aguardando Pix. Ainda
  sem contato: Z."
- Chips de período (Tudo é o padrão) mais filtros: status, **etiqueta** (cada
  etiqueta, cada "Falta: etiqueta" que é a fila de trabalho, e "Sem nenhuma
  etiqueta"), aparelho, e busca com debounce de 150 ms (sem acento, por dígitos).
- Lista de cartões expansíveis (sanfona), teto de 400 na tela, cartões abertos
  permanecem abertos quando a lista se atualiza (refresh de 60 s).
- Cartão aberto: primeiro "Situação do atendimento" (etiquetas), depois as
  seções de dados. Cada valor é um botão que copia aquele campo ao clicar.
- **Etiquetas** (vocabulário fechado no servidor, rejeita qualquer outra com
  400): `contato` "Falei com o cliente" (verde), `pix_ajuda` "Ensinei a pagar o
  Pix" (azul), `sem_resposta` "Não respondeu" (âmbar), `desistiu` "Desistiu da
  compra" (vermelho), `entregue` "Confirmou que recebeu o acesso" (roxo). Toque
  marca e desmarca com UI otimista (pinta antes da rede, desfaz se falhar),
  mostra "há 5 min pela equipe" ou "por você", persistência append only, e todo
  mundo vê na hora.
- Botões: Chamar no WhatsApp (mensagem contextual), Copiar pedido (mesmo formato
  do /admin), Copiar tudo.
- **Baixar planilha**: CSV do recorte filtrado, separador `;` e BOM UTF-8 (abre
  certo no Excel pt-BR), uma coluna por etiqueta (sim ou vazio), nome
  `leads-AAAA-MM-DD.csv`.
- Toast de rodapé (1,6 s) para toda cópia e toda etiqueta.
- **Nenhuma ação administrativa aqui.** A equipe lê, etiqueta, copia e baixa.
  Sem marcar pago, sem trocar link, sem exportar conversão.

---

## PARTE 13. ROTAS DO BACKEND

Tudo entra em `server/routes/admin.ts`, `server/routes/leads.ts` e
`server/routes/coleta.ts`, registrados em `server/app.ts` junto dos routers que
já existem. Nenhuma mudança no rewrite de `/api` é necessária: a Vercel já manda
todo `/api/*` para a mesma função.

**Admin** (`exigirAdmin`, salvo indicação em contrário; todas respondem
`Cache-Control: no-store`):

| Rota | O que faz |
| --- | --- |
| `POST /api/admin/login` (público) | `{senha}` -> `{token, horas: 12}` |
| `POST /api/leads/login` (público) | `{senha}` -> `{token, horas, papel}` |
| `GET /api/admin/pedidos` (`exigirLeads`) | `{pedidos[], tagsCatalogo[]}` |
| `POST /api/leads/tags` (`exigirLeads`) | `{id, tag, on}` -> `{ok, tags}`. 400 etiqueta desconhecida, 404 pedido inexistente |
| `GET /api/admin/pedidos/:id/comprovantes/:n` (`exigirLeads`) | binário com o mime gravado |
| `GET /api/admin/funil?dias=N` | clamp 1 a 90 |
| `GET /api/admin/relatorios?dias=N` | clamp 7 a 60 |
| `POST /api/admin/relatorios/ads` | `{dia: "AAAA-MM-DD", investido, cliques, impressoes}` |
| `GET /api/admin/acessos?dias=N` | clamp 1 a 180, marca `atual: true` no chamador |
| `GET /api/admin/pixgo` | modo, webhook, armazenamento, orçamento de consultas, conversão por dia, falhas |
| `GET /api/admin/entregas` | links atuais por item, com a origem (tabela ou env) |
| `POST /api/admin/entregas/:itemId` | `{url}` -> grava em `entrega_links`, valida `https://` |
| `POST /api/admin/pedidos/:id/link` | -> `{url}` assinada por 72 h |
| `POST /api/admin/pedidos/:id/marcar-pago` | dispara a mesma cadeia do pagamento real |
| `POST /api/admin/pedidos/:id/reenviar-email` | única rota que espera I/O externo; devolve o erro real como 502 |
| `POST /api/admin/verificar-pendentes` | reconsulta **no máximo 12** não pagos, em lotes de 4; erro de um não interrompe o lote; respeita o orçamento diário -> `{verificados, pagosNovos, restantes, orcamento}` |
| `GET /api/admin/conversoes.csv?nome=...` | CSV do Google Ads |

**Públicas de apoio:**

| Rota | O que faz |
| --- | --- |
| `GET /api/entrega/:id/:exp/:sig` | valida expiração (410), HMAC em tempo constante (403) e pedido pago (403); registra o evento de entrega e mostra os produtos pagos. `sig = HMAC-SHA256(PAINEL_CHAVE_MESTRA, id + "." + exp)` truncado em 40 hex |
| `POST /api/pedidos/:id/comprovante` | upload público, **4 MB**, valida magic bytes (JPG, PNG, WEBP, PDF) e nunca o mime declarado, máximo 3 por pedido (429), bloqueado se já pago (409). Não confirma nada: só avisa o canal de controle para conferência humana |
| `POST /api/coleta` | ingestão do funil (nome neutro de propósito: bloqueadores derrubam `/track`). Responde 204 **depois** de gravar, por causa do congelamento da função |
| `GET /api/cron/varredura` | protegida por `CRON_SECRET` em `Authorization: Bearer`, comparado em tempo constante. Reconsulta até 15 pendentes das últimas 48 h e faz a limpeza de retenção |

**Freios na criação de cobrança** (o `createRateLimiter` atual continua, e some
a estes): reuso da mesma cobrança por 10 min para o mesmo CPF, oferta e valor
(já existe, não gere Pix novo a cada F5); tetos horários por CPF, IP, e-mail e
telefone com alerta no canal de controle ao bater (um alerta por chave por hora,
com CPF e telefone reduzidos aos 4 últimos dígitos no alerta).

---

## PARTE 14. TRACKER, INGESTÃO E PRIVACIDADE (LGPD)

**Aviso que muda o desenho deste tracker:** as respostas do quiz revelam
**convicção religiosa** e situação financeira. Convicção religiosa é dado
pessoal **sensível** na LGPD (art. 5º, II) e exige consentimento específico e
destacado. Por isso:

- Grave **apenas o ID da opção** (`q2_op3`), nunca o texto, e **nunca ligado a
  nome, CPF, e-mail ou telefone**. O `sid` é anônimo e só vira `oid` quando o
  pedido é criado, o que já é suficiente para medir o funil.
- **Não** copie respostas do quiz para dentro do pedido. Se o dono quiser as
  respostas para personalizar a entrega, isso é uma decisão separada, que exige
  consentimento explícito na tela e base legal escrita na política de
  privacidade. Não implemente por conta própria.
- A página de política de privacidade continua pendente (está no README). O
  painel não resolve isso, mas o texto de consentimento do checkout precisa
  existir antes de vender em escala.

**Tracker no navegador:** um módulo único em `src/lib/tracker.ts`, importado por
`src/App.tsx` e `src/components/InlineCheckout.tsx`. Ele não pode mudar layout
nem bloquear nada.

- `sid` = UUID anônimo em `sessionStorage`, sem cookie. `oid` = id do pedido,
  ligado depois. A origem (utm, `gclid` como **booleano** no evento, referrer
  classificado) é capturada no **primeiro pageview** e guardada em
  `sessionStorage`.
- Fila em memória, envio em lote a cada 2 s ou a cada 10 eventos (`fetch` com
  `keepalive`). `pedido_criado` vai na hora (flush imediato). `pagehide` e
  `visibilitychange: hidden` descarregam via `sendBeacon`, que é o evento que
  registra abandono.
- **Tudo em try/catch silencioso: analytics nunca quebra venda.**

**Catálogo de eventos, com whitelist no servidor.** Evento fora do catálogo é
descartado. Todo evento que o servidor emitir também precisa estar no catálogo,
senão some da agregação.

Cliente, funil do quiz:
`funil_iniciado`, `quiz_pergunta_vista {q}`, `quiz_respondida {q, op}`,
`quiz_voltou {q}`, `quiz_reiniciou`, `audio_visto`, `audio_play`, `audio_fim`,
`depoimentos_visto`, `calculo_visto`, `oferta_vista`.

Cliente, checkout:
`checkout_aberto`, `bump_marcado {item}`, `bump_desmarcado {item}`,
`erro_validacao {campo}`, `pix_tentado {oferta}`, `pedido_criado {oferta}`,
`pix_falha_cliente {codigo}`, `qr_visualizado {oferta}`, `pix_copiado {oferta}`,
`ja_paguei_clicado {oferta}`, `pix_expirado {oferta}`, `checkout_saida {etapa}`,
`upsell_visto`, `upsell_aceito`, `upsell_recusado`, `downsell_visto`,
`downsell_aceito`, `downsell_recusado`, `acesso_visto`, `entrega_aberta {item}`.

Servidor, gravados direto:
`checkout_rejeitado {motivo}`, `pix_gerado {oferta, total, latenciaMs}`,
`pix_falha {tipo, codigo, latenciaMs}`,
`pagamento_liquidado {oferta, origemConfirmacao: webhook|polling|manual, minDesdeCriacao, total}`.

**Privacidade, inegociável.** Nunca grave em evento: nome, CPF, e-mail,
telefone, endereço, CEP, IP, User-Agent cru, valor do `gclid` (só a presença
como booleano), nem o texto das respostas do quiz. O User-Agent vira apenas
`{tipo, so, nav}` e é descartado.

**Defesa na ingestão** (não confie em quem emite): whitelist de eventos, lista
negra de chaves com cara de PII
(`nome|cpf|email|telefone|endereco|cep|senha|token|ip|nascimento|documento`),
no máximo 14 propriedades, string truncada em 120 caracteres, corpo de no
máximo 14 KB (413), lote de no máximo 25 eventos, `sid` validado por regex, e
rate limit de 240 requisições por minuto por IP. O IP é usado **só** para o rate
limit e nunca é gravado.

**Agregação** (uma passada em SQL sobre a janela pedida):

- A **verdade financeira vem da tabela `orders`**: pedidos criados e pagos
  contam pelo pedido, nunca pelo navegador. Pedido sem eventos de cliente
  (bloqueador de anúncio) ganha sessão sintética no estágio certo, para a conta
  nunca mentir.
- Abandono: sessão sem estágio final e sem eventos há 30 min ou mais,
  classificada pela última etapa. Tempos em mediana. Resposta única contendo:
  extras (sessões, criados, pagos, conversões), funil do quiz por pergunta,
  funil do checkout por etapa, abandono por etapa, tempos, erros (validação por
  campo, rejeições do servidor por motivo, falhas de Pix por tipo),
  comportamento na tela do Pix (quem pagou contra quem saiu) e segmentos
  (dispositivo, navegador, origem).

---

## PARTE 15. WEBHOOK, PÓS PAGAMENTO E GOOGLE ADS

**Webhook.** O que já existe em `server/routes/webhook.ts` está correto e deve
ser preservado: assinatura HMAC-SHA256 sobre `timestamp + "." + corpo cru`
validada **antes de tudo**, janela anti replay de 300 s, dedupe por
`markWebhookProcessed` no Postgres.

Uma mudança de princípio a aplicar: **o corpo do webhook não é fonte de
verdade**. Hoje o handler confia no `event` e no `status` do corpo. Passe a
**reconsultar a PixGo** pelo `payment_id` antes de marcar como pago, com duas
saídas de emergência: se a reconsulta falhar ou o orçamento diário estiver
esgotado, aceite o corpo **apenas** quando as três travas valerem juntas
(assinatura válida, pedido existente daquele `payment_id`, e valor do corpo
igual ao valor do pedido) e registre isso na auditoria como confirmação por
corpo. Um POST forjado com `status: paid` nunca pode liberar nada.

**Guarda de duplicata:** toda transição passa por `applyStatus`, que já ignora
regressões e não repaga o que já está pago. Processos concorrentes convergem.

**Ao virar pago, nesta ordem** (tudo aguardado, sem promessa solta, cada passo
em try/catch que não derruba o anterior):

1. gravar `pedido_eventos` com `evento: 'pago'` e a origem;
2. gravar `pagamento_liquidado` em `funil_eventos`;
3. notificar a venda no canal de vendas do Discord;
4. montar a entrega (os links já saem por `buildAccessBundle`);
5. enfileirar a conversão do Google Ads (o pedido já carrega `rastreio`).

**Google Ads.**

- Capture `gclid`, `gbraid` e `wbraid` **crus** na entrada do site (primeiro
  pageview, guardados em `sessionStorage`) e grave **no pedido**, nunca em
  evento de analytics. Upsell e downsell herdam do pedido pai.
- Export CSV no formato exato de "Importar conversões" do Google Ads:
  - linha 1: `Parameters:TimeZone=America/Sao_Paulo,,,,,,`
  - linha 2: `Google Click ID,GBRAID,WBRAID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency`
  - uma linha por pedido pago que tenha identificador de clique;
    `Conversion Time` em `aaaa-MM-dd HH:mm:ss` no fuso local; moeda `BRL`;
    quebras de linha CRLF.
  - O nome da ação vem de `?nome=` (o painel pergunta e lembra em
    `localStorage`).
- Conversão puramente do lado do cliente **não funciona** para Pix: o cliente
  paga no app do banco e não volta para a página. A conversão confiável é do
  lado do servidor, via `gclid`.

**Alertas do Discord** (variáveis separadas por canal, e no serverless sempre
aguardados com timeout de 1,5 s):

- **Canal de vendas:** venda aprovada (primeiro nome, valor, oferta, adicionais,
  aparelho).
- **Canal de pendentes:** Pix gerado aguardando pagamento.
- **Canal de controle** (nunca com fallback para o canal de vendas): tetos de
  geração batidos, conversão despencando, comprovante recebido, acesso novo ao
  painel, bloqueio por senhas erradas, `PIXGO_MODE=mock` detectado em produção,
  orçamento de consultas da PixGo acima de 80%.
- Avisos de configuração faltando no boot vão para o log, sem derrubar o app,
  no mesmo padrão que `getConfigIssues()` já usa.

**E-mail (opcional, mas é o maior buraco operacional hoje).** Sem e-mail, quem
fechar a aba depois de pagar fica sem o produto e vira reembolso. Se for
implementar, use um provedor HTTP (que funciona em serverless, diferente de
SMTP com conexão longa), envie o link de entrega assim que o pagamento
confirmar, e só então habilite o botão "Reenviar e-mail" do modal. Enquanto isso
não existir, o painel deve deixar o buraco visível, não escondido.

**Recuperação de pendentes (opcional):** e-mail com o QR cerca de 8 min depois,
e WhatsApp com template aprovado cerca de 45 min depois. Em serverless, a fila
não é `setTimeout`: é uma tabela com `enviar_em` lida pelo cron.

---

## PARTE 16. REGRAS DE UX, TEXTO E DESIGN

**Formatação:**

- Dinheiro sempre em pt-BR e BRL (R$ 1.234,56); percentual com vírgula; números
  tabulares nas tabelas; valor ausente vira traço, nunca zero e nunca vazio.
- Datas em 3 formatos, por contexto: completa (modal e CSV), curta relativa
  ("hoje 13:52", "ontem 08:51", "12/07 19:03") e "há quanto tempo" ("agora",
  "há 5 min", "há 2 h", "ontem").
- CPF e telefone formatados **na tela** e só dígitos **ao copiar**.

**Honestidade estatística (o painel nunca mente para o dono):**

- Aviso de amostra pequena abaixo de 20 sessões. Comparação neutra em dia
  parcial. Comparação de taxas só com 5 ou mais de cada lado. Carro chefe só com
  liderança real. Piso de escala nas barras de falha. Métrica sem dado é marcada
  "parcial", nunca calculada pela metade em silêncio.

**Feedback e vocabulário:**

- Todo botão que age troca o próprio rótulo por 2 a 4 s ("Copiado!",
  "Verificando...", "Enviado para..."), sem toast e sem modal (a exceção é o
  toast do /leads).
- Ação de dinheiro ou destrutiva pede confirmação (marcar pago, trocar link de
  entrega).
- Estados vazios sempre com instrução ("Assim que houver pedidos, o fechamento
  aparece aqui."), nunca tela em branco.
- Vocabulário do dono, não do sistema. Nada de "pending", "error 502",
  "webhook", "offer", "gateway".

**Design:**

- Tema claro e escuro por tokens CSS, com toggle na topbar e sem flash na carga.
- O painel **não** copia o visual dourado e devocional do funil. O funil vende;
  o painel é ferramenta de trabalho e precisa de contraste alto, densidade e
  neutralidade. Referência: painel profissional de verdade (Stripe, Shopify,
  Mercado Livre). Nada de grades uniformes de cards idênticos, glows ou
  gradientes decorativos. Na dúvida, tire o enfeite. Assimetria intencional e
  hierarquia clara.
- Acessibilidade: `role="tablist"`, `tab`, `tabpanel`, `aria-selected`,
  `aria-pressed` nas etiquetas, `aria-label` em ícones, Esc fecha o modal, KPI
  clicável por teclado.
- Mobile primeiro nos breakpoints: por volta de 1024 px a navegação vira barra
  fixa; por volta de 900 px as colunas menos importantes somem; até 640 px a
  tabela vira cartões e a ordem da página prioriza a lista.
- **Nunca usar travessão nem sequências de hífens em nenhum texto do painel.**

---

## PARTE 17. ADAPTAÇÕES JÁ RESOLVIDAS (NÃO INVENTE OUTRAS)

Estas decisões já estão tomadas neste documento. Não volte ao painel original
para copiar o que foi substituído:

| Painel original | Aqui |
| --- | --- |
| NDJSON em `DATA_DIR` | Tabelas append only no Postgres (Neon) |
| Vários gateways, vigia, fallback | PixGo sozinha, aba de saúde e sentinela de conversão |
| "Serviço" e "processamento" | "Oferta" (`main`, `upsell`, `downsell`) e "adicionais" (order bumps) |
| Painel de PDFs entregáveis | Painel de links de entrega editáveis, tabela `entrega_links` |
| Etapas genéricas do checkout | Funil do quiz (9 perguntas) mais funil do checkout, com upsell e downsell |
| Etiquetas do nicho antigo | `contato`, `pix_ajuda`, `sem_resposta`, `desistiu`, `entregue` |
| Varredura por `setInterval` | Vercel Cron com `CRON_SECRET` |
| Rate limit em memória | Tabela `painel_bloqueios` no Postgres |
| Alertas fire and forget | Sempre aguardados, com timeout de 1,5 s |
| Upload de 8 MB | 4 MB, pelo limite de corpo da Vercel |
| Segredo em arquivo no disco | `PAINEL_CHAVE_MESTRA` como variável de ambiente |
| `app.listen(process.env.PORT)` sem conversão | Não se aplica: a Vercel invoca o handler de `api/index.ts` |

Adapte ainda, ao escrever cada texto: nomes de produto sempre os do catálogo,
mensagens de WhatsApp com tom de pessoa real e sem promessa de resultado, e
nenhuma referência ao projeto de origem em slug, nome de arquivo ou texto.

---

## PARTE 18. VARIÁVEIS DE AMBIENTE NOVAS

Acrescente ao `.env.example`, ao `server/config.ts` (com aviso no boot quando
faltar) e ao painel de Environment Variables da Vercel:

```
ADMIN_SENHA="..."                  # obrigatória; sem ela o painel não sobe
LEADS_SENHA=""                     # opcional; sem ela o /leads só aceita a senha do dono
PAINEL_CHAVE_MESTRA="..."          # obrigatória; openssl rand -hex 32
ADMIN_FUSO="-03:00"                # fuso do fechamento diário
CRON_SECRET="..."                  # a Vercel injeta sozinha ao usar crons; valide o Bearer
TRUST_PROXY="true"                 # obrigatório na Vercel
DISCORD_WEBHOOK_VENDAS=""
DISCORD_WEBHOOK_PENDENTES=""
DISCORD_WEBHOOK_CONTROLE=""
EMAIL_API_KEY=""                   # opcional; sem ela o reenvio de e-mail fica desabilitado
EMAIL_REMETENTE=""
```

---

## PARTE 19. ORDEM DE IMPLEMENTAÇÃO SUGERIDA

Cada etapa termina com o app rodando. Não comece a próxima com a anterior
quebrada.

1. Migração das tabelas novas em `pgStore.ts` mais os campos novos do pedido
   (`rastreio`, `utm`, `aparelho`, `trackId`, `entregas`), tolerando pedido
   antigo sem essas chaves.
2. Sessão, login, `exigirAdmin`, `exigirLeads`, `painel_bloqueios` e auditoria.
3. `/admin` com a aba Pedidos completa e o modal. É o que o dono usa no primeiro
   dia.
4. Painel de links de entrega, link assinado de 72 h e o evento de entrega. É o
   que fecha o buraco de o cliente pagar e não receber.
5. `/leads` com etiquetas e CSV.
6. Tracker, `/api/coleta` e a aba Funil.
7. Aba Relatórios com o registro de Ads, e o CSV do Google Ads.
8. Aba PixGo e aba Acessos.
9. Cron de varredura e de retenção, alertas do Discord, comprovante.

---

## PARTE 20. CRITÉRIO DE PRONTO

- [ ] Login do /admin e do /leads com as duas senhas, bloqueio após 5 erros por
      15 min gravado no Postgres, token de equipe não abre o /admin, 401 em
      qualquer chamada derruba para o login.
- [ ] Aba Pedidos: KPIs com comparação (neutra no chip Hoje), contagem de
      clientes separada da contagem de cobranças, faixa de cobrança de 48 h com
      WhatsApp, 3 widgets, tabela com filtros, ordenação e busca, cartões no
      mobile.
- [ ] Modal do pedido com as 5 ações funcionando de ponta a ponta (reenviar
      e-mail pode estar desabilitado com o motivo, mas nunca escondido).
- [ ] Links de entrega editáveis pelo painel valem na hora, sem deploy, e o
      cartão sem link aparece em vermelho.
- [ ] Aba Relatórios: registrar, editar e apagar o Ads do dia recalcula tudo; as
      réguas de cor batem com os limiares desta especificação.
- [ ] Aba Funil: eventos chegando do funil React real, com **controles
      negativos** testados (evento fora do catálogo descartado, chave com cara
      de PII removida, `sid` inválido rejeitado, texto de resposta do quiz nunca
      gravado).
- [ ] Aba PixGo: `PIXGO_MODE=mock` aparece como alerta vermelho; o orçamento de
      consultas do dia bate com `/api/health`; a sentinela de conversão dispara.
- [ ] Aba Acessos: as ações auditadas aparecem e o acesso novo alerta no Discord.
- [ ] Webhook: POST forjado com `status: paid` **não** marca pago (a reconsulta
      manda); pagamento real marca uma vez só, mesmo com webhook e polling
      chegando juntos.
- [ ] Serverless: nada crítico em memória, nenhum alerta ou gravação depois do
      `res.end`, `no-store` em todo GET do painel, nenhuma escrita em disco.
- [ ] CSV de conversões abre no Google Ads sem erro de formato; planilha do
      /leads abre certa no Excel pt-BR.
- [ ] Teste fim a fim com `PIXGO_MODE=mock`, `DATABASE_URL` apontando para um
      banco de teste e os webhooks do Discord vazios, sem gastar crédito da
      PixGo e sem sujar a produção.
