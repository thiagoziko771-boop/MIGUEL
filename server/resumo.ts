/**
 * O Resumo — a única tela que responde "sobrou dinheiro?".
 *
 * Os números já existiam, repartidos entre três abas: receita em Relatórios,
 * gasto em Anúncios, pendentes em Pedidos. Nenhuma delas descontava taxa nem
 * imposto, então "Lucro" em qualquer uma queria dizer apenas `receita - anúncio`.
 * Aqui a conta passa por server/custos.ts e o número finalmente fecha com o
 * extrato.
 *
 * Só cálculo, sem banco — mesma disciplina de server/fechamento.ts. O roteador
 * junta pedidos, investimento, despesas e custos e entrega prontos, o que
 * permite conferir cada centavo com valores fixos em scripts/testar-resumo.mjs.
 *
 * Os critérios de contagem são COPIADOS de fechamento.ts de propósito: pedido
 * cai no dia em que foi criado, principal é o sem `parentOrderId`, pago é
 * `completed`. Duas telas que contam venda de jeitos diferentes é o defeito mais
 * caro que um painel pode ter, porque as duas parecem certas.
 */
import { repartir, type Custos, type Reparticao } from './custos.js';
import type { Investimento } from './painel/repositorio.js';
import type { Order } from './store/index.js';

/**
 * Status crus do gateway que significam contestação, não devolução combinada.
 *
 * Igualdade exata contra uma lista, nunca `includes` — mesma regra do
 * STATUS_MAP em server/pix.ts, e aqui vale porque o painel do adquirente e o
 * nosso precisam contar a MESMA coisa. O que não estiver na lista conta como
 * reembolso comum, que é o lado que não gera alarme falso.
 */
const CONTESTACOES = new Set(['chargeback', 'charged_back', 'chargedback', 'disputa', 'dispute']);

function ehContestacao(order: Order): boolean {
  return CONTESTACOES.has(String(order.statusGateway ?? '').trim().toLowerCase());
}

/** De onde a pessoa veio. Sem carimbo é `direto`, que é informação e não buraco. */
function fonteDoPedido(order: Order): string {
  const bruto = order.atribuicao?.utm_source ?? order.utm?.source ?? '';
  const limpo = String(bruto).trim().toLowerCase().slice(0, 40);
  return limpo === '' ? 'direto' : limpo;
}

export interface FatiaDoResumo {
  chave: string;
  vendas: number;
  centavos: number;
}

export interface Resumo {
  /** Pago e que ficou. Devolvido não entra: não é faturamento, é dinheiro que passou. */
  receitaBrutaCentavos: number;
  vendas: number;

  /** PIX gerado esperando pagamento — a maior reserva de dinheiro do funil. */
  pendentes: number;
  pendenteCentavos: number;

  devolucoes: number;
  devolvidoCentavos: number;
  /** Das devoluções, quantas foram contestação e não reembolso combinado. */
  contestacoes: number;
  contestadoCentavos: number;

  investimentoCentavos: number;
  /** Se algum gasto foi registrado. Zero sem registro ≠ zero de verdade. */
  temInvestimento: boolean;
  despesasCentavos: number;

  /** Toda a repartição de custos. Ver server/custos.ts. */
  custos: Reparticao;
  /** Se o dono já preencheu o modelo. Falso = a tela precisa avisar. */
  custosConfigurados: boolean;

  /**
   * PIX gerado que virou PIX pago, só nos pedidos principais.
   *
   * É a métrica mais acionável de uma oferta PIX: mede a tela do checkout, não
   * o anúncio. Cai quando o QR demora, quando o tutorial some, quando o valor
   * assusta — coisas que o ROAS registra tarde demais e sem apontar a causa.
   */
  taxaDeAprovacao: number | null;
  pixGerados: number;

  reembolsoPercentual: number | null;
  chargebackPercentual: number | null;
  ticketCentavos: number | null;

  vendasPorFonte: FatiaDoResumo[];
  formasDePagamento: FatiaDoResumo[];
}

export interface EntradaDoResumo {
  /** Já filtrados na janela pelo chamador. */
  pedidos: Order[];
  /** Já filtrado no nível campanha pelo chamador. */
  investimentos: Investimento[];
  /** Total das despesas que caem na janela (ver `despesasDaJanela`). */
  despesasCentavos: number;
  custos: Custos;
}

function acumular(mapa: Map<string, FatiaDoResumo>, chave: string, centavos: number): void {
  const atual = mapa.get(chave) ?? { chave, vendas: 0, centavos: 0 };
  atual.vendas += 1;
  atual.centavos += centavos;
  mapa.set(chave, atual);
}

export function montarResumo(entrada: EntradaDoResumo): Resumo {
  let receitaBrutaCentavos = 0;
  let vendas = 0;
  let pendentes = 0;
  let pendenteCentavos = 0;
  let devolucoes = 0;
  let devolvidoCentavos = 0;
  let contestacoes = 0;
  let contestadoCentavos = 0;
  let pixGerados = 0;
  let vendasPrincipais = 0;

  const porFonte = new Map<string, FatiaDoResumo>();
  const porMetodo = new Map<string, FatiaDoResumo>();

  for (const order of entrada.pedidos) {
    const principal = order.parentOrderId === null;

    /*
     * A taxa de aprovação olha SÓ o principal. Upsell e downsell só aparecem
     * para quem já pagou, então incluí-los misturaria duas telas diferentes e
     * puxaria a taxa para cima justamente quando o checkout principal piora.
     */
    if (principal) pixGerados += 1;

    if (order.status === 'completed') {
      receitaBrutaCentavos += order.amountCents;
      vendas += 1;
      if (principal) vendasPrincipais += 1;
      acumular(porFonte, fonteDoPedido(order), order.amountCents);
      // Pedido anterior a 17/08/2026 não tem `metodo`, e ausência quer dizer PIX.
      acumular(porMetodo, order.metodo ?? 'pix', order.amountCents);
    } else if (order.status === 'refunded') {
      devolucoes += 1;
      devolvidoCentavos += order.amountCents;
      if (ehContestacao(order)) {
        contestacoes += 1;
        contestadoCentavos += order.amountCents;
      }
    } else if (order.status === 'pending' && principal) {
      pendentes += 1;
      pendenteCentavos += order.amountCents;
    }
  }

  let investimentoCentavos = 0;
  for (const inv of entrada.investimentos) investimentoCentavos += inv.centavos;

  const custos = repartir(
    {
      receitaBrutaCentavos,
      vendas,
      devolvidoCentavos,
      devolucoes,
      investimentoCentavos,
      despesasCentavos: entrada.despesasCentavos,
    },
    entrada.custos,
  );

  const liquidacoes = vendas + devolucoes;
  const dividir = (topo: number, base: number): number | null => (base > 0 ? topo / base : null);

  return {
    receitaBrutaCentavos,
    vendas,
    pendentes,
    pendenteCentavos,
    devolucoes,
    devolvidoCentavos,
    contestacoes,
    contestadoCentavos,
    investimentoCentavos,
    temInvestimento: entrada.investimentos.length > 0,
    despesasCentavos: entrada.despesasCentavos,
    custos,
    custosConfigurados: entrada.custos.configurado,
    taxaDeAprovacao: dividir(vendasPrincipais, pixGerados),
    pixGerados,
    /*
     * A base é tudo que já foi liquidado, não só o que ficou. Dividir devoluções
     * pelas vendas que sobraram inflaria o percentual justo quando ele é alto —
     * 5 devoluções em 5 vendas restantes viraria 100%, quando foi 50%. E é
     * exatamente na faixa alta que esse número decide se a conta continua viva.
     */
    reembolsoPercentual: dividir(devolucoes, liquidacoes),
    chargebackPercentual: dividir(contestacoes, liquidacoes),
    ticketCentavos: vendas > 0 ? Math.round(receitaBrutaCentavos / vendas) : null,
    vendasPorFonte: [...porFonte.values()].sort((a, b) => b.centavos - a.centavos),
    formasDePagamento: [...porMetodo.values()].sort((a, b) => b.centavos - a.centavos),
  };
}
