/**
 * Fechamento diário — a aba Relatórios do painel (15/08/2026).
 *
 * Uma linha por dia-calendário em São Paulo, com o que entrou (receita), o
 * que saiu (anúncio) e o caminho no meio (visitas → quiz → VSL → checkout →
 * PIX → venda). É a resposta à pergunta que o dono faz toda noite: "o dia
 * pagou o anúncio?".
 *
 * Só cálculo, sem banco: o roteador junta pedidos, funil por dia e
 * investimento e entrega aqui. Assim o número é testável com um relógio
 * fixo (scripts/testar-fechamento.mjs) e nunca diverge da aba Anúncios —
 * as duas contam venda pelo MESMO critério.
 */

import { diaLocal, somarDias } from './periodo.js';
import type { FunilDoDia, Investimento } from './painel/repositorio.js';
import type { Order } from './store/index.js';

export interface LinhaDoFechamento {
  /** AAAA-MM-DD em São Paulo. */
  dia: string;
  /** Hoje ainda está correndo: os números sobem até a meia-noite. */
  parcial: boolean;

  /** Anúncio, nível campanha, em centavos. */
  investidoCentavos: number;
  /** Se algum gasto foi registrado no dia. Zero sem registro ≠ zero de verdade. */
  temInvestimento: boolean;

  visitas: number;
  quiz: number;
  vsl: number;
  checkout: number;

  /** Pedidos PRINCIPAIS criados no dia (upsell/downsell não contam). */
  pixGerados: number;
  /** Principais pagos. */
  vendas: number;
  /** Upsell/downsell pagos. */
  upsellsPagos: number;
  /** Principais ainda aguardando pagamento (PIX vivo). */
  pendentes: number;
  /** Tudo que foi pago, em centavos — principal, bumps, upsell e downsell. */
  receitaCentavos: number;

  /* Derivados — `null` quando o divisor é zero. */
  lucroCentavos: number;
  roas: number | null;
  /** Custo por venda. */
  cpaCentavos: number | null;
  /** Custo por visita. */
  cpvCentavos: number | null;
  ticketCentavos: number | null;
  /** Visita → PIX gerado. */
  taxaPix: number | null;
  /** PIX gerado → pago. */
  taxaPagamento: number | null;
  /** Visita → venda. */
  conversao: number | null;
}

export interface Fechamento {
  hoje: string;
  dias: LinhaDoFechamento[];
  totais: LinhaDoFechamento;
  /** Só os dias fechados (sem hoje): é o que se compara com honestidade. */
  totaisFechados: LinhaDoFechamento;
  /**
   * O melhor dia fechado com venda, para dar régua: "hoje está pior/melhor
   * que o seu melhor dia".
   */
  melhorDia: string | null;
}

function linhaVazia(dia: string, parcial: boolean): LinhaDoFechamento {
  return {
    dia,
    parcial,
    investidoCentavos: 0,
    temInvestimento: false,
    visitas: 0,
    quiz: 0,
    vsl: 0,
    checkout: 0,
    pixGerados: 0,
    vendas: 0,
    upsellsPagos: 0,
    pendentes: 0,
    receitaCentavos: 0,
    lucroCentavos: 0,
    roas: null,
    cpaCentavos: null,
    cpvCentavos: null,
    ticketCentavos: null,
    taxaPix: null,
    taxaPagamento: null,
    conversao: null,
  };
}

function razao(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

/** Recalcula os derivados a partir dos brutos. Chamado por linha e nos totais. */
function derivar(linha: LinhaDoFechamento): LinhaDoFechamento {
  linha.lucroCentavos = linha.receitaCentavos - linha.investidoCentavos;
  linha.roas = linha.investidoCentavos > 0 ? linha.receitaCentavos / linha.investidoCentavos : null;
  linha.cpaCentavos = linha.vendas > 0 && linha.investidoCentavos > 0 ? Math.round(linha.investidoCentavos / linha.vendas) : null;
  linha.cpvCentavos = linha.visitas > 0 && linha.investidoCentavos > 0 ? Math.round(linha.investidoCentavos / linha.visitas) : null;
  linha.ticketCentavos = linha.vendas > 0 ? Math.round(linha.receitaCentavos / linha.vendas) : null;
  linha.taxaPix = razao(linha.pixGerados, linha.visitas);
  linha.taxaPagamento = razao(linha.vendas, linha.pixGerados);
  linha.conversao = razao(linha.vendas, linha.visitas);
  return linha;
}

function somar(destino: LinhaDoFechamento, origem: LinhaDoFechamento): void {
  destino.investidoCentavos += origem.investidoCentavos;
  destino.temInvestimento = destino.temInvestimento || origem.temInvestimento;
  destino.visitas += origem.visitas;
  destino.quiz += origem.quiz;
  destino.vsl += origem.vsl;
  destino.checkout += origem.checkout;
  destino.pixGerados += origem.pixGerados;
  destino.vendas += origem.vendas;
  destino.upsellsPagos += origem.upsellsPagos;
  destino.pendentes += origem.pendentes;
  destino.receitaCentavos += origem.receitaCentavos;
}

export interface EntradaDoFechamento {
  /** Quantos dias, terminando hoje. */
  dias: number;
  agoraMs: number;
  /** Pedidos desde o começo do primeiro dia. Fora da janela são ignorados. */
  pedidos: Order[];
  funil: FunilDoDia[];
  /** Já filtrado no nível campanha pelo chamador. */
  investimentos: Investimento[];
}

export function montarFechamento(entrada: EntradaDoFechamento): Fechamento {
  const hoje = diaLocal(entrada.agoraMs);
  const quantos = Number.isFinite(entrada.dias) && entrada.dias > 0 && entrada.dias <= 90 ? Math.floor(entrada.dias) : 14;
  const primeiro = somarDias(hoje, -(quantos - 1));

  // Todas as linhas existem, mesmo os dias sem nada — o zero é informação
  // ("o anúncio ficou pausado"), e um buraco na tabela parece defeito.
  const porDia = new Map<string, LinhaDoFechamento>();
  for (let i = 0; i < quantos; i += 1) {
    const dia = somarDias(primeiro, i);
    porDia.set(dia, linhaVazia(dia, dia === hoje));
  }
  const pegar = (dia: string): LinhaDoFechamento | undefined => porDia.get(dia);

  for (const f of entrada.funil) {
    const linha = pegar(f.dia);
    if (!linha) continue;
    linha.visitas += f.visitas;
    linha.quiz += f.quiz;
    linha.vsl += f.vsl;
    linha.checkout += f.checkout;
  }

  for (const inv of entrada.investimentos) {
    const linha = pegar(inv.dia);
    if (!linha) continue;
    linha.investidoCentavos += inv.centavos;
    linha.temInvestimento = true;
  }

  /*
   * O pedido cai no dia em que foi CRIADO — o mesmo critério da aba Anúncios,
   * para os dois relatórios nunca discordarem sobre quantas vendas o dia teve.
   * É também o dia do anúncio que trouxe a pessoa; pagar cinco minutos depois
   * da meia-noite não muda qual verba pagou por ela.
   */
  for (const order of entrada.pedidos) {
    const linha = pegar(diaLocal(Date.parse(order.createdAt)));
    if (!linha) continue;

    const principal = order.parentOrderId === null;
    const pago = order.status === 'completed';

    if (principal) {
      linha.pixGerados += 1;
      if (pago) linha.vendas += 1;
      else if (order.status === 'pending') linha.pendentes += 1;
    } else if (pago) {
      linha.upsellsPagos += 1;
    }
    if (pago) linha.receitaCentavos += order.amountCents;
  }

  const dias = [...porDia.values()].map(derivar).sort((a, b) => b.dia.localeCompare(a.dia));

  const totais = linhaVazia(`${primeiro}..${hoje}`, true);
  const totaisFechados = linhaVazia(`${primeiro}..${somarDias(hoje, -1)}`, false);
  for (const linha of dias) {
    somar(totais, linha);
    if (!linha.parcial) somar(totaisFechados, linha);
  }
  derivar(totais);
  derivar(totaisFechados);

  let melhorDia: string | null = null;
  let melhorLucro = Number.NEGATIVE_INFINITY;
  for (const linha of dias) {
    if (linha.parcial || linha.vendas === 0) continue;
    if (linha.lucroCentavos > melhorLucro) {
      melhorLucro = linha.lucroCentavos;
      melhorDia = linha.dia;
    }
  }

  return { hoje, dias, totais, totaisFechados, melhorDia };
}

/**
 * O fechamento de um dia em texto corrido, do jeito que se manda no WhatsApp
 * ou no Telegram. É o "copiar resumo" da tela.
 */
export function textoDoFechamento(linha: LinhaDoFechamento): string {
  const brl = (c: number): string => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')}%`);
  const [ano, mes, dia] = linha.dia.split('-');
  const rotulo = linha.dia.includes('..') ? linha.dia : `${dia}/${mes}/${ano}`;

  const partes = [
    `📊 Fechamento ${rotulo}${linha.parcial ? ' (parcial)' : ''}`,
    `💸 Investido: ${linha.temInvestimento ? brl(linha.investidoCentavos) : 'não registrado'}`,
    `💰 Receita: ${brl(linha.receitaCentavos)} · ${linha.vendas} venda${linha.vendas === 1 ? '' : 's'}${linha.upsellsPagos ? ` (+${linha.upsellsPagos} upsell)` : ''}`,
    `📈 Lucro: ${brl(linha.lucroCentavos)}${linha.roas !== null ? ` · ROAS ${linha.roas.toFixed(2).replace('.', ',')}x` : ''}`,
    `👣 Visitas ${linha.visitas} → quiz ${linha.quiz} → VSL ${linha.vsl} → checkout ${linha.checkout} → PIX ${linha.pixGerados}`,
    `🎯 Visita→PIX ${pct(linha.taxaPix)} · PIX→pago ${pct(linha.taxaPagamento)} · conversão ${pct(linha.conversao)}`,
  ];
  if (linha.cpaCentavos !== null) partes.push(`🧾 Custo por venda ${brl(linha.cpaCentavos)} · ticket ${brl(linha.ticketCentavos ?? 0)}`);
  if (linha.pendentes) partes.push(`⏳ ${linha.pendentes} PIX ainda aguardando`);
  return partes.join('\n');
}
