import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { limparAtribuicao } from './../atribuicao.js';
import { config } from './../config.js';
import { isOfferId } from './../catalog.js';
import { buildAccessBundle, createOrder, reconcileOrder, toPublicOrder } from './../orders.js';
import { registrarPedidoDeBoleto } from './../pedidoDeBoleto.js';
import { createRateLimiter } from './../rateLimit.js';
import { getOrder } from './../store/index.js';
import { ipDoClienteOuNulo } from './../utils.js';
import { parseCustomer, parseStringArray, ValidationError } from './../validation.js';

export const ordersRouter: Router = Router();

const createLimiter = createRateLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxOrdersPerWindow,
  message: 'Muitas tentativas de pagamento. Aguarde alguns minutos e tente novamente.',
});

/*
 * O que o checkout pode oferecer, perguntado ao servidor em vez de embutido no
 * build.
 *
 * A disponibilidade do boleto depende de haver provedor configurado, e isso
 * muda por variável de ambiente — sem esta rota, ligar o boleto exigiria
 * recompilar o site, e o botão poderia aparecer apontando para uma emissão que
 * não existe. Rota pública e sem dado nenhum de cliente: é só a resposta para
 * "dá para pagar de que jeitos hoje?".
 */
ordersRouter.get('/pagamento/opcoes', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      pix: { disponivel: true },
      boleto: {
        disponivel: config.boleto.disponivel,
        /** Em reais, para a tela poder explicar por que o boleto sumiu num pedido pequeno. */
        minimo: config.boleto.minAmountCents / 100,
        diasParaVencer: config.boleto.diasParaVencer,
        /**
         * O boleto abre uma CONVERSA em vez de emitir documento.
         *
         * É o estado enquanto não há provedor de emissão: a opção continua na
         * tela — quem não quer PIX precisa de um caminho — mas o que ela faz é
         * chamar o dono no WhatsApp, que combina o pagamento à mão.
         */
        peloWhatsapp: config.contato.boletoPeloWhatsapp,
      },
      /** Número de atendimento, só dígitos com país e DDD. Vazio = sem conversa. */
      whatsapp: config.contato.whatsapp,
    },
  });
});

/**
 * Freio do pedido de boleto, separado do freio de pedidos.
 *
 * Aqui não nasce cobrança em gateway nenhum — o custo de um pedido é uma linha
 * no banco —, então dividir o mesmo teto com o PIX faria quem pediu boleto e
 * desistiu ficar sem conseguir gerar o PIX logo em seguida. Continua sendo um
 * teto: a rota é pública e grava nome, e-mail e CPF.
 */
const boletoLimiter = createRateLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxOrdersPerWindow,
  message: 'Muitos pedidos de boleto. Aguarde alguns minutos e tente novamente.',
});

/**
 * Pedido de boleto pelo WhatsApp.
 *
 * A pessoa preencheu os dados, tocou em gerar boleto e foi para a conversa. Daí
 * em diante ela está fora do site, e o WhatsApp abre com o texto pronto mas NÃO
 * envia sozinho: quem não tocar em enviar do outro lado some sem deixar rastro.
 *
 * Esta rota é o registro que sobrevive a isso. É ela que põe a pessoa na aba
 * Boletos do painel, com contato, valor, CPF e o anúncio de onde veio — e é o
 * anúncio que permite, quando o boleto for pago lá fora, devolver a compra ao
 * Meta. Ver server/pedidoDeBoleto.ts.
 */
ordersRouter.post(
  '/boletos/pedido',
  boletoLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    /*
     * Sem conversa configurada não existe pedido de boleto para registrar, e a
     * rota deixa de ser um endereço público onde se despeja nome, e-mail e CPF.
     */
    if (!config.contato.boletoPeloWhatsapp) {
      throw new ValidationError('O boleto pelo WhatsApp não está disponível.', { field: 'metodo' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Mesma validação do PIX: nome, e-mail e CPF de verdade, ou nada é gravado.
    const customer = parseCustomer(body.customer);
    const bumpIds = parseStringArray(body.bumps, 'bumps');

    const contribuicaoBruta = body.contribuicao;
    const contribuicaoId =
      typeof contribuicaoBruta === 'string' && contribuicaoBruta.trim() !== '' ? contribuicaoBruta.trim() : null;

    const sessionIdBruto = body.session_id;
    const { pedido, jaExistia } = await registrarPedidoDeBoleto({
      nome: customer.name,
      email: customer.email,
      telefone: customer.phone || null,
      documento: customer.document,
      bumpIds,
      contribuicaoId,
      sessao: typeof sessionIdBruto === 'string' ? sessionIdBruto.trim().slice(0, 80) || null : null,
      atribuicao: limparAtribuicao(body.attrib),
      ip: ipDoClienteOuNulo(req),
      userAgent: (req.header('User-Agent') ?? '').trim().slice(0, 500) || null,
    });

    /*
     * A resposta é o mínimo: identificador e valor. Nada do que foi gravado
     * volta para a tela — quem mandou os dados já os tem, e a rota é pública.
     */
    res.status(jaExistia ? 200 : 201).json({
      success: true,
      data: { id: pedido.id, valorCentavos: pedido.valorCentavos },
    });
  }),
);

ordersRouter.post(
  '/orders',
  createLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const offer = body.offer ?? 'main';
    if (!isOfferId(offer)) {
      throw new ValidationError('Oferta inválida.', { field: 'offer' });
    }

    const bumpIds = parseStringArray(body.bumps, 'bumps');
    const parentOrderId = body.parentOrderId ? String(body.parentOrderId) : null;

    /*
     * A forma de pagar. Ausente é PIX — todo cliente que chegou antes da opção
     * existir, e todo pedido de upsell criado por um clique sem formulário.
     *
     * Só os dois valores conhecidos passam: um método desconhecido vira erro em
     * vez de silenciosamente virar PIX. Quem pediu boleto e recebeu um QR sem
     * aviso não entende o que aconteceu e abandona.
     */
    const metodoBruto = body.metodo ?? body.method ?? 'pix';
    if (metodoBruto !== 'pix' && metodoBruto !== 'boleto') {
      throw new ValidationError('Forma de pagamento inválida.', { field: 'metodo' });
    }
    const metodo = metodoBruto as 'pix' | 'boleto';

    /*
     * O acréscimo voluntário chega como ID, nunca como valor — quem sabe quanto
     * cada um custa é o catálogo do servidor. Um ID desconhecido é recusado em
     * resolveOffer, e não convertido em zero em silêncio.
     */
    const contribuicaoBruta = body.contribuicao;
    const contribuicaoId = typeof contribuicaoBruta === 'string' && contribuicaoBruta.trim() !== ''
      ? contribuicaoBruta.trim()
      : null;

    // Checado antes de parseCustomer para o erro apontar a causa real: sem isso,
    // um upsell sem parentOrderId reclamaria dos "dados do cliente".
    if (offer !== 'main' && !parentOrderId) {
      throw new ValidationError('As ofertas de upsell e downsell exigem o pedido principal.', {
        field: 'parentOrderId',
        code: 'PARENT_REQUIRED',
      });
    }

    // No upsell/downsell os dados do cliente vêm do pedido principal.
    const customer = parentOrderId ? undefined : parseCustomer(body.customer);

    /*
     * O carimbo do anúncio chega junto com o pedido e é gravado com ele.
     *
     * É aqui que o rastreamento deixa de depender do navegador: a partir deste
     * ponto a venda carrega a própria origem, e a confirmação que chegar horas
     * depois — pelo webhook, sem navegador nenhum aberto — ainda saberá de qual
     * anúncio veio.
     */
    const sessionIdBruto = body.session_id;
    const { order, reused } = await createOrder({
      offer,
      bumpIds,
      metodo,
      contribuicaoId,
      customer,
      parentOrderId,
      // O IP guardado aqui é o que vai no Purchase, horas depois, quando o
      // webhook confirmar e não houver mais navegador nenhum aberto. Se ele
      // nascer errado, não há como corrigir depois.
      clientIp: ipDoClienteOuNulo(req),
      atribuicao: limparAtribuicao(body.attrib),
      sessionId: typeof sessionIdBruto === 'string' ? sessionIdBruto.trim().slice(0, 80) || null : null,
      userAgent: (req.header('User-Agent') ?? '').trim().slice(0, 500) || null,
    });

    res.status(reused ? 200 : 201).json({ success: true, data: toPublicOrder(order) });
  }),
);

ordersRouter.get(
  '/orders/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado.' });
      return;
    }

    const synced = await reconcileOrder(order);
    res.json({ success: true, data: toPublicOrder(synced) });
  }),
);

ordersRouter.get(
  '/orders/:id/access',
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado.' });
      return;
    }

    const synced = await reconcileOrder(order);
    const bundle = await buildAccessBundle(synced);

    if (!bundle.released) {
      res.status(402).json({
        success: false,
        error: 'PAYMENT_REQUIRED',
        message: 'O pagamento ainda não foi confirmado.',
        data: { status: synced.status },
      });
      return;
    }

    res.json({ success: true, data: bundle });
  }),
);
