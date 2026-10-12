import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { config } from './../config.js';
import { fetchPaymentStatus, primeiroTexto } from './../pix.js';
import { logger } from './../logger.js';
import { applyStatus } from './../orders.js';
import { repositorioDoPainel } from './../painel/repositorio.js';
import { getOrder, getOrderByPaymentId, markWebhookProcessed, saveOrder } from './../store/index.js';

export const webhookRouter: Router = Router();

/**
 * Webhook de mudança de status da PixGo.
 *
 * Duas barreiras, e as duas importam:
 *
 * 1. A assinatura HMAC da PixGo é conferida antes de tudo. O endereço é público
 *    e qualquer um na internet pode chamá-lo.
 * 2. NADA no corpo é tratado como verdade, nem depois da assinatura conferir.
 *    Dele sai apenas o identificador da cobrança, e o status vem de uma consulta
 *    nossa à API autenticada. Um POST forjado com "completed" não libera produto
 *    nenhum.
 *
 * A segunda barreira não é redundância: ela é o que mantém o sistema seguro se
 * o segredo vazar, se a verificação for desligada por configuração ausente, ou
 * se a PixGo mudar o esquema de assinatura sem avisar.
 */

/**
 * Confere a assinatura da PixGo.
 *
 * Eles assinam HMAC-SHA256 sobre `timestamp + "." + corpo cru`, com o segredo
 * do painel. Só vale sobre os BYTES ORIGINAIS: reserializar o JSON muda espaço
 * e ordem de chave e derruba uma assinatura boa.
 *
 * O exemplo em Node da documentação tem um defeito que copiamos de propósito ao
 * contrário: `timingSafeEqual` lança quando os buffers têm tamanhos diferentes,
 * então uma assinatura truncada viraria exceção em vez de recusa. Conferimos o
 * tamanho antes.
 */
function conferirCom(segredo: string, corpoCru: string, carimbo: string, assinatura: string): boolean {
  const esperada = crypto.createHmac('sha256', segredo).update(`${carimbo}.${corpoCru}`).digest('hex');
  const a = Buffer.from(esperada, 'hex');
  const b = Buffer.from(assinatura.trim(), 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Lê o header `X-ZuckPay-Signature: t=<carimbo>,v1=<hmac>`.
 *
 * A ZuckPay assina o mesmo conteúdo da PixGo (`carimbo + "." + corpo cru`), mas
 * empacota carimbo e assinatura num header só, separados por vírgula. A leitura
 * é por NOME da parte, não por posição: se eles inverterem a ordem ou
 * acrescentarem um `v2=`, continuamos lendo o par certo em vez de recusar todo
 * callback legítimo por causa de um detalhe de formatação.
 */
function assinaturaZuckPay(cabecalho: string): { carimbo: string; assinatura: string } | null {
  let carimbo = '';
  let assinatura = '';
  for (const parte of cabecalho.split(',')) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    const chave = parte.slice(0, igual).trim();
    const valor = parte.slice(igual + 1).trim();
    if (chave === 't') carimbo = valor;
    else if (chave === 'v1') assinatura = valor;
  }
  if (!carimbo || !assinatura) return null;
  return { carimbo, assinatura };
}

interface SeloDoCallback {
  carimbo: string;
  assinatura: string;
  /** Segredos que podem tê-lo produzido. Qualquer um que bata prova a origem. */
  segredos: string[];
}

/**
 * O selo que o gateway ativo carimba — ou `null` quando ele não assina nada.
 *
 * Três comportamentos diferentes, e misturá-los custa caro nos dois sentidos:
 *
 * • PixGo assina SEMPRE, em dois headers. As duas documentações dela se
 *   contradizem sobre qual segredo assina — uma manda o Webhook Secret
 *   (`whsec_...`), a outra repete em três exemplos que é a chave da API
 *   (`pk_...`). Aceitamos os dois: ambos são segredos que só nós e eles
 *   conhecemos, então bater com qualquer um prova a origem do mesmo jeito, e
 *   escolher um só e errar recusaria TODO callback legítimo.
 * • ZuckPay assina SÓ SE o dono gerou o segredo em /conta/keys.php. Sem
 *   segredo gerado o postback chega sem header nenhum — por isso `null` aqui
 *   quando não temos o segredo, em vez de recusar tudo com 401.
 * • SyncPay não assina: manda um Bearer próprio, conferido separadamente.
 *
 * Devolver `null` não abre brecha: o status NUNCA vem do corpo, ele é
 * reconsultado na API autenticada antes de qualquer mudança.
 */
function seloDoCallback(req: Request): SeloDoCallback | null {
  if (config.pix.provider === 'zuckpay') {
    const segredo = config.pix.zuckpay.webhookSecret;
    if (!segredo) return null;
    const partes = assinaturaZuckPay(String(req.header('X-ZuckPay-Signature') ?? ''));
    /*
     * Segredo configurado e header ausente é recusa. Com o segredo gerado no
     * painel deles, todo postback legítimo vem assinado — um que chegue nu
     * veio de outro lugar.
     */
    return { carimbo: partes?.carimbo ?? '', assinatura: partes?.assinatura ?? '', segredos: [segredo] };
  }

  if (config.pix.provider === 'pixgo') {
    const segredos = [config.pix.webhookSecret, config.pix.apiKey].filter(Boolean);
    if (segredos.length === 0) return null;
    return {
      carimbo: String(req.header('X-Webhook-Timestamp') ?? ''),
      assinatura: String(req.header('X-Webhook-Signature') ?? ''),
      segredos,
    };
  }

  return null;
}

function seloConfere(selo: SeloDoCallback, corpoCru: string): boolean {
  if (!selo.carimbo || !selo.assinatura) return false;
  return selo.segredos.some((segredo) => conferirCom(segredo, corpoCru, selo.carimbo, selo.assinatura));
}

/**
 * Recusa carimbo fora da janela. Sem isso, um aviso legítimo capturado hoje
 * poderia ser reenviado amanhã — a assinatura continuaria válida para sempre.
 */
function carimboRecente(carimbo: string): boolean {
  const segundos = Number.parseInt(carimbo, 10);
  if (!Number.isFinite(segundos)) return false;
  return Math.abs(Date.now() / 1000 - segundos) <= config.pix.webhookToleranciaSegundos;
}

/** Ver o comentário no ponto de uso, logo abaixo do `evento`. */
const EVENTOS_SEM_NADA_A_CONFIRMAR = new Set(['order.created', 'checkout_abandoned']);

/**
 * Onde o identificador da cobrança costuma aparecer no corpo do callback.
 *
 * A PixGo manda `payment_id` e `external_id` em snake_case, dentro de `data`.
 * As grafias em camelCase ficam de herança, para um callback antigo de outro
 * provedor ainda ser aproveitado em vez de descartado.
 */
const CHAVES_DE_ID = [
  'payment_id',
  'external_id',
  'id',
  'transactionId',
  'cashInId',
  'cashinId',
  'paymentId',
  'externalId',
  'externalReference',
];

function extrairId(corpo: any): string {
  /*
   * ZuckPay tem ordem PRÓPRIA, e ignorá-la zerava as confirmações.
   *
   * O postback dela traz TRÊS identificadores dentro de `transaction`:
   *   • `id`                 — o transactionId, que é o que guardamos como paymentId;
   *   • `external_id_client` — o NOSSO id de pedido, que mandamos na criação;
   *   • `external_id`        — a referência INTERNA deles ("ORDER-123"), que
   *                            nunca vimos antes e não corresponde a nada nosso.
   *
   * A lista genérica abaixo procura `external_id` ANTES de `id`, herança de
   * provedores em que aquele campo era o nosso. Aplicada à ZuckPay, ela
   * devolveria a referência interna: TODO callback cairia em "pedido
   * desconhecido", nenhuma venda se confirmaria pelo webhook e a confirmação
   * dependeria só da varredura de pendentes — minutos de atraso em cima de
   * gente que acabou de pagar e está olhando a tela.
   */
  if (config.pix.provider === 'zuckpay') {
    const daZuckPay = primeiroTexto(corpo?.transaction ?? corpo?.data ?? corpo, [
      'id',
      'transactionId',
      'external_id_client',
    ]);
    if (daZuckPay) return daZuckPay;
  }

  const fontes = [corpo, corpo?.data, corpo?.payload, corpo?.transaction, corpo?.cashin];
  for (const fonte of fontes) {
    if (!fonte || typeof fonte !== 'object') continue;
    for (const chave of CHAVES_DE_ID) {
      const valor = fonte[chave];
      if (valor !== undefined && valor !== null && String(valor).trim() !== '') return String(valor).trim();
    }
  }
  return '';
}

/**
 * Todo callback vira linha no painel, inclusive o que foi ignorado. Sem esse
 * registro, "o gateway avisou?" é uma pergunta sem resposta quando um cliente
 * reclama que pagou.
 */
async function registrar(entrada: {
  evento: string | null;
  cobrancaId: string | null;
  pedidoId: string | null;
  statusInformado: string | null;
  statusConfirmado: string | null;
  resultado: string;
  detalhe: string | null;
  corpo?: unknown;
}): Promise<void> {
  try {
    await repositorioDoPainel().registrarWebhook(entrada);
  } catch (erro) {
    // O log do painel nunca pode derrubar o processamento do pagamento.
    logger.error('Falha ao registrar o callback no painel', { erro: (erro as Error).message });
  }
}

async function receberCallback(req: Request, res: Response): Promise<void> {
  // O corpo cru (Buffer) é o que a assinatura cobre — reserializar o JSON
  // mudaria os bytes e derrubaria uma assinatura boa. Nos caminhos fora da
  // lista de express.raw ele chega já convertido, e aí só o fluxo sem segredo
  // funciona: perder um callback custa uma venda.
  const corpoCru = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  let corpo: any;
  try {
    if (corpoCru) corpo = JSON.parse(corpoCru);
    else corpo = req.body && typeof req.body === 'object' ? req.body : {};
  } catch {
    res.status(400).json({ received: false, error: 'CORPO_INVALIDO' });
    return;
  }

  /*
   * Assinatura ANTES de qualquer outra coisa. O endereço é público e a PixGo
   * assina os callbacks, então conferir aqui é o que separa um aviso do gateway
   * de um POST de qualquer um na internet.
   *
   * Recusamos com 401 sem registrar no painel: um atacante que descubra a URL
   * poderia encher o histórico de linhas falsas só disparando requisições.
   */
  const selo = seloDoCallback(req);

  /*
   * SyncPay: o Bearer do webhook, quando vier, tem de ser o nosso.
   *
   * A criação do webhook devolveu um token que a SyncPay põe no header
   * Authorization de cada aviso. Header presente e ERRADO só existe em forja ou
   * configuração alheia — recusa na porta. Header AUSENTE passa: o aviso
   * "padrão OLD" (o webhook_url que mandamos dentro de cada cash-in) vem sem
   * token, e o que protege esse caminho é a reconsulta logo abaixo, que nunca
   * acredita no corpo.
   */
  if (config.pix.provider === 'syncpay' && config.pix.syncpay.webhookToken) {
    const bearer = String(req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (bearer && bearer !== config.pix.syncpay.webhookToken) {
      logger.warn('Callback recusado: Bearer da SyncPay não confere', { caminho: req.path });
      res.status(401).json({ received: false, error: 'TOKEN_INVALIDO' });
      return;
    }
  }

  if (selo) {
    if (!corpoCru) {
      // Sem os bytes originais não há o que verificar. Acontece se o caminho
      // não estiver na lista que recebe express.raw em server/app.ts.
      logger.error('Callback chegou sem corpo cru; assinatura não pôde ser conferida', { caminho: req.path });
      res.status(400).json({ received: false, error: 'CORPO_CRU_AUSENTE' });
      return;
    }
    if (!seloConfere(selo, corpoCru)) {
      logger.warn('Callback recusado: assinatura inválida', {
        caminho: req.path,
        provedor: config.pix.provider,
        temCarimbo: Boolean(selo.carimbo),
        temAssinatura: Boolean(selo.assinatura),
      });
      res.status(401).json({ received: false, error: 'ASSINATURA_INVALIDA' });
      return;
    }
    if (!carimboRecente(selo.carimbo)) {
      logger.warn('Callback recusado: carimbo fora da janela aceita', { carimbo: selo.carimbo });
      res.status(401).json({ received: false, error: 'CARIMBO_EXPIRADO' });
      return;
    }
  } else {
    /*
     * Sem segredo configurado seguimos processando, e isso é seguro porque o
     * status nunca vem do corpo: ele é reconsultado na API autenticada logo
     * abaixo. O aviso existe para o segredo não ficar esquecido.
     */
    logger.warn('Sem segredo para conferir a assinatura: callback aceito apenas porque o status vem de reconsulta');
  }

  const evento = String(corpo?.event ?? corpo?.type ?? '');
  const identificador = extrairId(corpo);

  if (!identificador) {
    // Corpo que não sabemos ler: registramos para diagnóstico. Um 4xx aqui faz
    // o gateway desistir de reentregar, então só recusamos o que é irrecuperável.
    logger.error('Callback do gateway sem identificador reconhecível', {
      evento,
      chaves: Object.keys(corpo ?? {}),
      corpo: corpoCru.slice(0, 1000),
    });
    await registrar({
      evento: evento || null, cobrancaId: null, pedidoId: null,
      statusInformado: null, statusConfirmado: null,
      resultado: 'erro', detalhe: 'callback sem identificador reconhecivel', corpo: corpo,
    });
    res.status(400).json({ received: false, error: 'SEM_IDENTIFICADOR' });
    return;
  }

  /*
   * Não filtramos por nome de evento de propósito. Antes havia um descarte de
   * tudo que não começasse com "cashin", que era a nomenclatura da BitFlow —
   * com outro provedor, cujos eventos se chamam "payment.paid" ou coisa
   * parecida, esse filtro jogaria fora TODOS os avisos e nenhuma venda seria
   * confirmada pelo callback.
   *
   * O critério genérico é melhor e igualmente seguro: se o identificador não
   * corresponder a um pedido nosso, ignoramos logo abaixo. Evento de saque ou
   * de outra natureza cai nesse caso naturalmente.
   */
  const pedido = (await getOrderByPaymentId(identificador)) ?? (await getOrder(identificador));
  if (!pedido) {
    // 200 para o gateway não ficar reentregando um evento que não é nosso.
    logger.warn('Callback do gateway para pedido desconhecido', { evento, identificador });
    await registrar({
      evento: evento || null, cobrancaId: identificador, pedidoId: null,
      statusInformado: String(corpo?.status ?? ''), statusConfirmado: null,
      resultado: 'ignorado', detalhe: 'nenhum pedido nosso com esse identificador',
    });
    res.status(200).json({ received: true, ignored: 'PEDIDO_DESCONHECIDO' });
    return;
  }

  if (!pedido.paymentId) {
    pedido.paymentId = identificador;
    await saveOrder(pedido);
  }

  /*
   * Eventos que não têm o que confirmar.
   *
   * `order.created` (PixGo) só avisa que a cobrança nasceu — nós acabamos de
   * criá-la, e ela nasce pendente. `checkout_abandoned` (ZuckPay) avisa o
   * contrário: ninguém pagou. Nos dois casos reconsultar não muda nada e queima
   * uma requisição do teto diário, inclusive nas cobranças que ninguém vai
   * pagar — que são a maioria. Registramos para o histórico e paramos.
   */
  if (EVENTOS_SEM_NADA_A_CONFIRMAR.has(evento)) {
    await registrar({
      evento, cobrancaId: identificador, pedidoId: pedido.id,
      statusInformado: String(corpo?.status ?? ''), statusConfirmado: null,
      resultado: 'ignorado',
      detalhe: evento === 'checkout_abandoned'
        ? 'checkout abandonado: nada a confirmar'
        : 'cobranca recem-criada, nada a confirmar',
    });
    res.status(200).json({ received: true, ignored: 'SEM_NADA_A_CONFIRMAR' });
    return;
  }

  // A consulta é a fonte da verdade. Falhando, devolvemos 5xx de propósito:
  // o gateway reentrega, e a varredura de pendentes é a segunda rede.
  let statusReal;
  try {
    /*
     * Teto de 6 s nesta consulta. A PixGo espera resposta do webhook em ~10 s e,
     * passando disso, considera falha e reenvia. Com o timeout padrão de 15 s a
     * nossa resposta chegaria sempre tarde: eles reentregariam o mesmo aviso em
     * looping enquanto a consulta se arrastava. Estourando, devolvemos 503 de
     * propósito — a reentrega deles e a varredura de pendentes cobrem o caso.
     */
    statusReal = await fetchPaymentStatus(pedido.paymentId ?? identificador, { timeoutMs: 6_000 });
  } catch (erro) {
    logger.error('Callback recebido, mas a consulta ao gateway falhou; nada foi liberado', {
      pedido: pedido.id,
      erro: (erro as Error).message,
    });
    await registrar({
      evento: evento || null, cobrancaId: identificador, pedidoId: pedido.id,
      statusInformado: String(corpo?.status ?? ''), statusConfirmado: null,
      resultado: 'erro', detalhe: `consulta ao gateway falhou: ${(erro as Error).message}`,
    });
    res.status(503).json({ received: false, error: 'CONSULTA_INDISPONIVEL' });
    return;
  }

  // Dedupe pelo estado confirmado, não pelo que o corpo alegou.
  const chaveDedupe = `pix:${identificador}:${statusReal.status}`;
  if (!(await markWebhookProcessed(chaveDedupe, pedido.id))) {
    await registrar({
      evento: evento || null, cobrancaId: identificador, pedidoId: pedido.id,
      statusInformado: String(corpo?.status ?? ''), statusConfirmado: statusReal.status,
      resultado: 'ignorado', detalhe: 'reentrega do mesmo evento',
    });
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  pedido.statusGateway = statusReal.statusBruto;
  await applyStatus(pedido, statusReal.status, 'webhook');

  await registrar({
    evento: evento || null, cobrancaId: identificador, pedidoId: pedido.id,
    statusInformado: String(corpo?.status ?? corpo?.data?.status ?? corpo?.transaction?.status ?? ''),
    statusConfirmado: statusReal.statusBruto || statusReal.status,
    resultado: 'processado', detalhe: null,
  });

  logger.info('Callback do gateway processado', {
    pedido: pedido.id,
    evento,
    statusInformado: String(corpo?.status ?? corpo?.data?.status ?? corpo?.transaction?.status ?? '?'),
    statusConfirmado: statusReal.status,
  });
  res.status(200).json({ received: true });
}

/**
 * A rota canônica é /webhooks/pix. Os apelidos continuam aceitos porque a URL
 * do callback é digitada à mão no painel do gateway, e um erro de digitação lá
 * vira 404 silencioso aqui: o pagamento entra e o aviso se perde. As grafias da
 * BitFlow ficam de herança — se alguma cobrança antiga ainda avisar por elas, o
 * aviso é aproveitado em vez de descartado. Acrescente aqui o caminho do
 * provedor novo.
 */
export const CAMINHOS_DO_CALLBACK = [
  '/webhooks/zuckpay',
  '/webhooks/pixgo',
  '/webhooks/pix',
  '/webhooks/bitflow',
  '/webhooks/bitlfow',
  '/webhooks/bitflowpay',
];

webhookRouter.post(CAMINHOS_DO_CALLBACK, asyncHandler(receberCallback));
