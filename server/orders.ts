import { config } from './config.js';
import { logger } from './logger.js';
import { CATALOG, resolveOffer, type OfferId } from './catalog.js';
import { getDeliverables, type DeliverableContent } from './delivery.js';
import { enviarEmailDeAcesso } from './email.js';
import { repositorioDoPainel } from './painel/repositorio.js';
import { calcularVencimento, consultarStatusBoleto, criarBoleto } from './boleto.js';
import { CODIGO_COBRANCA_SUMIU, PixGatewayError, createPayment, fetchPaymentStatus } from './pix.js';
import { nomeDoRecebedorPix } from './brcode.js';
import { avisarVendaAprovada, avisarVendaPendente } from './discord.js';
import { registrarConversao } from './mensuracao.js';
import { enviarPedidoParaUtmify } from './utmify.js';
import type { Atribuicao } from './atribuicao.js';
import {
  findReusableOrder,
  getOrder,
  listChildOrders,
  saveOrder,
  tryConsumeStatusPoll,
  TERMINAL_STATUSES,
  type MetodoPagamento,
  type Order,
  type OrderCustomer,
  type OrderStatus,
} from './store/index.js';
import { centsToAmount, formatBRL, maskDocument, newId } from './utils.js';
import { ValidationError } from './validation.js';

/** Margem após o vencimento antes de considerarmos a cobrança expirada localmente. */
const EXPIRY_GRACE_MS = 5 * 60_000;

export interface PublicOrder {
  id: string;
  offer: OfferId;
  status: OrderStatus;
  amount: number;
  amountFormatted: string;
  items: { id: string; title: string; amount: number; amountFormatted: string }[];
  /**
   * Como este pedido está sendo pago. Vai ao navegador porque é ele que decide
   * qual painel mostrar — o do QR ou o da linha digitável.
   */
  metodo: MetodoPagamento;
  pix: { code: string; imageUrl: string | null; expiresAt: string | null; recebedor: string | null } | null;
  /** Só existe em pedido de boleto. Ver server/boleto.ts. */
  boleto: { linhaDigitavel: string; linhaDigitavelCrua: string; urlPdf: string | null; vencimento: string } | null;
  paidAt: string | null;
  parentOrderId: string | null;
  customer: { name: string; email: string; documentMasked: string };
  createdAt: string;
  /**
   * Identificador do evento de compra já enviado ao Meta pelo servidor. Só
   * existe depois do pagamento confirmado.
   *
   * A /obg usa este valor para disparar o Purchase do Pixel com o MESMO
   * identificador — é o que faz o Meta entender que é a mesma venda. Sem ele,
   * a página não dispara nada: contar a mesma compra duas vezes envenena a
   * otimização mais do que não contar.
   */
  purchaseEventId: string | null;
}

/*
 * A leitura do BR Code mora em server/brcode.ts.
 *
 * Saiu daqui porque o aviso do Discord passou a precisar dela, e `orders.ts` já
 * importa `discord.ts` para avisar a venda — deixar as funções aqui faria os
 * dois se importarem em círculo. Reexportado para quem já dependia do nome.
 */
export { nomeDoRecebedorPix };

export function toPublicOrder(order: Order): PublicOrder {
  return {
    id: order.id,
    offer: order.offer,
    status: order.status,
    amount: centsToAmount(order.amountCents),
    amountFormatted: formatBRL(order.amountCents),
    items: order.itemIds.map((itemId) => {
      const item = CATALOG[itemId];
      return {
        id: itemId,
        title: item?.title ?? itemId,
        amount: centsToAmount(item?.priceCents ?? 0),
        amountFormatted: formatBRL(item?.priceCents ?? 0),
      };
    }),
    // Pedido gravado antes de 17/08/2026 não tem o campo, e ausência significa
    // PIX — era a única forma de pagar quando ele nasceu.
    metodo: order.metodo ?? 'pix',
    boleto: order.boleto ?? null,
    pix: order.qrCode
      ? {
        code: order.qrCode,
        imageUrl: order.qrImageUrl,
        expiresAt: order.expiresAt,
        /*
         * O nome que o BANCO DO CLIENTE vai mostrar na confirmação.
         *
         * A PixGo liquida por conta intermediária, e em 14/08/2026 o campo 59
         * do código dizia "PRIME UNION TRADING FIN" — uma financeira que o
         * cliente nunca ouviu falar, na tela em que ele decide se confia. Um
         * comprador relatou o banco marcando a transação como SUSPEITA, duas
         * vezes, e desistiu. A tela do PIX usa este campo para avisar ANTES,
         * transformando o susto em coisa esperada. Extraído do próprio código
         * a cada resposta: se o gateway trocar a liquidante, o aviso muda
         * sozinho.
         */
        recebedor: nomeDoRecebedorPix(order.qrCode),
      }
      : null,
    paidAt: order.paidAt,
    parentOrderId: order.parentOrderId,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      documentMasked: maskDocument(order.customer.document),
    },
    createdAt: order.createdAt,
    purchaseEventId: order.status === 'completed' ? (order.purchaseEventId ?? null) : null,
  };
}

export interface CreateOrderInput {
  offer: OfferId;
  bumpIds: string[];
  /** Ausente = PIX, que continua sendo o caminho padrão do funil. */
  metodo?: MetodoPagamento;
  /** Acréscimo voluntário escolhido pela pessoa. Ver CONTRIBUICOES_EXTRA. */
  contribuicaoId?: string | null;
  customer?: OrderCustomer;
  parentOrderId?: string | null;
  clientIp?: string | null;
  /** Carimbo do anúncio, enviado pelo navegador. Ver server/atribuicao.ts. */
  atribuicao?: Atribuicao | null;
  sessionId?: string | null;
  /** User-Agent cru, exigido pela API de Conversões para casar o evento. */
  userAgent?: string | null;
}

export async function createOrder(input: CreateOrderInput): Promise<{ order: Order; reused: boolean }> {
  let parentOrder: Order | undefined;

  if (input.parentOrderId) {
    parentOrder = await getOrder(input.parentOrderId);
    if (!parentOrder) {
      throw new ValidationError('Pedido principal não encontrado.', { field: 'parentOrderId', code: 'PARENT_NOT_FOUND' });
    }
  }

  // Upsell e downsell herdam os dados do pedido principal: o cliente não
  // reenvia CPF/e-mail, então não há como trocar o titular no meio do funil.
  const customer = parentOrder ? parentOrder.customer : input.customer;
  if (!customer) {
    throw new ValidationError('Os dados do cliente são obrigatórios.', { field: 'customer' });
  }

  /*
   * Upsell e downsell dependem de uma compra anterior; `main` e `recuperacao`
   * não. A regra era "tudo que não for main precisa de pai", e ela passou a
   * barrar a campanha de recuperação — que é uma venda inteira, com a Oração
   * dentro, e não um acréscimo a um pedido existente. A lista é explícita para
   * a próxima oferta que nascer não herdar a restrição por descuido.
   */
  const exigeParent = input.offer === 'upsell' || input.offer === 'downsell';
  if (exigeParent && !parentOrder) {
    throw new ValidationError('As ofertas de upsell e downsell exigem o pedido principal.', {
      field: 'parentOrderId',
      code: 'PARENT_REQUIRED',
    });
  }

  // Upsell e downsell só existem depois da compra principal confirmada: sem esta
  // checagem seria possível gerar as ofertas seguintes sem ter pago a Oração.
  if (parentOrder && parentOrder.status !== 'completed') {
    throw new ValidationError('O pagamento da Oração principal ainda não foi confirmado.', {
      field: 'parentOrderId',
      code: 'PARENT_NOT_PAID',
    });
  }

  const resolved = resolveOffer(input.offer, input.bumpIds, input.contribuicaoId);
  const metodo: MetodoPagamento = input.metodo ?? 'pix';

  if (metodo === 'boleto') {
    if (!config.boleto.disponivel) {
      throw new ValidationError(
        'O pagamento por boleto ainda não está disponível. Use o PIX — a liberação é imediata.',
        { field: 'metodo', code: 'BOLETO_INDISPONIVEL' },
      );
    }

    /*
     * Boleto só na compra que nasce do formulário.
     *
     * O upsell e o downsell só aparecem DEPOIS do pagamento confirmado, dentro
     * da mesma visita — é o desenho do funil. Um boleto ali seria oferecido a
     * quem está com o cartão na mão e cobrado três dias depois, quando a pessoa
     * já esqueceu o que comprou. Some-se que a Versão Essencial custa R$ 19,00,
     * abaixo do piso em que a tarifa de emissão ainda faz sentido.
     */
    if (input.offer !== 'main' && input.offer !== 'recuperacao') {
      throw new ValidationError('Esta oferta só pode ser paga por PIX.', {
        field: 'metodo',
        code: 'BOLETO_NAO_DISPONIVEL_NESTA_OFERTA',
      });
    }

    if (resolved.amountCents < config.boleto.minAmountCents) {
      throw new ValidationError(
        `Para valores abaixo de ${formatBRL(config.boleto.minAmountCents)} o pagamento é só por PIX.`,
        { field: 'metodo', code: 'BOLETO_ABAIXO_DO_MINIMO' },
      );
    }
  }

  if (resolved.amountCents < config.pix.minAmountCents) {
    throw new ValidationError(
      `O valor ${formatBRL(resolved.amountCents)} está abaixo do mínimo de ${formatBRL(config.pix.minAmountCents)} aceito para cobrança.`,
      { code: 'AMOUNT_BELOW_MINIMUM' },
    );
  }
  if (resolved.amountCents > config.pix.maxAmountCents) {
    throw new ValidationError(
      `O valor ${formatBRL(resolved.amountCents)} excede o limite de ${formatBRL(config.pix.maxAmountCents)} por cobrança.`,
      { code: 'AMOUNT_ABOVE_LIMIT' },
    );
  }

  const reusable = await findReusableOrder({
    offer: resolved.offer,
    amountCents: resolved.amountCents,
    document: customer.document,
    itemIds: resolved.itemIds,
    metodo,
  });
  if (reusable) {
    logger.info('Cobrança pendente reaproveitada', { orderId: reusable.id, offer: resolved.offer });
    return { order: reusable, reused: true };
  }

  const orderId = newId();
  // Sem URL no payload, o gateway costuma cair na URL fixa cadastrada no painel
  // dele; não havendo nenhuma, alguns recusam a cobrança. Confira o que o
  // provedor novo espera.
  const webhookUrl = config.publicBaseUrl.startsWith('https://')
    ? `${config.publicBaseUrl}/api/webhooks/pix`
    : undefined;

  /*
   * A emissão. É o único trecho em que os dois métodos divergem de verdade:
   * daqui para baixo o pedido segue idêntico, e é isso que faz a confirmação,
   * a entrega, o e-mail e o painel funcionarem para boleto sem saber que ele
   * existe.
   */
  const emissao = metodo === 'boleto'
    ? await emitirBoletoDoPedido(orderId, resolved, customer, webhookUrl)
    : await emitirPixDoPedido(orderId, resolved, customer, webhookUrl);

  const now = new Date().toISOString();
  const order: Order = {
    id: orderId,
    createdAt: now,
    updatedAt: now,
    offer: resolved.offer,
    itemIds: resolved.itemIds,
    amountCents: resolved.amountCents,
    status: emissao.status,
    customer,
    parentOrderId: parentOrder?.id ?? null,
    paymentId: emissao.paymentId,
    statusGateway: emissao.statusBruto,
    adquirente: emissao.adquirente ?? null,
    metodo,
    qrCode: emissao.qrCode,
    qrImageUrl: emissao.qrImageUrl,
    expiresAt: emissao.expiresAt,
    boleto: emissao.boleto,
    paidAt: emissao.status === 'completed' ? now : null,
    lastStatusCheckAt: Date.now(),
    processedWebhooks: [],
    clientIp: input.clientIp ?? null,
    /*
     * Upsell e downsell herdam o carimbo do pedido principal, como já herdam os
     * dados do cliente. Eles nascem de um clique dentro do checkout, quando a
     * URL do anúncio ficou para trás há muito tempo — sem herdar, essa receita
     * apareceria como "sem origem" e o anúncio que a gerou pareceria pior do
     * que é.
     */
    atribuicao: parentOrder?.atribuicao ?? input.atribuicao ?? null,
    trackId: parentOrder?.trackId ?? input.sessionId ?? null,
    clientUserAgent: input.userAgent ?? parentOrder?.clientUserAgent ?? null,
    purchaseEventId: null,
  };

  await saveOrder(order);
  logger.info('Cobrança criada', {
    orderId,
    metodo,
    paymentId: emissao.paymentId,
    offer: resolved.offer,
    amount: formatBRL(resolved.amountCents),
    webhook: Boolean(webhookUrl),
  });

  /*
   * Aviso de PIX gerado, DEPOIS de o pedido estar gravado.
   *
   * A ordem importa: o que o cliente precisa é da cobrança existir; o aviso é
   * consequência. E é aguardado, não solto — na Vercel a função pode congelar
   * assim que responde, e uma promessa solta simplesmente não executaria
   * (regra 8). Engole o próprio erro: Discord fora do ar não pode impedir
   * ninguém de pagar.
   */
  await avisarVendaPendente(order);

  /*
   * O pedido no painel da Utmify, ainda como `waiting_payment`.
   *
   * Mandado JA na criacao, e nao so quando paga: e assim que o relatorio deles
   * mostra a taxa de conversao de PIX gerado -> pago. Mandando so o pago, todo
   * PIX abandonado seria invisivel e a taxa apareceria como 100%.
   *
   * Aguardado pelo mesmo motivo do aviso acima (regra 8), e engole o proprio
   * erro: painel de relatorio fora do ar nao pode impedir ninguem de pagar.
   */
  await enviarPedidoParaUtmify(order);

  return { order, reused: false };
}

/**
 * O resultado da emissão, no formato que o pedido guarda — o mesmo para os dois
 * métodos, com os campos do outro em branco.
 */
interface EmissaoDeCobranca {
  paymentId: string;
  status: OrderStatus;
  statusBruto: string;
  /** Quem liquidou, quando o gateway informa. Ausente na maioria das respostas. */
  adquirente?: string | null;
  qrCode: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  boleto: Order['boleto'];
}

async function emitirPixDoPedido(
  orderId: string,
  resolved: { amountCents: number; description: string },
  customer: OrderCustomer,
  webhookUrl: string | undefined,
): Promise<EmissaoDeCobranca> {
  const charge = await createPayment({
    amountCents: resolved.amountCents,
    description: resolved.description,
    externalId: orderId,
    customer,
    webhookUrl,
  });

  return {
    paymentId: charge.paymentId,
    status: charge.status,
    statusBruto: charge.statusBruto,
    adquirente: charge.adquirente ?? null,
    qrCode: charge.qrCode,
    qrImageUrl: charge.qrImageUrl,
    expiresAt: charge.expiresAt,
    boleto: null,
  };
}

/**
 * Quanto tempo o pedido continua sendo consultado DEPOIS do vencimento.
 *
 * Boleto pago no último dia ainda leva de 1 a 3 dias úteis para compensar, e
 * quem para de perguntar no dia do vencimento nunca fica sabendo desse
 * pagamento: o pedido morre pendente e o cliente pagou sem receber nada. Cinco
 * dias corridos cobrem o pior caso (vencimento numa sexta) com folga.
 *
 * O outro lado importa igual: sem NENHUM prazo, um boleto que ninguém pagou
 * seria consultado a cada 25 segundos para sempre, queimando o orçamento diário
 * de consultas que existe para confirmar quem pagou de verdade.
 */
const FOLGA_DE_COMPENSACAO_MS = 5 * 24 * 60 * 60_000;

async function emitirBoletoDoPedido(
  orderId: string,
  resolved: { amountCents: number; description: string },
  customer: OrderCustomer,
  webhookUrl: string | undefined,
): Promise<EmissaoDeCobranca> {
  const vencimento = calcularVencimento(config.boleto.diasParaVencer);
  const charge = await criarBoleto({
    amountCents: resolved.amountCents,
    description: resolved.description,
    externalId: orderId,
    customer,
    vencimento,
    webhookUrl,
  });

  return {
    paymentId: charge.paymentId,
    status: charge.status,
    statusBruto: charge.statusBruto,
    qrCode: null,
    qrImageUrl: null,
    /*
     * `expiresAt` NÃO é o vencimento: é quando paramos de perguntar. A data que
     * o cliente vê é `boleto.vencimento`, e as duas precisam ser diferentes
     * pelo motivo explicado em FOLGA_DE_COMPENSACAO_MS.
     */
    expiresAt: new Date(Date.parse(charge.boleto.vencimento) + FOLGA_DE_COMPENSACAO_MS).toISOString(),
    boleto: charge.boleto,
  };
}

export async function applyStatus(
  order: Order,
  status: OrderStatus,
  source: 'webhook' | 'polling' | 'local' | 'manual',
): Promise<Order> {
  if (order.status === status) return order;

  // Um pedido pago não volta a ficar pendente por uma resposta atrasada.
  if (TERMINAL_STATUSES.has(order.status) && status === 'pending') return order;
  if (order.status === 'completed' && status !== 'refunded') return order;

  const previous = order.status;
  order.status = status;
  if (status === 'completed' && !order.paidAt) {
    order.paidAt = new Date().toISOString();
  }
  await saveOrder(order);

  logger.info('Status do pedido atualizado', { orderId: order.id, de: previous, para: status, origem: source });

  /*
   * Ponto ÚNICO em que uma venda vira conversão registrada.
   *
   * Fica aqui, e não no webhook e na reconciliação separadamente, porque as
   * duas confirmam pagamento: duplicar nos dois lugares é como se cria uma
   * venda contada duas vezes. E fica DEPOIS do saveOrder de propósito — o que
   * importa para o cliente é o pedido estar gravado como pago; o resto é
   * consequência.
   *
   * ATÉ 21/08/2026 este bloco também mandava a compra ao Meta pela API de
   * Conversões. Não manda mais: a conversão é registrada no NOSSO banco
   * (`registrarConversao`, logo abaixo) e sai daí por exportação.
   */
  if (status === 'completed') {
    /*
     * O aviso vem ANTES do Meta e do e-mail de propósito.
     *
     * É o mais barato dos três (uma requisição, orçamento de 2,5 s) e o único
     * que uma pessoa está esperando ver agora. Os outros dois têm rede de
     * segurança — pendência reenviável pelo painel; este não tem, então é o que
     * menos pode ficar para trás quando o orçamento do callback aperta.
     */
    await avisarVendaAprovada(order);

    /*
     * A MESMA cobranca, agora como `paid`. A Utmify casa pelo `orderId`, entao
     * este envio atualiza a linha que nasceu na criacao em vez de criar outra.
     */
    await enviarPedidoParaUtmify(order);

    /*
     * A CONVERSÃO INTERNA. É a linha que substitui o antigo envio ao Meta.
     *
     * Nasce SÓ aqui, que é o único ponto do sistema em que um pedido vira
     * `completed` — e `applyStatus` já recusou, acima, qualquer caminho que
     * traria um pedido pago de volta para pendente. QR criado, PIX copiado ou
     * checkout aberto não passam por aqui e portanto não viram conversão.
     *
     * Aguardado (regra 8: na Vercel promessa solta não executa) e engolindo o
     * próprio erro (regra 11: mensuração não derruba venda). Se falhar, o
     * pedido continua pago e entregue — falta uma linha num relatório, e a
     * varredura de reconciliação passa por aqui de novo.
     */
    await registrarConversao(order);

    /*
     * E-mail com os acessos. Mesma disciplina do envio ao Meta: aguardado com
     * orçamento curto, engolindo o próprio erro.
     *
     * A guarda de `accessEmailSentAt` é o que impede a reentrega do webhook —
     * que a PixGo faz por desenho — de mandar a mesma mensagem quatro vezes.
     * Cliente que recebe quatro cópias da mesma compra não pensa "que sistema
     * caprichado": pensa que foi cobrado quatro vezes, e pede reembolso.
     *
     * O carimbo só é gravado quando o provedor confirma. Falhou, fica sem
     * carimbo e o painel pode reenviar — melhor um e-mail repetido do que um
     * cliente sem o produto que pagou.
     */
    if (!order.accessEmailSentAt) {
      const envio = await enviarEmailDeAcesso(order);
      if (envio.enviado) {
        order.accessEmailSentAt = new Date().toISOString();
        await saveOrder(order);
      }
      await repositorioDoPainel()
        .registrarEvento({
          pedidoId: order.id,
          evento: envio.enviado ? 'email_enviado' : 'email_falhou',
          origem: source,
          detalhe: envio.motivo ?? order.customer.email,
        })
        .catch(() => {
          /* auditoria é acessória: nunca pode derrubar a confirmação do pagamento */
        });
    }
  }

  return order;
}

/**
 * Sincroniza o status com o gateway sem martelar a API: uma consulta por pedido
 * a cada `minIntervalMs`, dentro de um teto diário. O callback continua sendo o
 * caminho principal de confirmação.
 */
export async function reconcileOrder(
  order: Order,
  options: { ignorarIntervalo?: boolean } = {},
): Promise<Order> {
  if (TERMINAL_STATUSES.has(order.status) || !order.paymentId) return order;

  const now = Date.now();
  const sinceLastCheck = now - (order.lastStatusCheckAt ?? 0);
  // O botão "Verificar pendentes" do painel é um pedido humano e explícito, por
  // isso pula o intervalo. O teto diário de consultas continua valendo.
  if (!options.ignorarIntervalo && sinceLastCheck < config.polling.minIntervalMs) return order;

  const pastGracePeriod = order.expiresAt ? now > Date.parse(order.expiresAt) + EXPIRY_GRACE_MS : false;

  if (!(await tryConsumeStatusPoll())) {
    logger.warn('Orçamento diário de consultas ao gateway esgotado; aguardando o callback', { orderId: order.id });
    return order;
  }

  order.lastStatusCheckAt = now;

  try {
    // Quem emitiu é quem sabe do pagamento: boleto não é consultado no gateway
    // de PIX, que nunca ouviu falar desta cobrança.
    const result = order.metodo === 'boleto'
      ? await consultarStatusBoleto(order.paymentId)
      : await fetchPaymentStatus(order.paymentId);
    // Guardado mesmo quando o status normalizado não muda: MED vira "pendente"
    // no nosso modelo, e sem isto o painel nunca saberia da análise.
    order.statusGateway = result.statusBruto;
    const updated = await applyStatus(order, result.status, 'polling');

    if (updated.status === 'pending' && pastGracePeriod) {
      return await applyStatus(updated, 'expired', 'local');
    }
    await saveOrder(updated);
    return updated;
  } catch (error) {
    const message = error instanceof PixGatewayError ? error.message : (error as Error).message;

    /*
     * Cobrança que sumiu do gateway DEPOIS de vencer é cobrança expirada.
     *
     * A PixGo apaga o registro quando o prazo acaba, e passa a responder 404.
     * Antes esse 404 caía aqui e o pedido ficava pendente para sempre: voltava
     * a ser consultado a cada 25 s, para sempre, queimando o orçamento diário
     * de consultas. Esse é o estrago que importa — o teto existe para garantir
     * a confirmação de quem pagou, e pedido zumbi consumindo o teto faz cliente
     * que pagou de verdade parar de ser confirmado.
     *
     * As duas condições juntas são o que torna isto seguro: 404 dentro da
     * validade continua sendo tratado como falha, porque aí pode ser
     * instabilidade do gateway — e marcar expirado um pedido que talvez esteja
     * pago seria trocar um relatório errado por um cliente lesado.
     */
    const sumiuDoGateway = error instanceof PixGatewayError && error.code === CODIGO_COBRANCA_SUMIU;
    if (sumiuDoGateway && pastGracePeriod) {
      logger.info('Cobrança expirada e removida do gateway; encerrando o pedido', { orderId: order.id });
      return await applyStatus(order, 'expired', 'local');
    }

    logger.error('Falha ao consultar status no gateway', { orderId: order.id, error: message });
    await saveOrder(order);
    return order;
  }
}

export interface AccessBundle {
  released: boolean;
  orderId: string;
  contents: DeliverableContent[];
  pendingOrders: { id: string; offer: OfferId; status: OrderStatus; amountFormatted: string }[];
}

/**
 * Reúne tudo que o cliente já pagou (pedido principal + upsell/downsell).
 * O acesso só é liberado quando o pedido principal está confirmado.
 */
export async function buildAccessBundle(order: Order): Promise<AccessBundle> {
  const rootOrder = order.parentOrderId ? ((await getOrder(order.parentOrderId)) ?? order) : order;
  const relatedOrders = [rootOrder, ...(await listChildOrders(rootOrder.id))];

  const paidItemIds = relatedOrders
    .filter((related) => related.status === 'completed')
    .flatMap((related) => related.itemIds);

  return {
    released: rootOrder.status === 'completed',
    orderId: rootOrder.id,
    contents: rootOrder.status === 'completed' ? await getDeliverables(paidItemIds) : [],
    pendingOrders: relatedOrders
      .filter((related) => related.status === 'pending')
      .map((related) => ({
        id: related.id,
        offer: related.offer,
        status: related.status,
        amountFormatted: formatBRL(related.amountCents),
      })),
  };
}
