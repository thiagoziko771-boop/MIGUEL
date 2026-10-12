/**
 * O que sai, para o que sobra ser verdade.
 *
 * Até aqui o painel calculava `lucro = receita - anúncio`. Faltavam a taxa do
 * gateway, o imposto sobre a venda e o imposto que a Meta cobra POR FORA do
 * gasto — e os três erram para o mesmo lado, para mais. Um lucro inflado não é
 * um relatório impreciso: é a ordem de escalar um anúncio que está empatando.
 *
 * O código antigo compensava isso com uma meta de ROAS 2x chutada — ver o
 * comentário de `CHAVE_META_ROAS` em server/routes/admin.ts, que lista
 * exatamente os custos que não entravam na conta. Com este arquivo o ponto de
 * equilíbrio deixa de ser chute e passa a ser calculado.
 *
 * Guardado como JSON em `configuracoes`, e não em tabela: são sete números que
 * mudam quando o dono troca de gateway. Mesma decisão (e mesmo motivo) do
 * cadastro de BMs em server/bms.ts.
 *
 * NADA AQUI PARTICIPA DO CAMINHO DA VENDA. Este arquivo só é lido para montar
 * tela; falhar significa um cartão vazio, nunca um cliente sem produto.
 */
import { paraCentavos } from './investimento.js';
import { logger } from './logger.js';
import { repositorioDoPainel } from './painel/repositorio.js';

export const CHAVE_CUSTOS = 'custos.modelo';
export const CHAVE_DESPESAS = 'custos.despesas';

/**
 * Os percentuais são PERCENTUAIS, não frações: `4.99` é 4,99%.
 *
 * A divisão por 100 acontece num lugar só (`fracao`, abaixo). Guardar fração
 * aqui pareceria mais limpo e seria pior: o dono digita "4,99" no painel, e
 * qualquer caminho que esquecesse de converter erraria o custo por cem vezes
 * sem nada acusar — um lucro cem vezes maior ainda parece um lucro.
 */
export interface Custos {
  /** Percentual que o gateway retém de cada transação liquidada. */
  gatewayPercentual: number;
  /** Valor fixo por transação liquidada, em centavos. */
  gatewayFixoCentavos: number;
  /** Imposto sobre a venda (Simples, MEI, o que for), em percentual do faturamento. */
  impostoSobreVendaPercentual: number;
  /**
   * Imposto que a Meta cobra por fora do gasto, em percentual do gasto.
   *
   * O campo `spend` do endpoint de insights devolve o valor do leilão SEM os
   * tributos que aparecem na fatura. Importar esse número cru e chamá-lo de
   * "gasto" subestima o custo do anúncio em todo relatório — inclusive no ROAS
   * que decide o que escalar.
   */
  impostoMetaAdsPercentual: number;
  /** Custo do produto por venda, em centavos. Digital costuma ser 0. */
  custoPorVendaCentavos: number;
  /**
   * Se alguém já preencheu isto alguma vez.
   *
   * Existe para a tela poder dizer "este lucro ignora taxa e imposto" em vez de
   * mostrar R$ 0,00 de taxa como se fosse fato. Zero configurado e zero real são
   * a mesma tela e significados opostos, e é justamente essa confusão que este
   * arquivo veio desfazer.
   */
  configurado: boolean;
}

export const CUSTOS_ZERADOS: Custos = {
  gatewayPercentual: 0,
  gatewayFixoCentavos: 0,
  impostoSobreVendaPercentual: 0,
  impostoMetaAdsPercentual: 0,
  custoPorVendaCentavos: 0,
  configurado: false,
};

/** Despesa que não é anúncio nem taxa: ferramenta, copy, editor, tráfego pago fora do Meta. */
export interface Despesa {
  id: string;
  /** AAAA-MM-DD. Para a mensal, é o dia em que passou a valer. */
  dia: string;
  descricao: string;
  centavos: number;
  /**
   * Repete todo mês (assinatura) em vez de acontecer uma vez.
   *
   * É o caso mais comum — as ferramentas do negócio são todas mensais — e sem
   * isso o dono teria de lançar a mesma linha doze vezes por ano, ou lançar uma
   * vez e ver a despesa sumir da janela de 7 dias que ele olha todo dia.
   */
  mensal: boolean;
}

const LIMITE_DE_DESPESAS = 500;

/** Percentual em fração. O único lugar que divide por 100. */
function fracao(percentual: number): number {
  return percentual / 100;
}

/**
 * Lê um percentual digitado por gente: "4,99", "4.99", "4,99%".
 *
 * Recusa o que não for número em vez de virar 0, porque 0 é um valor legítimo
 * neste campo: um typo virando "sem taxa" some no meio de uma tela de números
 * certos e infla o lucro em silêncio, que é o defeito que este módulo existe
 * para eliminar.
 */
export function paraPercentual(bruto: unknown): number | null {
  const texto = String(bruto ?? '').trim().replace('%', '').replace(',', '.');
  if (texto === '') return null;
  const n = Number.parseFloat(texto);
  // Teto de 100: taxa acima disso é dedo errado, não negócio ruim.
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function saneadorDeCustos(bruto: unknown): Custos {
  if (!bruto || typeof bruto !== 'object') return { ...CUSTOS_ZERADOS };
  const c = bruto as Record<string, unknown>;
  const num = (v: unknown, teto: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= teto ? n : 0;
  };
  return {
    gatewayPercentual: num(c.gatewayPercentual, 100),
    gatewayFixoCentavos: num(c.gatewayFixoCentavos, 100_000),
    impostoSobreVendaPercentual: num(c.impostoSobreVendaPercentual, 100),
    impostoMetaAdsPercentual: num(c.impostoMetaAdsPercentual, 100),
    custoPorVendaCentavos: num(c.custoPorVendaCentavos, 10_000_000),
    configurado: c.configurado === true,
  };
}

export async function lerCustos(): Promise<Custos> {
  try {
    const guardado = await repositorioDoPainel().lerConfiguracao(CHAVE_CUSTOS);
    if (!guardado) return { ...CUSTOS_ZERADOS };
    return saneadorDeCustos(JSON.parse(guardado));
  } catch (erro) {
    logger.error('Falha ao ler o modelo de custos', { erro: (erro as Error).message });
    return { ...CUSTOS_ZERADOS };
  }
}

export async function salvarCustos(entrada: Partial<Custos>): Promise<Custos> {
  const atual = await lerCustos();
  const novo = saneadorDeCustos({ ...atual, ...entrada, configurado: true });
  await repositorioDoPainel().salvarConfiguracao(CHAVE_CUSTOS, JSON.stringify(novo));
  return novo;
}

function saneadorDeDespesa(bruto: unknown): Despesa | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const d = bruto as Record<string, unknown>;

  const dia = String(d.dia ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;

  const centavos = typeof d.centavos === 'number' ? Math.round(d.centavos) : paraCentavos(String(d.centavos ?? ''));
  if (centavos === null || centavos < 0) return null;

  const descricao = String(d.descricao ?? '').trim().slice(0, 120);
  if (descricao === '') return null;

  return {
    id: String(d.id ?? '').trim().slice(0, 40) || `d${dia.replace(/-/g, '')}${centavos}${descricao.length}`,
    dia,
    descricao,
    centavos,
    mensal: d.mensal === true,
  };
}

export async function listarDespesas(): Promise<Despesa[]> {
  try {
    const guardado = await repositorioDoPainel().lerConfiguracao(CHAVE_DESPESAS);
    if (!guardado) return [];
    const bruto = JSON.parse(guardado);
    if (!Array.isArray(bruto)) return [];
    return bruto.map(saneadorDeDespesa).filter((d): d is Despesa => d !== null);
  } catch (erro) {
    logger.error('Falha ao ler as despesas', { erro: (erro as Error).message });
    return [];
  }
}

export async function salvarDespesas(bruto: unknown): Promise<Despesa[]> {
  const lista = Array.isArray(bruto) ? bruto : [];
  const limpas = lista.map(saneadorDeDespesa).filter((d): d is Despesa => d !== null).slice(0, LIMITE_DE_DESPESAS);
  await repositorioDoPainel().salvarConfiguracao(CHAVE_DESPESAS, JSON.stringify(limpas));
  return limpas;
}

/**
 * Quanto das despesas cai dentro da janela olhada.
 *
 * A mensal é rateada por dia (÷30) em vez de contar inteira. Contar inteira faria
 * a assinatura de R$ 300 aparecer como R$ 300 tanto na janela de 30 dias quanto na
 * de 1 — e o painel diria que a terça-feira deu prejuízo por causa de uma conta
 * que se paga no mês. Rateio de mês comercial (30) e não do mês de calendário
 * porque a janela do painel é "últimos N dias", que não respeita virada de mês.
 */
export function despesasDaJanela(despesas: Despesa[], desde: string, ate: string): number {
  const dias = Math.max(1, Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1);
  let total = 0;
  for (const d of despesas) {
    if (d.mensal) {
      // Só depois de passar a valer: assinatura contratada ontem não cobra o mês passado.
      if (d.dia <= ate) total += Math.round((d.centavos / 30) * dias);
    } else if (d.dia >= desde && d.dia <= ate) {
      total += d.centavos;
    }
  }
  return total;
}

/** Os números brutos que a janela produziu, antes de qualquer custo. */
export interface BrutosDoPeriodo {
  /** Pago e que FICOU — reembolso e chargeback já fora. */
  receitaBrutaCentavos: number;
  /** Transações pagas que ficaram. */
  vendas: number;
  /** Valor devolvido ao cliente, por reembolso ou chargeback. */
  devolvidoCentavos: number;
  /** Transações devolvidas. Entram na taxa: elas foram liquidadas um dia. */
  devolucoes: number;
  investimentoCentavos: number;
  despesasCentavos: number;
}

export interface Reparticao {
  /** Taxa do gateway sobre tudo que foi liquidado, devolvido ou não. */
  taxasCentavos: number;
  impostoSobreVendasCentavos: number;
  custosProdutoCentavos: number;
  /** O que a Meta cobra por fora do `spend`. */
  impostoMetaAdsCentavos: number;
  /** Anúncio + imposto do anúncio: o que de fato saiu para comprar tráfego. */
  gastoTotalCentavos: number;
  impostoTotalCentavos: number;
  /** O que sobra da receita depois de taxa, imposto e custo de produto. */
  receitaLiquidaCentavos: number;
  lucroCentavos: number;
  /**
   * Receita ÷ gasto do LEILÃO, sem o imposto do anúncio.
   *
   * A base é o número que aparece no Gerenciador de Anúncios de propósito: é
   * contra ele que o dono compara, é ele que a aba Anúncios usa, e um ROAS que
   * significasse outra coisa em cada tela seria pior do que não ter ROAS. O
   * imposto do anúncio continua descontado — mas no lucro, no ROI e na margem,
   * que é onde ele pertence.
   *
   * `null` sem gasto: dividir por zero não é infinito, é "não dá para saber".
   */
  roas: number | null;
  /** Lucro ÷ gasto TOTAL, imposto do anúncio incluído. O retorno de cada real que saiu. */
  roi: number | null;
  /** Lucro ÷ receita bruta. */
  margem: number | null;
}

/**
 * A conta inteira, num lugar só.
 *
 * Sem banco e sem I/O, de propósito: é o que permite conferir cada centavo com
 * números fixos em scripts/testar-custos.mjs. Uma aritmética de dinheiro que só
 * pode ser testada contra o banco de produção não é testada.
 */
export function repartir(brutos: BrutosDoPeriodo, custos: Custos): Reparticao {
  const liquidadoCentavos = brutos.receitaBrutaCentavos + brutos.devolvidoCentavos;
  const liquidacoes = brutos.vendas + brutos.devolucoes;

  /*
   * A taxa incide sobre TUDO que foi liquidado, inclusive o que depois voltou.
   *
   * É a leitura conservadora: gateway nenhum devolve a própria taxa quando o
   * cliente é reembolsado, e nas poucas vezes em que devolve o painel erra
   * mostrando lucro a MENOS. Errar para menos manda esperar; errar para mais
   * manda escalar — e só um dos dois custa dinheiro.
   */
  const taxasCentavos = Math.round(
    liquidadoCentavos * fracao(custos.gatewayPercentual) + liquidacoes * custos.gatewayFixoCentavos,
  );

  /* Imposto só sobre o que ficou: venda devolvida não é faturamento. */
  const impostoSobreVendasCentavos = Math.round(brutos.receitaBrutaCentavos * fracao(custos.impostoSobreVendaPercentual));
  const custosProdutoCentavos = brutos.vendas * custos.custoPorVendaCentavos;
  const impostoMetaAdsCentavos = Math.round(brutos.investimentoCentavos * fracao(custos.impostoMetaAdsPercentual));

  const gastoTotalCentavos = brutos.investimentoCentavos + impostoMetaAdsCentavos;
  const impostoTotalCentavos = impostoSobreVendasCentavos + impostoMetaAdsCentavos;
  const receitaLiquidaCentavos =
    brutos.receitaBrutaCentavos - taxasCentavos - impostoSobreVendasCentavos - custosProdutoCentavos;
  const lucroCentavos = receitaLiquidaCentavos - gastoTotalCentavos - brutos.despesasCentavos;

  const dividir = (topo: number, base: number): number | null => (base > 0 ? topo / base : null);

  return {
    taxasCentavos,
    impostoSobreVendasCentavos,
    custosProdutoCentavos,
    impostoMetaAdsCentavos,
    gastoTotalCentavos,
    impostoTotalCentavos,
    receitaLiquidaCentavos,
    lucroCentavos,
    roas: dividir(brutos.receitaBrutaCentavos, brutos.investimentoCentavos),
    roi: dividir(lucroCentavos, gastoTotalCentavos),
    margem: dividir(lucroCentavos, brutos.receitaBrutaCentavos),
  };
}

/**
 * Quanto a receita precisa cobrir o gasto do leilão para o anúncio empatar.
 *
 * Substitui a meta de ROAS chutada em 2x. Com taxa de 5%, imposto de 6% e
 * imposto de anúncio de 8%, o empate real fica em ~1,21x — escalar só a partir
 * de 2x estava deixando anúncio lucrativo parado. Com taxa de 12% e imposto de
 * 15%, o empate passa de 1,4x e o 2x estava certo. O chute acertava por acaso,
 * e só num dos dois casos.
 *
 * A base é a MESMA do campo `roas` de `repartir` — o gasto do leilão, sem o
 * imposto do anúncio. Ter as duas em bases diferentes é o defeito mais fácil de
 * cometer aqui: a tela mostraria "ROAS 1,4x · empata em 1,3x" com o anúncio
 * dando prejuízo, e o número que pareceu certo mandaria escalar.
 */
export function roasDeEquilibrio(custos: Custos, ticketCentavos: number): number | null {
  const sobraPorReal =
    1 - fracao(custos.gatewayPercentual) - fracao(custos.impostoSobreVendaPercentual)
    - (ticketCentavos > 0 ? (custos.gatewayFixoCentavos + custos.custoPorVendaCentavos) / ticketCentavos : 0);

  // Ticket que não cobre nem a taxa fixa: não existe ROAS que salve.
  if (sobraPorReal <= 0) return null;

  return (1 + fracao(custos.impostoMetaAdsPercentual)) / sobraPorReal;
}
