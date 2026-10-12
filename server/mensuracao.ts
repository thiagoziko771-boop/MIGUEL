import { logger } from './logger.js';
import { repositorioDoPainel, type EventoDoFunil } from './painel/repositorio.js';
import type { Order } from './store/index.js';

/**
 * Mensuração própria. Substituiu `server/rastreamento.ts` em 21/08/2026.
 *
 * O arquivo antigo ficava entre o funil e o Meta: gravava a passagem no nosso
 * banco E mandava o evento para a API de Conversões. A metade que falava com o
 * Meta foi removida do projeto; o que sobrou — e ganhou a conversão interna —
 * está aqui.
 *
 * A REGRA CONTINUA A MESMA, e é a única que importa neste arquivo: **nada aqui
 * pode derrubar uma venda**. Toda função engole o próprio erro. Um pagamento
 * confirmado que não vira linha de relatório é um número errado; um pagamento
 * que não libera o produto porque a gravação falhou é um cliente lesado. A
 * ordem de importância entre os dois não é discutível.
 *
 * NADA DAQUI SAI PARA PLATAFORMA DE ANÚNCIO. Nem Meta, nem TikTok, nem
 * ninguém. O que existe é registro no nosso Postgres e exportação por
 * `/admin/conversoes.csv`, que só o dono logado alcança.
 */

/** Grava a passagem pelo funil. Nunca lança. */
export async function registrarPassagem(entrada: EventoDoFunil): Promise<void> {
  try {
    await repositorioDoPainel().registrarEventoDoFunil(entrada);
  } catch (erro) {
    logger.error('Falha ao registrar evento do funil', { erro: (erro as Error).message, evento: entrada.evento });
  }
}

/**
 * Registra a CONVERSÃO — a venda confirmada, achatada em colunas consultáveis.
 *
 * Chamada de um lugar só: `applyStatus`, em server/orders.ts, no instante em
 * que um pedido vira `completed`. E `applyStatus` já recusa, uma linha acima,
 * qualquer caminho que traria um pedido pago de volta para pendente. QR criado,
 * PIX copiado, checkout aberto e clique em "pagar" não passam por aqui — só
 * passa quem o gateway confirmou.
 *
 * POR QUE UMA TABELA NOVA, se o pedido já existe. A atribuição vive dentro de
 * `orders.data`, um JSONB. Perguntar "quantas vendas vieram do anúncio X" ali
 * significa `data->'atribuicao'->>'fb_ad_id'` em cima da tabela inteira, sem
 * índice, a cada consulta — e é justamente a pergunta que se faz o dia todo
 * quando se decide orçamento. Aqui cada campo é uma coluna, com índice onde
 * importa.
 *
 * IDEMPOTÊNCIA: `order_id` é PRIMARY KEY e a gravação é `ON CONFLICT DO
 * NOTHING`. A reentrega do webhook — que todo gateway faz por desenho — não
 * cria uma segunda linha. É a mesma trava que `webhook_events` já usa, pelo
 * mesmo motivo, e nenhuma das duas depende da outra.
 */
export async function registrarConversao(order: Order): Promise<void> {
  try {
    /*
     * A guarda existe apesar de o chamador já garantir isto. Não é
     * desconfiança do `applyStatus`: é que esta função é pública, e a linha
     * mais cara de todo o sistema seria alguém chamá-la de um lugar novo, sem
     * ler o cabeçalho, e registrar como venda um pedido que ninguém pagou.
     */
    if (order.status !== 'completed') {
      logger.warn('registrarConversao chamada com pedido não pago; ignorada', {
        pedido: order.id,
        status: order.status,
      });
      return;
    }

    const a = order.atribuicao ?? {};
    const texto = (v: unknown): string | null => {
      const t = String(v ?? '').trim();
      return t === '' ? null : t.slice(0, 500);
    };

    await repositorioDoPainel().registrarConversao({
      orderId: order.id,
      paidAt: order.paidAt ?? order.updatedAt,
      valorCentavos: order.amountCents,
      moeda: 'BRL',
      metodo: order.metodo ?? 'pix',
      itemIds: order.itemIds,
      /*
       * Só parâmetros de ORIGEM. Nome, e-mail, telefone e CPF ficam no pedido,
       * que é onde servem para atender o cliente — repeti-los aqui espalharia
       * dado pessoal por mais uma tabela sem responder nenhuma pergunta de
       * mensuração. Resposta de quiz não entra aqui em hipótese nenhuma.
       */
      fbclid: texto(a.fbclid),
      utmSource: texto(a.utm_source),
      utmMedium: texto(a.utm_medium),
      utmCampaign: texto(a.utm_campaign),
      utmTerm: texto(a.utm_term),
      utmContent: texto(a.utm_content),
      utmId: texto(a.utm_id),
      fbCampaignId: texto(a.fb_campaign_id),
      fbAdsetId: texto(a.fb_adset_id),
      fbAdId: texto(a.fb_ad_id),
      fbPlacement: texto(a.fb_placement),
      fbSource: texto(a.fb_source),
      gclid: texto(a.gclid),
      ttclid: texto(a.ttclid),
      ttCampaignId: texto(a.tt_campaign_id),
      ttAdgroupId: texto(a.tt_adgroup_id),
      ttAdId: texto(a.tt_ad_id),
      ttPlacement: texto(a.tt_placement),
      bm: texto(a.bm),
      landingUrl: texto(a.landing_url),
      referrer: texto(a.referrer),
      sessionId: texto(order.trackId),
    });
  } catch (erro) {
    /*
     * Engolido de propósito (regra 11). O pedido já está gravado como pago e o
     * produto já vai ser entregue; falta uma linha de relatório, e a varredura
     * de reconciliação passa por `applyStatus` de novo mais tarde.
     */
    logger.error('Falha ao registrar a conversão interna', {
      pedido: order.id,
      erro: (erro as Error).message,
    });
  }
}
