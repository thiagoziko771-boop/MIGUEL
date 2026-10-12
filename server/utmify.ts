/**
 * Envio de pedidos para a Utmify.
 *
 * Único arquivo que conhece a Utmify — mesma regra do server/pix.ts com o
 * gateway e do server/discord.ts com o Discord. O resto do sistema chama
 * `enviarPedidoParaUtmify` e não sabe de token nem de payload.
 *
 * **O QUE ESTA INTEGRAÇÃO FAZ, E O QUE ELA NÃO FAZ.** Vale escrito, porque a
 * confusão aqui custaria dias: este endpoint (`/api-credentials/orders`)
 * alimenta o PAINEL da Utmify. Ele não manda evento para o Pixel do Meta, e o
 * payload dele nem tem onde carregar `fbc`, `fbp` ou user-agent — os campos de
 * correspondência que a API de Conversões usa para casar a venda com o clique.
 * Quem manda a compra para o Meta continua sendo server/rastreamento.ts. Se um
 * dia esta integração for confundida com aquela, a conta vai parecer rastreada
 * e não estará.
 *
 * **NADA AQUI PODE DERRUBAR UMA VENDA** (regra 11 do CLAUDE.md): orçamento
 * curto, erro engolido, e a cobrança segue igual se a Utmify estiver fora do
 * ar. Um pedido que não chegou ao painel deles é uma linha faltando num
 * relatório; um cliente que pagou e não recebeu é outra categoria de problema.
 */
import { CATALOG } from './catalog.js';
import { lerCustos, repartir } from './custos.js';
import { logger } from './logger.js';
import { repositorioDoPainel } from './painel/repositorio.js';
import type { Order, OrderStatus } from './store/index.js';

export const CHAVE_TOKEN_UTMIFY = 'utmify.token';

const URL_DA_UTMIFY = 'https://api.utmify.com.br/api-credentials/orders';

/**
 * Orçamento igual ao do Discord, e pelo mesmo motivo.
 *
 * O envio sai de dentro do webhook do gateway, que espera resposta em ~10 s e
 * já gastou parte disso confirmando o pagamento. Segurar o callback faria o
 * gateway reentregar o mesmo aviso em looping — custo maior do que qualquer
 * relatório vale.
 */
const ORCAMENTO_MS = 2500;

/**
 * A Utmify RECUSA pedido velho, e avisa que insistir pode dar bloqueio:
 * 7 dias para pedido comum, 45 para reembolso e chargeback.
 *
 * A guarda existe porque a reconciliação varre pedidos antigos: sem ela, uma
 * varredura que tocasse num PIX de agosto tentaria reenviá-lo em outubro, e o
 * castigo não seria um 400 — seria a credencial bloqueada, com o painel deles
 * parando de receber TUDO.
 */
const DIAS_LIMITE_PEDIDO = 7;
const DIAS_LIMITE_DEVOLUCAO = 45;

export type StatusUtmify = 'waiting_payment' | 'paid' | 'refused' | 'refunded' | 'chargedback';

/**
 * O token, do painel ou do ambiente — a mesma ordem do Discord e do Meta.
 *
 * Guardado em texto puro, e é uma decisão consciente: quem tem este token
 * escreve pedido no painel de relatório do dono, e nada além disso. Não lê
 * venda, não move dinheiro, não fala com o gateway. Cifrar traria de volta o
 * modo de falha que já custou caro aqui — chave mestra trocada, segredo
 * ilegível, recurso desligado em silêncio.
 */
export async function tokenDaUtmify(): Promise<string> {
  try {
    const doPainel = await repositorioDoPainel().lerConfiguracao(CHAVE_TOKEN_UTMIFY);
    return (doPainel ?? process.env.UTMIFY_API_TOKEN ?? '').trim();
  } catch (erro) {
    logger.warn('Não consegui ler o token da Utmify no banco; usando a variável de ambiente', {
      erro: (erro as Error).message,
    });
    return (process.env.UTMIFY_API_TOKEN ?? '').trim();
  }
}

/**
 * O status deles, a partir do nosso.
 *
 * `expired` e `cancelled` viram `refused`, e essa é a única linha discutível do
 * arquivo. A Utmify não tem "expirado" no enum. Deixar o PIX abandonado como
 * `waiting_payment` para sempre faria cada cobrança que ninguém pagou continuar
 * parecendo uma venda prestes a acontecer — e são a MAIORIA delas, então o
 * painel encheria de pipeline eterno e o número de pendentes deixaria de
 * significar qualquer coisa. `refused` é o mais próximo que o enum oferece: o
 * pagamento não aconteceu e não vai acontecer.
 *
 * Chargeback é distinguido de reembolso pelo `statusGateway`, que guarda o
 * status CRU do provedor. São coisas diferentes para quem lê o relatório: um é
 * devolução que o dono concedeu, o outro é o banco tomando de volta.
 */
const CONTESTACOES = new Set(['chargeback', 'charged_back', 'chargedback', 'disputa', 'dispute']);

export function statusParaUtmify(order: Order): StatusUtmify | null {
  const bruto = String(order.statusGateway ?? '').trim().toLowerCase();

  switch (order.status as OrderStatus) {
    case 'pending':
      return 'waiting_payment';
    case 'completed':
      return 'paid';
    case 'refunded':
      return CONTESTACOES.has(bruto) ? 'chargedback' : 'refunded';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'refused';
    default:
      /* Status que ainda não existe: não inventamos um significado para ele. */
      return null;
  }
}

/**
 * "YYYY-MM-DD HH:MM:SS" em UTC 0, como a doc exige.
 *
 * Feito a partir do ISO em vez de `toLocaleString`: o servidor da Vercel roda
 * em UTC, mas o mesmo código roda na máquina do dono em horário de Brasília, e
 * um formatador dependente de fuso mandaria a venda três horas no passado sem
 * ninguém perceber — o relatório fecharia errado só nas vendas da madrugada.
 */
export function dataParaUtmify(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * `NOME|ID`, que é o formato em que a Utmify espera campanha, conjunto e anúncio.
 *
 * Os exemplos da doc mostram "CAMPANHA_2|413591587909524" — o id numérico é o
 * que liga a linha do relatório à campanha real no Gerenciador. Nós guardamos
 * nome e id em campos separados, então a junção é feita aqui. Se o nome já
 * vier com `|`, não duplicamos: o anúncio pode ter sido nomeado no padrão deles.
 */
function comId(nome: string | null | undefined, id: string | null | undefined): string | null {
  const n = (nome ?? '').trim();
  const i = (id ?? '').trim();
  if (n === '') return i === '' ? null : i;
  if (i === '' || n.includes('|')) return n;
  return `${n}|${i}`;
}

/** Quantos dias se passaram desde a criação do pedido. */
function diasDesde(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 86_400_000;
}

export interface PayloadUtmify {
  orderId: string;
  platform: string;
  paymentMethod: 'pix' | 'boleto';
  status: StatusUtmify;
  createdAt: string;
  approvedDate: string | null;
  refundedAt: string | null;
  customer: Record<string, unknown>;
  products: Array<Record<string, unknown>>;
  trackingParameters: Record<string, string | null>;
  commission: { totalPriceInCents: number; gatewayFeeInCents: number; userCommissionInCents: number };
}

/**
 * Monta o corpo. Separado do envio para a bateria poder conferir o formato sem
 * falar com ninguém — e é no formato que mora o erro caro: data em fuso errado
 * ou comissão zerada passam pela validação deles e sujam o relatório calado.
 */
export async function montarPayload(order: Order, status: StatusUtmify): Promise<PayloadUtmify> {
  const a = order.atribuicao ?? {};
  const custos = await lerCustos();

  /*
   * A taxa vem do MESMO `repartir` da aba Resumo, com uma venda só. Recalcular
   * aqui seria o jeito mais fácil de a Utmify dizer um lucro e o painel dizer
   * outro — e aí não se acredita em nenhum dos dois.
   */
  const conta = repartir(
    {
      receitaBrutaCentavos: order.amountCents,
      vendas: 1,
      devolvidoCentavos: 0,
      devolucoes: 0,
      investimentoCentavos: 0,
      despesasCentavos: 0,
    },
    custos,
  );

  /*
   * Sem modelo de custo preenchido, a taxa é 0 e a comissão do vendedor é o
   * valor cheio. A doc chama isso de "não recomendado" e tem razão — mas é o
   * que ela manda fazer quando não se sabe, e é melhor que chutar um percentual
   * que faria o relatório deles divergir do extrato.
   */
  const taxa = custos.configurado ? conta.taxasCentavos : 0;

  return {
    orderId: order.id,
    platform: 'MiguelTeChama',
    paymentMethod: order.metodo === 'boleto' ? 'boleto' : 'pix',
    status,
    /*
     * SEMPRE a data de criação do pedido, inclusive nas atualizações de status.
     * A doc é explícita, e mandar a data de "agora" na confirmação faria cada
     * venda nascer no relatório no instante em que foi paga — a atribuição por
     * dia deixaria de bater com a do Gerenciador.
     */
    createdAt: dataParaUtmify(order.createdAt) ?? dataParaUtmify(new Date().toISOString())!,
    approvedDate: status === 'paid' || status === 'refunded' || status === 'chargedback'
      ? dataParaUtmify(order.paidAt ?? order.updatedAt)
      : null,
    refundedAt: status === 'refunded' || status === 'chargedback'
      ? dataParaUtmify(order.updatedAt)
      : null,
    customer: {
      name: order.customer.name || 'Cliente',
      email: order.customer.email,
      phone: order.customer.phone || null,
      document: order.customer.document || null,
      country: 'BR',
      ...(order.clientIp ? { ip: order.clientIp } : {}),
    },
    products: order.itemIds.map((id) => {
      const item = CATALOG[id];
      return {
        id,
        name: item?.title ?? id,
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: item?.priceCents ?? 0,
      };
    }),
    trackingParameters: {
      /* `src` e `sck` são convenção de checkout hospedado; o nosso é próprio. */
      src: null,
      sck: null,
      utm_source: (a.utm_source ?? '').trim() || null,
      utm_campaign: comId(a.utm_campaign, a.fb_campaign_id),
      utm_medium: comId(a.utm_medium, a.fb_adset_id),
      utm_content: comId(a.utm_content, a.fb_ad_id),
      utm_term: (a.utm_term ?? '').trim() || null,
    },
    commission: {
      totalPriceInCents: order.amountCents,
      gatewayFeeInCents: taxa,
      userCommissionInCents: order.amountCents - taxa,
    },
  };
}

/**
 * Manda e engole o próprio erro. NUNCA lança.
 *
 * `AbortController` e não só um timeout: sem abortar de verdade a requisição
 * seguiria pendurada depois do orçamento e, na Vercel, seguraria a função além
 * do necessário — que é o que a regra 8 existe para evitar.
 */
export async function enviarPedidoParaUtmify(order: Order): Promise<{ enviado: boolean; motivo?: string }> {
  try {
    const token = await tokenDaUtmify();
    if (token === '') return { enviado: false, motivo: 'sem token' };

    const status = statusParaUtmify(order);
    if (!status) return { enviado: false, motivo: `status sem equivalente: ${order.status}` };

    /* A guarda de idade. Ver o comentário nas constantes: insistir dá bloqueio. */
    const idade = diasDesde(order.createdAt);
    const limite = status === 'refunded' || status === 'chargedback'
      ? DIAS_LIMITE_DEVOLUCAO
      : DIAS_LIMITE_PEDIDO;
    if (idade > limite) {
      logger.warn('Pedido velho demais para a Utmify; não enviado de propósito', {
        pedido: order.id,
        dias: Math.round(idade),
        limite,
      });
      return { enviado: false, motivo: `pedido com ${Math.round(idade)} dias, limite ${limite}` };
    }

    const payload = await montarPayload(order, status);

    const freio = new AbortController();
    const relogio = setTimeout(() => freio.abort(), ORCAMENTO_MS);
    try {
      const resposta = await fetch(process.env.UTMIFY_BASE_URL ?? URL_DA_UTMIFY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': token },
        body: JSON.stringify(payload),
        signal: freio.signal,
      });
      if (!resposta.ok) {
        /*
         * O corpo do erro deles diz QUAL campo foi recusado, e é a única pista
         * de um payload que passou a divergir. Sem isso, "a Utmify recusou"
         * viraria uma tarde reproduzindo à mão.
         */
        const detalhe = await resposta.text().catch(() => '');
        logger.warn('Utmify recusou o pedido', {
          pedido: order.id,
          status: resposta.status,
          detalhe: detalhe.slice(0, 300),
        });
        return { enviado: false, motivo: `HTTP ${resposta.status}` };
      }
      return { enviado: true };
    } finally {
      clearTimeout(relogio);
    }
  } catch (erro) {
    logger.warn('Falha ao enviar pedido para a Utmify', { pedido: order.id, erro: (erro as Error).message });
    return { enviado: false, motivo: (erro as Error).message };
  }
}
