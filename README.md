# Funil Arcanjo Miguel — Rezas Sagradas

Funil de vendas em React (Vite) com backend Node/Express integrado à **API PIX da PixGo**.

---

## Como rodar

**Pré-requisitos:** Node.js 18+ (o backend usa `fetch` nativo).

```bash
npm install
cp .env.example .env.local   # e preencha os valores
```

Você precisa de **dois processos** em desenvolvimento:

```bash
npm run dev:server   # backend  -> http://localhost:3333
npm run dev          # frontend -> http://localhost:3000
```

O Vite faz proxy de `/api` para o backend, então as chamadas ficam na mesma origem e não há CORS.

### Testar sem gerar cobrança real

Para desenvolver o funil sem criar cobranças de verdade, use o modo mock:

```bash
PIX_MODE=mock npm run dev:server
```

As cobranças são simuladas e se confirmam sozinhas após ~12 segundos. O servidor exibe um aviso em destaque enquanto estiver nesse modo. **Nunca use `mock` em produção.**

### Produção

```bash
npm run build                 # gera dist/
SERVE_STATIC=true npm start   # Express serve a API + os arquivos de dist/
```

---

## Configuração da PixGo

1. Em [pixgo.org](https://pixgo.org), com a carteira Liquid validada, abra a seção **Checkouts** e pegue a **API Key** (`pk_...`) e o **Webhook Secret** (`whsec_...`).
2. Preencha no `.env.local`:

```
PIXGO_API_KEY="pk_..."
PIXGO_WEBHOOK_SECRET="whsec_..."
PIXGO_BASE_URL="https://pixgo.org/api/v1"
PIX_MODE="live"
PUBLIC_BASE_URL="https://seudominio.com.br"
```

A autenticação é uma chave só, enviada no cabeçalho `X-API-Key` de cada chamada.

O endereço do callback vai no campo `webhook_url` de cada cobrança, apontando para `PUBLIC_BASE_URL + /api/webhooks/pix`. Sem uma URL https pública, a confirmação passa a depender só da varredura de pendentes: o pagamento entra, mas a liberação demora.

> **Não existe ambiente de teste.** Toda chave da PixGo é de produção e toda cobrança criada é dinheiro de verdade. Para exercitar o funil sem cobrar ninguém, use `PIX_MODE="mock"`, e para conferir o formato da integração rode `node scripts/testar-pixgo.mjs`, que sobe uma PixGo falsa localmente.

---

## Limites que afetam este funil

| Limite | Valor | Impacto |
| --- | --- | --- |
| Valor mínimo por cobrança | **R$ 10,00** | `PIX_MIN_AMOUNT_BRL`; abaixo disso a API recusa |
| Teto por cobrança | **depende do nível da conta** | Começa em R$ 300,00 e sobe até R$ 6.000,00 conforme o total confirmado. Acima do nível, a API responde `LIMIT_EXCEEDED` |
| `POST /payment/create` | 10.000 por 24 h | Folgado para o uso normal |
| `GET /payment/{id}` | 10.000 por 24 h | **É o que usamos** para reconciliar |
| `GET /payment/{id}/status` | **1.000 por 24 h** | Dez vezes menor — evitado de propósito |
| Limite diário por CPF pagador | R$ 6.000,00 | Afeta quem compra várias vezes no mesmo dia |
| CPF do pagador | exigido **por nós** | A API aceita sem, mas é o CPF que trava quem pode pagar |

### Por que consultamos `/payment/{id}` e não `/payment/{id}/status`

Os dois devolvem o campo `status`, mas o endpoint de status tem um teto dez vezes menor. Estourá-lo significaria parar de confirmar pagamento de quem já pagou — o pior defeito possível. Em compensação, `/payment/{id}` responde **410 Gone** quando a cobrança chega a um estado final, com o mesmo corpo do 200; tratamos 410 como resposta válida, senão todo pedido expirado viraria falha e seria reconsultado para sempre.

Confirmado contra a API de verdade: cobrança expirada devolve `410` em `/payment/{id}` e `200` em `/payment/{id}/status`.

O downsell está em **R$ 10,00** por causa do mínimo da PixGo — é exatamente o piso, então não dá para voltar aos R$ 9,90 da copy sem trocar de gateway.

### O CPF trava quem pode pagar

Depois que o QR é gerado, **só o CPF informado consegue pagar**. Se outra pessoa pagar, a PixGo rejeita e o estorno para o terceiro leva até 48 h. Por isso o checkout pede "CPF de quem vai pagar" — não é preciosismo, é a regra do gateway.

### Divergências entre as duas documentações da PixGo

Circulam duas versões do guia, e elas se contradizem. O que foi verificado contra a API de verdade:

| Assunto | Doc A | Doc B | O que vale |
| --- | --- | --- | --- |
| Nome do campo do CPF | `receiver_cpf` | `receiver_cpf` (exemplos usam `customer_*`) | **`receiver_cpf`** — a API validou e recusou nomeando o campo |
| CPF obrigatório | "obrigatório desde 25/06/2026" | "Obrigatório: Não" | **Não é exigido** — uma cobrança sem CPF foi aceita. Exigimos mesmo assim, porque é o CPF que trava quem pode pagar |
| Segredo que assina o webhook | Webhook Secret (`whsec_...`) | A própria API Key (`pk_...`) | **Aceitamos os dois** — ver abaixo |
| Estrutura do payload | tudo dentro de `data` | campos na raiz | **Aceitamos as duas** |
| Eventos | 3 | 4 (inclui `order.created`) | Tratamos os 4 |

A divergência do segredo é a mais perigosa: escolher um só e errar significaria recusar **todo** callback legítimo, e nenhuma venda se confirmaria pelo webhook. Conferimos a assinatura contra os dois segredos possíveis — ambos são conhecidos só por nós e pela PixGo, então bater com qualquer um prova a origem do mesmo jeito.

O evento `order.created` dispara a cada cobrança criada e não confirma pagamento nenhum: registramos e paramos, sem gastar uma consulta do teto diário.

Um detalhe de prazo: a PixGo desiste do webhook em ~10 s e reenvia. Por isso a consulta feita dentro do callback tem teto de 6 s, e não os 15 s padrão — senão a resposta chegaria sempre tarde e eles reentregariam em looping.

### A validação de CPF é mais dura do que a nossa

A PixGo consulta a **Receita Federal**; o nosso checkout confere só o dígito verificador. Quem digitar um CPF plausível mas inexistente passa por nós e é barrado lá, com `PAYER_BLOCKED`. A mensagem técnica deles (parte em inglês) é traduzida antes de chegar ao cliente.

---

## Como a confirmação de pagamento funciona

A PixGo chama `/api/webhooks/pix` com os eventos `payment.completed`, `payment.expired` e `payment.refunded`. Duas barreiras protegem esse endereço, que é público:

1. **Assinatura HMAC-SHA256** sobre `timestamp + "." + corpo cru`, com o Webhook Secret, comparada em tempo constante. Carimbo fora de 5 minutos é recusado, para um aviso legítimo capturado antes não poder ser reenviado depois.
2. **O corpo não é fonte de verdade**, nem depois de a assinatura conferir: dele sai apenas o identificador da cobrança, e o servidor consulta `GET /payment/{id}/status` para saber o status real antes de liberar qualquer coisa. Um POST forjado dizendo `completed` não libera produto nenhum.

A segunda barreira não é redundância: é o que mantém o sistema seguro se o segredo vazar ou se a PixGo mudar o esquema de assinatura.

Como segunda rede existe a **consulta de status**: o navegador consulta o nosso backend a cada 4 segundos, e o backend só repassa a pergunta para a PixGo no máximo uma vez a cada 25 segundos por pedido, dentro de um orçamento diário. O consumo do dia aparece em `GET /api/health`.

O endpoint de detalhes responde **410 Gone** quando a cobrança chega a um estado final, com o mesmo corpo do 200. Tratamos 410 como resposta válida — encarar como erro faria o pedido ser reconsultado para sempre, gastando o orçamento à toa.

Status tratados: `completed` libera, `expired` expira, `cancelled` cancela, `refunded` estorna, `pending` aguarda. Qualquer status desconhecido cai em **pendente**, que é o lado seguro — inventar "pago" a partir de um nome que não conhecemos entregaria produto de graça.

`MED` (Mecanismo Especial de Devolução do PIX) é análise de devolução, não devolução consumada: ele **não** revoga o acesso de quem pagou e **não** libera nada de quem não pagou; fica registrado para decisão humana.

O campo `payer_euid` que a PixGo devolve **não** serve como sinal de pagamento — ele vem nulo até a confirmação e pode continuar nulo depois. Quem decide é o `status`.

O frontend **nunca** decide que um pagamento aconteceu — quem libera o acesso é sempre o servidor.

---

## Endpoints

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/health` | Status do servidor, modo e consumo de consultas do dia |
| `POST` | `/api/orders` | Cria a cobrança PIX e devolve o código copia-e-cola |
| `GET` | `/api/orders/:id` | Status do pedido (sincroniza com a PixGo quando permitido) |
| `GET` | `/api/orders/:id/access` | Conteúdo liberado; responde `402` enquanto não houver pagamento |
| `POST` | `/api/webhooks/pix` | Recebe os callbacks da PixGo (assinatura conferida; o status vem sempre de reconsulta) |
| `POST` | `/api/track` | Evento do funil (navegação). Responde sempre `204`; nunca aceita valor em dinheiro |

---

## Rastreamento do Meta (Facebook/Instagram)

Duas metades que trabalham juntas, com o **mesmo `event_id`** para o Meta não
contar a mesma ação duas vezes:

- **Pixel no navegador** ([`src/lib/metaPixel.ts`](src/lib/metaPixel.ts)) — perde
  de 20% a 50% dos eventos para bloqueadores, Safari e iPhone;
- **API de Conversões no servidor** ([`server/meta.ts`](server/meta.ts)) — único
  arquivo que conhece o Meta, no mesmo desenho de `server/pix.ts`.

**A compra sai obrigatoriamente do servidor.** No PIX o cliente sai do site para
pagar no app do banco e boa parte não volta: se o `Purchase` dependesse do
navegador, o Meta perderia justamente as vendas concluídas e o robô aprenderia a
entregar para quem clica, não para quem paga.

| Momento | Evento | Pixel | Servidor |
| --- | --- | --- | --- |
| Abertura do funil | `PageView` | sim | sim |
| Fim do quiz (tela 12) | `CompleteRegistration` | sim | sim |
| Chegada na VSL (tela 13) | `ViewContent` | sim | sim |
| Clique em "Garantir minha vaga" | `InitiateCheckout` | sim | sim |
| Formulário enviado | `Lead` | sim | sim |
| QR do PIX gerado | `AddPaymentInfo` | sim | sim |
| **Pagamento confirmado** | `Purchase` | só na `/obg`, com o `event_id` do servidor | **sim, obrigatório** |

Regras que valem tanto quanto as do pagamento:

1. **`POST /api/track` não aceita `Purchase` nem valor em dinheiro.** Seria um
   endereço público onde qualquer pessoa declara faturamento que não existiu. O
   valor sai sempre de [`server/catalog.ts`](server/catalog.ts).
2. **O valor vai em reais decimais** (`56.90`), e o sistema guarda centavos —
   mesma pegadinha da PixGo. Mandar `5690` reporta cinquenta e seis mil reais.
3. **O `event_id` da compra é determinístico** (`purchase_<pedido>_<oferta>`).
   O webhook da PixGo é reentregue por desenho; com identificador aleatório,
   cada reentrega viraria uma venda a mais no relatório.
4. **O carimbo do anúncio gruda no pedido**, não na sessão: a confirmação chega
   horas depois, sem navegador aberto.
5. **Rastreamento não derruba venda.** Meta fora do ar, token errado ou
   `META_TRACKING_ENABLED=false` não afetam cobrança, confirmação nem entrega. O
   que falha vira pendência reenviável pelo botão da aba **Anúncios**.
6. **Dentro do webhook o envio tem orçamento de ~2,5 s.** A PixGo desiste em
   ~10 s e reenvia; a consulta de status já consome até 6 s.

### Os parâmetros de URL do anúncio

Cole **exatamente isto** no campo **Parâmetros de URL** do anúncio (Gerenciador
de Anúncios → nível do **anúncio** → seção **Rastreamento**):

```
utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}&utm_term={{adset.name}}&utm_content={{ad.name}}&fb_campaign_id={{campaign.id}}&fb_adset_id={{adset.id}}&fb_ad_id={{ad.id}}&fb_placement={{placement}}&fb_source={{site_source_name}}
```

É a mesma linha para todos os anúncios — nada aqui é gerado ou personalizado por
campanha. As chaves duplas são variáveis do próprio Meta: ele as substitui pelo
nome e pelo ID reais no instante do clique.

Regras que fazem diferença:

- O campo **URL do site** fica limpo (`https://seudominio.com.br/`). Parâmetro
  não vai lá.
- **Não renomeie os parâmetros.** [`src/lib/attribution.ts`](src/lib/attribution.ts)
  lê exatamente estes nomes; qualquer outro é descartado e a venda vira
  "(sem origem)" no painel.
- **Sem espaço e sem acento** nos nomes de campanha, conjunto e anúncio — eles
  vão parar dentro da URL. Use um padrão como `RS_frio_video01`.
- O `fbclid` **não** entra nessa lista: o Facebook o acrescenta sozinho.
- O `gclid` também não: ele vem das campanhas do Google, que usam a linha
  equivalente no acompanhamento de URL.

Para conferir que o carimbo funciona, abra o funil com os parâmetros à mão e
complete uma compra em modo mock — o pedido tem de aparecer no painel com a
campanha certa:

```
http://localhost:3000/?utm_source=facebook&utm_campaign=teste&fb_ad_id=123&fbclid=ABC123
```

### Investimento: de onde vem o "quanto gastei"

O painel sabe quanto cada anúncio **faturou** (dos pedidos PIX confirmados), mas
o quanto ele **custou** só existe no Gerenciador de Anúncios. Dois caminhos, os
dois na aba **Anúncios**:

1. **Digitar à mão** — a coluna Investido aceita digitação quando o período
   selecionado é "Hoje" (é por dia que o valor é guardado). Custa zero.
2. **Importar de uma planilha** — se você usa Stract, Supermetrics ou parecido
   para jogar o gasto numa Google Sheet, cole o endereço dela publicado em CSV
   (*Arquivo → Compartilhar → Publicar na web → CSV*) e clique em "Importar
   agora". A coluna passa a se preencher sozinha.

O importador ([`server/investimento.ts`](server/investimento.ts)) reconhece os
nomes de coluna mais comuns em português e inglês (`Data`/`date`,
`ID da campanha`/`campaign_id`, `Valor gasto`/`spend`), aceita separador `,` `;`
ou tabulação, e lê dinheiro nos dois formatos — `1.234,56` e `1,234.56`.

Três cuidados que valem a pena conhecer:

- **Só planilha do Google.** O servidor é quem busca a URL; sem essa trava, o
  painel viraria uma porta para sondar a rede interna onde ele roda.
- **Linha ruim não derruba a importação**, mas é relatada na tela. Importação
  que engole linha em silêncio mostra gasto menor do que foi — pior do que não
  importar.
- **Campanha com gasto e zero visita aparece na tabela.** É o caso que mais
  importa ver: dinheiro que saiu e não trouxe ninguém.

O ROAS calculado aqui usa a **sua** receita confirmada, não a que o Meta
atribuiu — os dois números podem divergir, e este é o que vale.

### Onde ficam o Pixel e o token

Dois caminhos, e o painel vence quando os dois existem:

| Origem | Como | Quando vale |
| --- | --- | --- |
| **Painel** | `/admin` → Anúncios → Credenciais do Meta | na hora |
| Variáveis de ambiente | `META_PIXEL_ID`, `META_CAPI_TOKEN`, `VITE_META_PIXEL_ID` | no próximo deploy |

O painel existe porque trocar `VITE_META_PIXEL_ID` exige **build novo** — o
número é embutido no bundle pelo Vite — e quem opera o negócio não faz deploy.
Salvo pelo painel, o Pixel chega ao navegador por `GET /api/rastreamento/pixel`
e os eventos disparados antes da resposta esperam numa fila, para a primeira
visita da sessão não se perder.

Três coisas que o painel faz e vale saber:

- **O token é guardado cifrado** (AES-256-GCM, chave derivada da
  `PAINEL_CHAVE_MESTRA`, que vive fora do banco). Um dump do Postgres sai sem
  token utilizável. Sem chave mestra configurada, o painel **recusa** guardar o
  token em vez de gravá-lo em texto puro.
- **Campo de token em branco mantém o que já está lá.** A tela só mostra a
  máscara, então o branco seria o estado normal de quem abriu para mexer noutra
  coisa. Para remover, escreva `apagar`.
- **"Testar conexão" não registra evento nenhum** — manda `data: []`, que o Meta
  valida e descarta. A conta é de produção; um Purchase de mentira envenenaria a
  otimização de verdade.

Trocar a `PAINEL_CHAVE_MESTRA` torna o token guardado ilegível. O sistema cai
para a variável de ambiente, avisa no painel e pede o token de novo — em vez de
falhar calado.

### O que ainda depende de você (não é código)

- **Domínio próprio** — `rezassagradas.vercel.app` não pode ser verificado no
  Meta (DNS compartilhado), e sem verificação de domínio não há Configuração de
  Eventos Agregados, que é o que faz a compra vinda de iPhone ser atribuída.
- Criar o conjunto de dados e gerar o token no Gerenciador de Eventos.
- No anúncio: marcar **"Eventos do site"** e colar os parâmetros de URL com as
  variáveis dinâmicas (`{{campaign.id}}`, `{{ad.id}}`, …). Sem espaço nem acento
  nos nomes de campanha, conjunto e anúncio — eles vão parar na URL.

Para conferir tudo sem gastar dinheiro: `node scripts/testar-rastreamento.mjs`.

Exemplo de criação de pedido:

```bash
curl -X POST http://localhost:3333/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "offer": "main",
    "bumps": ["salmos_150"],
    "customer": {
      "name": "Maria Silva",
      "email": "maria@exemplo.com",
      "phone": "11999998888",
      "document": "52998224725"
    }
  }'
```

O upsell e o downsell reaproveitam os dados do pedido principal:

```bash
curl -X POST http://localhost:3333/api/orders \
  -H "Content-Type: application/json" \
  -d '{"offer": "upsell", "parentOrderId": "<id do pedido principal>"}'
```

---

## Preços

Os preços ficam em [`server/catalog.ts`](server/catalog.ts) e essa é a **única fonte da verdade**: o cliente envia apenas IDs de produto e o servidor recalcula o total, então o valor não pode ser adulterado pelo navegador. A lista em `src/components/InlineCheckout.tsx` serve só para exibição e precisa ser mantida em sincronia com o catálogo.

| Produto | ID | Preço |
| --- | --- | --- |
| Oração Sagrada do Arcanjo Miguel | `main` | R$ 27,00 |
| Guia dos 150 Salmos (order bump) | `salmos_150` | R$ 10,00 |
| Vela Sagrada de 7 Dias (order bump) | `vela_7dias` | R$ 14,90 |
| Aplicativo Espiritual (upsell) | `upsell` | R$ 47,00 |
| Aplicativo Essencial (downsell) | `downsell` | R$ 14,90 |

## Entrega dos produtos

Configure os links liberados após o pagamento no `.env.local`:

```
DELIVERY_URL_MAIN="https://..."
DELIVERY_URL_SALMOS_150="https://..."
DELIVERY_URL_VELA_7DIAS="https://..."
DELIVERY_URL_UPSELL="https://..."
DELIVERY_URL_DOWNSELL="https://..."
```

Sem esses valores o cliente vê "o link chegará no seu e-mail" e o servidor registra um aviso no log. **O envio de e-mail ainda não está implementado** — hoje a entrega acontece apenas na tela de conclusão.

---

## Armazenamento

Os pedidos são gravados em `.data/orders.json` (configurável via `DATA_DIR`), com escrita atômica e permissão `0600`. É suficiente para uma única instância.

O arquivo contém **CPF, nome, e-mail e telefone** dos clientes. A API nunca devolve o CPF completo — só a versão mascarada. Antes de escalar para mais de uma instância, migre para um banco de dados de verdade (o rate limit e o orçamento de consultas também são em memória/arquivo e assumem processo único), e trate esses dados conforme a LGPD: defina prazo de retenção e restrinja o acesso ao arquivo.

---

## O que ainda falta antes de vender de verdade

- [ ] **Envio de e-mail** com os acessos após a confirmação (hoje a tela promete o e-mail, mas nada é enviado)
- [ ] Preencher as `DELIVERY_URL_*` com os links reais dos produtos
- [ ] Página de política de privacidade e termos, com a base legal do tratamento do CPF
- [ ] Processo de reembolso — a garantia de 30 dias é prometida na copy
- [ ] Revisar as promessas da copy (depoimentos, "milhares de selecionados") frente ao CDC e às políticas de anúncio
