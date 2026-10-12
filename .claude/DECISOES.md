# Decisões — Rezas Sagradas

Cada linha aqui existe porque alguém, um dia, vai olhar o código e pensar "isso é
redundante, dá para simplificar". Está escrito o que quebra se simplificar.

Formato: **decisão** → por quê → o que acontece se desfizer.

---

## Dinheiro

**O status nunca vem do corpo do webhook, mesmo com a assinatura conferindo.**
Do corpo sai só o identificador da cobrança; o status vem de consulta nossa à API
autenticada. → Um POST forjado dizendo "completed" não libera produto nenhum. →
Se desfizer: o dia em que o segredo vazar, ou em que a PixGo mudar o esquema de
assinatura, qualquer pessoa na internet libera produto de graça.

**`PIX_MODE` tem padrão `live`.** → O modo mock confirma pagamento sozinho; cair
nele por variável ausente entregaria produto de graça. → Inverter o padrão "para
facilitar o teste" transforma um esquecimento de configuração em prejuízo.

**Comparação de status por igualdade exata, nunca `includes`.** → `includes`
transformaria `unpaid` em `paid`.

**Status desconhecido cai em `pending`.** → Inventar "pago" a partir de um nome
que não conhecemos entrega produto sem pagamento.

**MED é tratado como pendente, e o status bruto do gateway é guardado.** → MED é
análise de devolução, não devolução consumada: não pode revogar o acesso de quem
pagou nem liberar nada de quem não pagou. O bruto é guardado porque o nosso
mapeamento perde informação e o painel precisa mostrar que há análise em curso.

**Consultamos `/payment/{id}` e não `/payment/{id}/status`.** → O de status tem
teto dez vezes menor (1.000 contra 10.000 por 24 h) e devolve o mesmo campo.
Estourar o teto é parar de confirmar pagamento de quem já pagou. → Só foi seguro
porque o tratamento de `410 Gone` já existia: sem ele, todo pedido expirado
viraria falha e seria reconsultado para sempre.

**A consulta feita dentro do callback tem teto de 6 s, não 15 s.** → A PixGo
desiste do webhook em ~10 s e reenvia; resposta que chega tarde vira reentrega em
looping.

**Aceitamos assinatura feita com qualquer um dos dois segredos (`whsec_` e
`pk_`).** → As duas documentações da PixGo se contradizem sobre qual assina.
Escolher um e errar recusaria **todo** callback legítimo, e nenhuma venda se
confirmaria pelo webhook. Os dois são segredos que só nós e a PixGo conhecemos,
então bater com qualquer um prova a origem do mesmo jeito.

**Conferimos o tamanho dos buffers antes do `timingSafeEqual`.** → O exemplo em
Node da documentação deles não confere: `timingSafeEqual` lança quando os
tamanhos diferem, então uma assinatura truncada viraria exceção em vez de recusa.

**O preço só existe em `server/catalog.ts`.** → O navegador manda IDs; o servidor
recalcula. A lista em `InlineCheckout.tsx` é só exibição e precisa ser mantida em
sincronia.

**Upsell e downsell exigem o pedido principal confirmado e herdam os dados dele.**
→ Sem isso seria possível gerar as ofertas seguintes sem ter pago a Oração, e
haveria como trocar o titular no meio do funil.

**`applyStatus` recusa voltar de pago para pendente.** → Uma resposta atrasada do
gateway não pode tirar o acesso de quem já pagou.

---

## Infraestrutura

**Sem `DATABASE_URL`, a função da Vercel recusa as rotas de pagamento com 503.**
→ Sem Postgres o armazenamento cairia no arquivo local, que em serverless é
efêmero e não é compartilhado: o pedido criado numa instância sumiria antes de o
webhook chegar em outra — o cliente pagaria e nunca receberia. Recusar de forma
visível é melhor que aceitar dinheiro e perder o pedido.

**A preparação do banco não é um valor fixo do módulo; a falha é descartada.** →
O Neon hiberna, então a primeira conexão de uma instância nova pode falhar
enquanto ele acorda. Guardar essa falha envenenaria a instância: ela responderia
503 a todo mundo até a Vercel reciclá-la, e cada cliente que caísse nela perderia
a compra.

**Toda gravação é aguardada antes de responder, com timeout curto.** → Na Vercel a
função pode congelar assim que responde: promessa solta pode nunca executar.

**Todo o contato com o gateway vive em `server/pix.ts`.** → Já trocamos de
provedor uma vez (BitFlow → PixGo). O acoplamento estreito — `createPayment`,
`fetchPaymentStatus` e a classe de erro — é o que fez a troca custar um arquivo.

**O critério de descarte de evento no webhook é genérico.** → O filtro antigo
descartava tudo que não começasse com `cashin`, nomenclatura da BitFlow. Com um
provedor cujos eventos se chamem `payment.paid`, esse filtro jogaria fora todos os
avisos. Hoje: se o identificador não bate com pedido nosso, ignoramos — evento de
saque cai nesse caso sozinho.

---

## Telas

**O relógio do botão de compra começa na montagem da etapa da VSL, e não é
guardado no `sessionStorage`.** → Já foi guardado, para sobreviver a
recarregamento. Na prática atrapalhava: o passo do funil não é persistido, então
quem recarrega volta para a primeira tela e refaz o quiz inteiro — com o relógio
velho correndo. Ao chegar de novo na VSL, os 4min20 já tinham passado e o botão
aparecia antes de o vídeo dizer o preço, que é exatamente o que a espera existe
para impedir. → Se desfizer: volta esse defeito. O problema original (celular que
recarrega a aba ao trocar de app) continua existindo, mas esse cliente cai na
primeira tela de qualquer jeito.

**A espera é conferida contra o horário de início, não confiada a um `setTimeout`
só.** → Aba em segundo plano tem timer atrasado ou suspenso; conferindo o
horário, ao voltar para a aba o botão aparece na hora se o tempo real já passou.

**A espera conta tempo de tela, não progresso do vídeo.** → Amarrar ao vídeo
deixaria o botão fora do alcance de quem só quer comprar; e quem pausa no meio já
esperou o tempo de qualquer forma.

**Os atributos do player da Wistia ficam no código, não no painel deles.** → O
funil depende deles: mexer no painel mudaria a página sem passar por commit. São
strings (`autoplay="false"`) e não booleanos, porque atributo booleano de HTML é
verdadeiro só por existir — `autoplay={false}` viraria autoplay presente.

**O vídeo começa parado, com o play grande.** → Com autoplay mudo e "clique para
ouvir", o único controle era um alto-falante pequeno no canto: a pessoa procurava
um play, não achava, e saía achando que o vídeo tinha quebrado.

**A ida para `/obg` acontece no fim do checkout, não na confirmação do PIX
principal.** → Sair antes passaria por cima do upsell e do downsell e apagaria
essa receita. A `/obg` repete os acessos porque, trocando de página, o cliente
perderia a tela que lista o que comprou.

**Campos de formulário com 16 px.** → Abaixo disso o Safari do iPhone dá zoom
sozinho ao focar e a tela salta — com o cliente já decidido a comprar.

**`?tela=` e `?cta=` só valem para quem digita a URL.** → Cuidado com o ausente:
`get()` devolve `null` e `Number(null)` é `0`, não `NaN`. Foi exatamente assim que
o botão de compra passou a aparecer na hora para 100% dos clientes.

---

## Rastreamento (Meta)

**A compra é enviada pelo SERVIDOR, não pelo navegador.** → No PIX o cliente sai
do site para pagar no app do banco e boa parte não volta. Se o `Purchase`
dependesse do navegador, o Meta perderia justamente as vendas concluídas — e o
robô aprenderia a entregar para quem clica, não para quem paga.

**`POST /api/track` não aceita `Purchase` nem valor em dinheiro.** → A rota é
pública. Aceitar compra ali seria publicar um endereço onde qualquer pessoa
declara faturamento que não existiu. Valor sai só de `server/catalog.ts`.

**O `event_id` da compra é determinístico (`purchase_<pedido>_<oferta>`).** → O
webhook da PixGo é reentregue por desenho. Com identificador aleatório, cada
reentrega viraria uma venda a mais no relatório e o robô miraria no público
errado achando que converte o dobro. Há ainda a trava nossa: `reservarEnvioMeta`
usa o `event_id` como chave primária, então duas instâncias processando a mesma
reentrega não mandam dois eventos.

**O `Purchase` sai de dentro de `applyStatus`, e só de lá.** → Webhook e
reconciliação confirmam pagamento; chamar nos dois lugares é como se cria uma
venda contada duas vezes.

**O envio dentro do webhook tem orçamento de ~2,5 s, sem a escada completa de
retentativas.** → A PixGo desiste em ~10 s e reenvia, e a consulta de status já
consome até 6 s. Segurar o callback esperando o Facebook provocaria reentrega em
looping. O que não couber fica registrado como pendente e é reenviado pelo botão
da aba Anúncios, aí sim com o orçamento cheio.

**O carimbo do anúncio é gravado no PEDIDO, não na sessão.** → A confirmação
chega horas depois, sem navegador aberto. Sem isso a venda confirmada não saberia
de qual anúncio veio — que é a única pergunta que decide onde colocar dinheiro.
Upsell e downsell herdam o carimbo do pedido principal, como já herdam o cliente.

**O `_fbc` é montado à mão quando o cookie não existe.** → Formato fixo do Meta:
`fb.1.<ms>.<fbclid>`. Um bloqueador que atrase o script do Pixel deixaria o
evento sem o campo que liga a compra ao clique exato, e a correspondência
despenca.

**Visita direta não apaga a origem paga; clique pago novo sobrescreve.** → Quem
volta digitando o endereço, ou por um link do WhatsApp, continua creditado ao
anúncio que o trouxe. Apagar transformaria venda de anúncio em "sem origem".

**IP, user agent, `fbp` e `fbc` vão em texto puro; o resto vai em SHA-256.** →
Exigência do Meta. Hashear esses quatro os torna inúteis e derruba a nota de
correspondência sem nenhum erro aparecer.

**O telefone leva `55` na frente antes do hash.** → O checkout guarda
"11988887777". Sem o código do país o hash não bate com o cadastro de ninguém, e
o campo passa a não valer nada.

**O `PageView` não sai do carregador do Pixel.** → O código de exemplo do Meta
dispara sem `eventID`, e o nosso servidor manda o mesmo `PageView` com
identificador: sem o par, a mesma visita contaria duas vezes.

**A origem fica no JSON do pedido, não em vinte colunas novas na tabela.** → A
tabela `orders` já guarda o pedido inteiro em JSONB, e as colunas soltas existem
só para indexar busca. Espelhar o carimbo em colunas duplicaria o dado e criaria
a chance de os dois lados discordarem. O que precisa de agregação rápida —
`eventos_funil` — esse sim é tabela com colunas e índices próprios.

**A leitura de dinheiro da planilha trata "1.234" como milhar, não como
decimal.** → Só quando o texto inteiro tem a forma clássica de agrupamento
(`1.234`, `12.345.678`); qualquer outro ponto é decimal. Errar aqui não gera
erro nenhum: gera um número plausível mil vezes maior ou menor, e um anúncio
lucrativo passa a parecer prejuízo. É a função mais testada do importador.

**O importador só aceita planilha do Google.** → Quem digita a URL é o dono
autenticado, mas quem faz a requisição é o servidor. Sem a trava de host, o
painel seria uma porta para sondar a rede interna onde ele roda (`localhost`,
metadados da nuvem). O `INVESTIMENTO_HOSTS_EXTRA` existe só para a bateria de
teste apontar a um CSV local, e é vazio em produção.

**Campanha com investimento e zero visita continua aparecendo na aba Anúncios.**
→ O filtro exigia tráfego, e escondia justamente o pior caso: dinheiro gasto que
não trouxe ninguém. O dono olharia a tabela, não veria a campanha, e concluiria
que não gastou.

**Linha ruim da planilha é relatada, não engolida.** → Importação silenciosa que
descarta linha mostra gasto menor do que foi, e o ROAS sai bom por engano.

**`META_TRACKING_ENABLED` desligado, ou credencial faltando, é um "não faz
nada".** → Ao contrário do `PIX_MODE`, cujo padrão é `live`: aqui o erro caro
seria mandar evento para o pixel errado ou tentar falar com o Meta sem token a
cada pagamento, não deixar de mandar.

---

## Prova social no checkout — nomes fictícios

**Os avisos de "Fulana está finalizando a oração agora" NÃO são vendas reais.**
→ São nomes de uma lista fixa, girando em laço. Decisão do dono em 08/08/2026,
tomada depois de ver por escrito que anunciar compra que não aconteceu é
publicidade enganosa pelo CDC e motivo declarado de bloqueio de conta nas
políticas do Meta. Fica registrado para ninguém achar depois que foi descuido.

**O caminho honesto existe e é barato.** → `server/orders.ts` já guarda as vendas
confirmadas; uma rota pública com nome abreviado, cidade e tempo daria o mesmo
efeito com dado verdadeiro. Hoje mostraria pouco, porque ainda não houve venda
por anúncio — foi esse o motivo de não ser escolhido. Quando houver volume, é
uma troca de uma tarde, e `src/components/ProvaSocial.tsx` sai inteiro.

**O aviso não pode cobrir campo do formulário.** → Fica no canto inferior
esquerdo, com largura limitada, e o container é `pointer-events-none` — só o X
recebe clique. Prova social que atrapalha o preenchimento troca persuasão por
venda perdida, e no celular a área de um aviso mal posicionado cobre justamente
o campo em foco.

**O X desliga de vez, na sessão.** → Quem se incomoda com o aviso se incomoda
mais ainda se ele voltar. Insistir depois do "não" é o que transforma prova
social em irritação.

---

## Configuração Core do Meta e dado sensível

**A URL do evento sai sem query string.** → A "Configuração Core" do Meta corta
tudo depois do domínio quando está ativa, então mandar a query só aumenta o que
trafega para ser descartado do outro lado. E nada se perde: a atribuição do Meta
vem do `fbc`/`fbclid` dentro de `user_data`, nunca da URL.

**O motivo mais forte não é técnico.** → Este funil é devocional, e crença
religiosa é dado sensível nos Termos das Ferramentas Comerciais. A query
carregava `fb_campaign_id`, `utm_campaign` e o que mais estivesse na barra do
navegador, tudo junto do identificador de uma pessoa. Quanto menos texto livre
nosso viajar ali, menor a chance de a fonte de dados cair numa categoria
restrita — e cair nela degrada a medição inteira, não só um campo.

**Não usamos nenhum parâmetro personalizado, e isso é sorte que vale manter.** →
A Core Setup bloqueia parâmetros fora da lista padrão do Meta. Tudo que enviamos
já é padrão: `currency`, `value`, `content_ids`, `content_type`, `num_items`,
`order_id`. Antes de acrescentar qualquer campo novo ao evento, confira se ele
está na lista padrão — um campo personalizado a mais pode ser o que muda a
categoria da fonte de dados.

**A correspondência avançada é manual, e por isso sobrevive.** → A Core Setup
pode desligar a correspondência avançada *automática*. A nossa é manual: os
hashes de e-mail, telefone e nome saem do servidor pela API de Conversões. Nada
a fazer se a restrição for aplicada.

**`content_ids` continua com os IDs reais (`salmos_150`, `vela_7dias`).** → São
parâmetros padrão e alimentam catálogo e otimização por produto. O risco
declarado: eles associam uma pessoa a uma prática religiosa. Trocar por IDs
opacos (`p1`, `p2`) reduziria esse risco e custaria a leitura do relatório do
Meta por produto. Decisão do dono, ainda em aberto.

---

## Credenciais do Meta editáveis pelo painel

**O que está salvo no painel vence a variável de ambiente, campo a campo.** → A
ordem contrária seria a que surpreende: o dono digita, aperta salvar, vê "salvo"
e nada muda. Quem preenche o painel está olhando para a tela naquele instante;
quem preencheu a variável fez isso num deploy passado.

**O Pixel também é entregue por `GET /api/rastreamento/pixel`.** → O
`VITE_META_PIXEL_ID` é embutido no bundle em tempo de **build**, então trocá-lo
exige deploy — e o dono não faz deploy. Sem essa rota, "configurável pelo painel"
valeria só para o servidor e o navegador continuaria com o Pixel antigo.

**Evento disparado antes de o Pixel subir entra numa fila.** → A resposta da rota
chega depois do primeiro `PageView`. Sem fila, toda sessão perderia justamente o
evento que faz o Meta reconhecer o visitante — e o prejuízo seria invisível,
porque o gêmeo do servidor continuaria chegando.

**O token é guardado cifrado com AES-256-GCM, chave derivada da
`PAINEL_CHAVE_MESTRA`.** → O vazamento realista é um dump do banco, e a chave
mestra não está no banco. Efeito colateral aceito: trocar a chave mestra torna o
token ilegível — o sistema cai para a variável de ambiente, avisa na tela e pede
de novo, em vez de parar de rastrear em silêncio.

**Sem `PAINEL_CHAVE_MESTRA`, o painel recusa guardar o token.** → A alternativa
seria gravar em texto puro, e um token da API de Conversões dá acesso de escrita
ao conjunto de dados da conta de anúncio.

**Campo de token vazio mantém o token salvo; só a palavra `apagar` remove.** → A
tela mostra apenas a máscara, então vazio é o estado normal de quem abriu para
mudar o Pixel. Se vazio apagasse, o rastreamento morreria calado no meio de uma
campanha.

**O token nunca volta inteiro do servidor, nem para o dono logado.** → A tela não
precisa dele para funcionar, e o que trafega acaba em cache de navegador, log de
proxy e print de tela.

**O botão "Testar conexão" manda `data: []`.** → O Meta valida autenticação e
conjunto de dados, responde `events_received: 0` e não registra nada. Testar com
um evento de mentira envenenaria a otimização de uma conta de produção — não
existe ambiente de homologação aqui, igual à PixGo.

**As credenciais ficam em cache por 30 s em cada instância.** → Sem cache, cada
evento do funil viraria três consultas ao Postgres. Salvar pelo painel invalida
o cache da instância que atendeu; as outras alcançam no vencimento.

**O ID do Pixel é validado como 8 a 20 dígitos.** → Pega o erro mais comum de
todos: colar o ID da conta de anúncio (`act_…`) no lugar do conjunto de dados. Os
dois números convivem na mesma tela do Meta, e com o errado todo envio falha em
silêncio.

---

## Testes

**O Playwright não é dependência do projeto.** → Ele baixa um Chromium inteiro na
instalação e isso pesaria em todo build da Vercel, para testes que rodam à mão.
Por isso `PLAYWRIGHT_DIR` aponta para uma instalação fora do repositório.

**`testar-pixgo.mjs` roda o servidor a partir de uma pasta vazia.** →
`server/config.ts` carrega o `.env.local` do diretório atual com `override:true`,
então o arquivo ganha das variáveis passadas ao processo filho: rodando na raiz, o
teste apontaria para a PixGo **de verdade** e criaria cobrança real achando que
falava com o dublê.

**O teste para se a porta já estiver ocupada.** → Sobra de execução anterior
responde no lugar do servidor do teste — e no Windows sobra com facilidade, porque
matar o processo deixa o filho vivo.

**Todo teste de tela precisa provar que a etapa renderizou antes de medir.** → O
de responsividade já aprovou o funil inteiro enquanto a página estava quebrada por
erro de sintaxe: sem render não há botão pequeno nem estouro, então tudo
"passava".

**Ambiente local não fala com o Meta real, mesmo com token válido no `.env.local`.**
→ Em 14/08 e 15/08/2026 apareceram no `/{pixel}/stats` compras que produção nunca
enviou (com `external_id`, que só o nosso servidor manda, e sem linha em
`eventos_meta`): eram testes locais com `PIX_MODE=mock`, que confirma sozinho e
disparava `Purchase` no pixel de PRODUÇÃO — o robô aprendeu com venda que não
existiu. `server/metaCredenciais.ts` agora desliga o envio quando (modo mock OU
sem `DATABASE_URL`) E a base é `graph.facebook.com` E não há código de teste. O
código de teste (`META_TEST_EVENT_CODE`, aba "Testar eventos") é a saída
legítima: evento com ele não vira conversão. A bateria de testes usa
`META_BASE_URL` local e não é afetada. Se um dia isso parecer "redundância" com
`META_TRACKING_ENABLED=false` no `.env.local`: o `.env.local` já esteve `true`
por dias e ninguém notou; a trava no código é a que não depende de lembrar.
