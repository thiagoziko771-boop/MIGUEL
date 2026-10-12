import { formatBRL } from './utils.js';
import { ValidationError } from './validation.js';

export type OfferId = 'main' | 'upsell' | 'downsell' | 'recuperacao';

export interface CatalogItem {
  id: string;
  /**
   * `contribuicao` é o acréscimo voluntário que a pessoa escolhe somar ao
   * pedido. Ele soma no total como um bump, mas NÃO ENTREGA NADA — e é por isso
   * que precisa de um tipo próprio: tratado como bump, apareceria no painel de
   * links de entrega como um produto eternamente sem link configurado, em
   * vermelho, pedindo uma providência que não existe.
   */
  kind: 'main' | 'bump' | 'upsell' | 'downsell' | 'contribuicao';
  title: string;
  priceCents: number;
}

/**
 * Fonte da verdade dos preços. O cliente envia apenas IDs de produto — nunca
 * valores — para que o total não possa ser adulterado pelo navegador.
 *
 * ATENÇÃO: o gateway recusa cobrança abaixo de R$ 10,00 (INVALID_AMOUNT).
 * Nenhum item cobrado sozinho — downsell e upsell — pode ficar abaixo disso. Os
 * bumps não têm esse limite porque só somam ao pedido principal, nunca são
 * cobrados separadamente.
 *
 * O piso de R$ 10,00 foi medido na PixGo. Desde 17/08/2026 quem processa é a
 * SyncPay (PIX_PROVIDER=syncpay), e o limite dela não foi confirmado — o valor
 * segue valendo como piso conservador em server/config.ts, e vale conferir no
 * painel da SyncPay antes de criar produto mais barato que isso.
 */
export const CATALOG: Record<string, CatalogItem> = {
  main: {
    id: 'main',
    kind: 'main',
    title: 'Oração Sagrada do Arcanjo Miguel',
    priceCents: 4700,
  },
  salmos_150: {
    id: 'salmos_150',
    kind: 'bump',
    title: 'Guia Sagrado dos 150 Salmos de Proteção & Libertação',
    priceCents: 2700,
  },
  vela_7dias: {
    id: 'vela_7dias',
    kind: 'bump',
    title: 'Consagração do Seu Nome na Vela Sagrada de 7 Dias',
    priceCents: 1490,
  },
  upsell: {
    id: 'upsell',
    kind: 'upsell',
    title: 'Aplicativo Espiritual com Rotina Diária & Tutorial em Vídeo',
    /*
     * R$ 47,00 desde 17/08/2026 — era R$ 97,00.
     *
     * O upsell aparece segundos depois de a pessoa ter decidido gastar R$ 47 na
     * Oração, e pedia mais que o dobro disso. Repetir o número que ela ACABOU de
     * aceitar é a oferta mais fácil de dizer sim que existe; a aposta é que o
     * aceite suba mais do que o preço caiu.
     *
     * QUEM DEPENDE DESTE NÚMERO, e quebra em silêncio se ele mudar sozinho: a
     * âncora e o selo de desconto do upsell (src/data/funnelData.ts e o selo em
     * InlineCheckout.tsx) e a âncora do downsell, que é justamente o preço que a
     * pessoa acabou de recusar.
     */
    priceCents: 4700,
  },
  downsell: {
    id: 'downsell',
    kind: 'downsell',
    title: 'Aplicativo Espiritual — Versão Essencial',
    priceCents: 1900,
  },

  /*
   * Os itens da campanha de recuperação.
   *
   * São PRODUTOS PRÓPRIOS, e não um desconto aplicado sobre os de cima. O
   * motivo é contábil antes de ser técnico: com IDs separados, o painel mostra
   * quanto veio da campanha e quanto veio do funil normal, sem ninguém precisar
   * lembrar de subtrair. Misturar os dois faria o ticket médio da operação cair
   * sem explicação, e a decisão de orçamento sairia torta.
   *
   * Só são alcançáveis por link assinado, com prazo. Não existe caminho no site
   * que leve a estes preços — e é por isso que a promessa de "só para você"
   * continua verdadeira.
   */
  recup_main: {
    id: 'recup_main',
    kind: 'main',
    title: 'Oração Sagrada do Arcanjo Miguel',
    priceCents: 2799,
  },
  recup_salmos: {
    id: 'recup_salmos',
    kind: 'bump',
    title: 'Guia Sagrado dos 150 Salmos de Proteção & Libertação',
    priceCents: 1700,
  },
  recup_vela: {
    id: 'recup_vela',
    kind: 'bump',
    title: 'Consagração do Seu Nome na Vela Sagrada de 7 Dias',
    priceCents: 990,
  },

  /*
   * A contribuição a mais, pedida por um comprador em 17/08/2026: ele quis
   * somar acima do valor do pedido e sugeriu que a tela oferecesse isso.
   *
   * VALORES FIXOS, e não campo livre, por uma razão que é de segurança antes de
   * ser de conveniência: o navegador continua mandando apenas um ID, e quem soma
   * é o servidor. Um campo de valor aberto seria a primeira porta deste checkout
   * por onde um número escolhido no inspetor chegaria à conta a pagar — e a
   * defesa teria de ser reinventada aqui, em vez de já estar de pé.
   *
   * Não entregam nada: são acréscimo à mesma Oração. Ver o comentário em `kind`.
   */
  semente_10: { id: 'semente_10', kind: 'contribuicao', title: 'Contribuição de gratidão — R$ 10,00', priceCents: 1000 },
  semente_25: { id: 'semente_25', kind: 'contribuicao', title: 'Contribuição de gratidão — R$ 25,00', priceCents: 2500 },
  semente_50: { id: 'semente_50', kind: 'contribuicao', title: 'Contribuição de gratidão — R$ 50,00', priceCents: 5000 },
};

/** Os acréscimos oferecidos na tela, na ordem em que aparecem. */
export const CONTRIBUICOES_EXTRA = ['semente_10', 'semente_25', 'semente_50'] as const;

export const OFFERS: Record<OfferId, { rootItemId: string; allowsBumps: boolean; description: string }> = {
  main: {
    rootItemId: 'main',
    allowsBumps: true,
    description: 'Oração Sagrada do Arcanjo Miguel',
  },
  upsell: {
    rootItemId: 'upsell',
    allowsBumps: false,
    description: 'Aplicativo Espiritual — Completo',
  },
  downsell: {
    rootItemId: 'downsell',
    allowsBumps: false,
    description: 'Aplicativo Espiritual — Versão Essencial',
  },
  recuperacao: {
    rootItemId: 'recup_main',
    allowsBumps: true,
    description: 'Oração Sagrada do Arcanjo Miguel',
  },
};

/**
 * Ofertas que o site aceita de quem chega pela rota pública.
 *
 * `recuperacao` está DE FORA de propósito: ela nasce só dentro do servidor, a
 * partir de um link assinado com prazo. Se ela entrasse aqui, qualquer pessoa
 * poderia mandar `{"offer":"recuperacao"}` para /api/orders e comprar por
 * R$ 27,99 o que custa R$ 47,00 — e o desconto "só para você" viraria o preço
 * de tabela em uma tarde.
 */
export function isOfferId(value: unknown): value is OfferId {
  return value === 'main' || value === 'upsell' || value === 'downsell';
}

/** Aceita também as ofertas internas, para uso do próprio servidor. */
export function isOfferIdInterna(value: unknown): value is OfferId {
  return isOfferId(value) || value === 'recuperacao';
}

export interface ResolvedOffer {
  offer: OfferId;
  items: CatalogItem[];
  itemIds: string[];
  amountCents: number;
  description: string;
}

export function resolveOffer(
  offer: OfferId,
  requestedBumpIds: string[],
  /** Id de um único acréscimo voluntário, quando a pessoa escolher um. */
  contribuicaoId?: string | null,
): ResolvedOffer {
  const definition = OFFERS[offer];
  const items: CatalogItem[] = [CATALOG[definition.rootItemId]];

  if (requestedBumpIds.length > 0) {
    if (!definition.allowsBumps) {
      throw new ValidationError(`A oferta "${offer}" não aceita order bumps.`, { field: 'bumps' });
    }
    const seen = new Set<string>();
    for (const bumpId of requestedBumpIds) {
      const item = CATALOG[bumpId];
      if (!item || item.kind !== 'bump') {
        throw new ValidationError(`Produto adicional desconhecido: "${bumpId}".`, { field: 'bumps' });
      }
      if (seen.has(bumpId)) continue;
      seen.add(bumpId);
      items.push(item);
    }
  }

  /*
   * O acréscimo voluntário. Um só por pedido: a tela oferece três valores e a
   * pessoa escolhe um, então receber dois aqui significa pedido montado à mão.
   *
   * Vale onde os bumps valem — a compra que nasce do formulário. No upsell e no
   * downsell a pessoa está a um clique de já ter pago; pedir uma contribuição
   * extra ali é cobrar duas vezes na mesma respiração.
   */
  if (contribuicaoId) {
    if (!definition.allowsBumps) {
      throw new ValidationError(`A oferta "${offer}" não aceita contribuição adicional.`, { field: 'contribuicao' });
    }
    const extra = CATALOG[contribuicaoId];
    if (!extra || extra.kind !== 'contribuicao') {
      throw new ValidationError(`Contribuição adicional desconhecida: "${contribuicaoId}".`, { field: 'contribuicao' });
    }
    items.push(extra);
  }

  const amountCents = items.reduce((total, item) => total + item.priceCents, 0);

  return {
    offer,
    items,
    itemIds: items.map((item) => item.id),
    amountCents,
    description: `${definition.description} (${formatBRL(amountCents)})`.slice(0, 200),
  };
}
