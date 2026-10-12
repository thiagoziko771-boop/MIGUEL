import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { chaveDoGrupo, type AgrupamentoDeAnuncio, type Atribuicao } from '../atribuicao.js';
import { CATALOG } from '../catalog.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ehPedidoDeOracao, PREFIXO_SQL_PEDIDO } from '../pedidoDeOracao.js';
import { diaLocal, FUSO_DO_PAINEL } from '../periodo.js';
import { newId } from '../utils.js';

/**
 * Dados que só o painel usa: links de entrega, histórico de alteração e o log
 * dos callbacks recebidos. Ficam fora do OrderStore de propósito, porque nada
 * disso participa do caminho da venda: um problema aqui não pode derrubar um
 * checkout.
 *
 * Duas implementações, pelo mesmo motivo do OrderStore: Postgres em produção e
 * memória no desenvolvimento sem banco. A de memória some a cada reinício e
 * serve só para mexer na tela.
 */

export type TipoEntrega = 'arquivo' | 'acesso' | 'servico';

export const TIPOS_DE_ENTREGA: TipoEntrega[] = ['arquivo', 'acesso', 'servico'];

export const ROTULO_DO_TIPO: Record<TipoEntrega, string> = {
  arquivo: 'Arquivo para baixar',
  acesso: 'Acesso a plataforma',
  servico: 'Serviço, sem link',
};

export interface LinkDeEntrega {
  itemId: string;
  nome: string;
  url: string;
  ativo: boolean;
  tipo: TipoEntrega;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  /** De onde veio o valor atual: o painel, a variável de ambiente ou nada. */
  origem: 'painel' | 'ambiente' | 'vazio';
}

export interface MudancaDeEntrega {
  t: string;
  itemId: string;
  campo: string;
  de: string | null;
  para: string | null;
  por: string;
}

export interface WebhookRecebido {
  id: number;
  t: string;
  evento: string | null;
  cobrancaId: string | null;
  pedidoId: string | null;
  statusInformado: string | null;
  statusConfirmado: string | null;
  resultado: string;
  detalhe: string | null;
}

export interface EventoDePedido {
  t: string;
  pedidoId: string;
  evento: string;
  origem: string | null;
  detalhe: string | null;
}

/* -------------------------------------------------------------------------- */
/* Rastreamento                                                                */
/* -------------------------------------------------------------------------- */

export interface EventoDoFunil {
  sessionId: string;
  pedidoId?: string | null;
  evento: string;
  step?: number | null;
  url?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  atribuicao: Atribuicao;
  /** Texto da pergunta do quiz e da opção escolhida, quando houver. */
  pergunta?: string | null;
  resposta?: string | null;
}

/**
 * Etapas do funil por anúncio, contadas por SESSÃO e de forma cumulativa.
 *
 * Cada sessão entra pela etapa mais longe que alcançou, e conta também em todas
 * as anteriores. Contar evento por evento — o que se fazia antes — produzia
 * funil invertido: um `PageView` perdido (bloqueador, aba fechada antes de a
 * requisição sair, rede de celular caindo no meio) tirava a pessoa da coluna
 * Visitas e a deixava na coluna Quiz, e a tela mostrava "1 visita, 3 no quiz",
 * 300 % de passagem. Quem terminou o quiz visitou o site; isso não é inferência,
 * é a única leitura possível.
 */
/** Uma linha da aba BMs: o topo do funil de um gerenciador. */
export interface ContagemPorBm {
  /** O carimbo `bm=` da URL. String vazia = visita sem BM identificada. */
  bm: string;
  visitas: number;
  quiz: number;
  vsl: number;
  checkout: number;
}

export interface EtapasDoFunil {
  /** Chave do grupo — o ID do anúncio. Vazia quando o clique veio sem carimbo. */
  chave: string;
  /** Nome legível vindo do `utm_*`, para o painel não mostrar só números. */
  nome: string | null;
  fonte: string | null;
  /** Havia identificador do Meta nesse grupo? Separa Facebook de Google. */
  temFacebook: boolean;
  /** Sessões que abriram o site — qualquer evento registrado já conta. */
  visitas: number;
  /** Chegaram ao fim das 9 perguntas. */
  quiz: number;
  /** Chegaram à tela da VSL. */
  vsl: number;
  /** Abriram o checkout (ou já preencheram os dados, ou já viram o QR). */
  checkout: number;
}

/**
 * A que altura do funil cada evento coloca a sessão.
 *
 * `Lead` e `AddPaymentInfo` não ganham degrau próprio: os dois acontecem com o
 * checkout já aberto, e é como checkout que precisam contar. Sem isso, quem
 * digitou o nome mas cujo `InitiateCheckout` se perdeu no caminho sumiria da
 * coluna que mede exatamente a intenção de comprar.
 *
 * ATENÇÃO: esta tabela é espelhada num `CASE` dentro das consultas SQL de
 * `contarFunil`, porque a contagem é agregada no banco. Evento novo precisa
 * entrar nos DOIS lugares — só aqui, e o Postgres o trata como degrau 0; só no
 * SQL, e o painel em memória (desenvolvimento e testes) discorda da produção.
 */
export const ESTAGIO_DO_EVENTO: Record<string, number> = {
  PageView: 1,
  CompleteRegistration: 2,
  ViewContent: 3,
  InitiateCheckout: 4,
  Lead: 4,
  AddPaymentInfo: 4,
};

/**
 * Uma sessão do funil, reduzida ao que a aba Funil precisa saber dela.
 *
 * A agregação acontece no banco e o que sai daqui é sempre pequeno: são no
 * máximo 14 linhas (uma por etapa), e não uma por visitante. Trazer sessão a
 * sessão para somar em memória custaria megabytes na função serverless num dia
 * de tráfego bom — justamente o dia em que o dono mais abre esta tela.
 */
export interface EtapaDoQuiz {
  /** 0 a 13, na ordem das telas de src/App.tsx. */
  step: number;
  /** Sessões que chegaram ATÉ esta tela (cumulativo). */
  alcancaram: number;
  /** Sessões cuja última tela foi esta — ou seja, pararam aqui. */
  pararam: number;
}

export interface ResumoDoFunil {
  /** Sessões distintas no período, com qualquer evento registrado. */
  sessoes: number;
  /**
   * Sessões que registraram alguma tela do MEIO do funil (1 a 11).
   *
   * Existe para a tela saber quando não pode afirmar nada sobre o quiz. As
   * telas intermediárias só passaram a mandar evento em 11/08/2026; antes
   * disso, o funil marcava entrada, fim do quiz e VSL, e mais nada. Uma visita
   * antiga tem etapa máxima 12, então o acumulado a distribui por todas as
   * perguntas — e a tela mostraria as nove com o mesmo número, como se ninguém
   * jamais tivesse desistido no meio do quiz.
   *
   * Isso não é um número errado: é a melhor leitura possível de um dado que não
   * existe. Mas parece uma afirmação forte ("o quiz não perde ninguém") e
   * mandaria o dono procurar problema no lugar errado. Daí a tela avisar.
   */
  sessoesComTelasDoMeio: number;
  etapas: EtapaDoQuiz[];
  /**
   * Sessões paradas há 30 min ou mais, por última etapa, sem pedido pago.
   *
   * Separado de `pararam` porque as duas respondem coisas diferentes: quem
   * parou na pergunta 3 há dez minutos pode estar respondendo agora. Chamar
   * isso de abandono infla o problema e manda o dono mexer numa tela que talvez
   * esteja funcionando.
   */
  abandono: Array<{ step: number; sessoes: number }>;
  /** Medianas em segundos. `null` quando não houve caso suficiente. */
  tempos: {
    /** Da primeira tela até a última registrada, para quem chegou à oferta. */
    ateAOfertaS: number | null;
    /** Da entrada até o QR aparecer. */
    ateOPixS: number | null;
  };
}

/** Uma linha do fechamento: quantas sessões começaram no dia e até onde foram. */
export interface FunilDoDia {
  /** AAAA-MM-DD em São Paulo. */
  dia: string;
  visitas: number;
  quiz: number;
  vsl: number;
  checkout: number;
}

/**
 * Em que nível a chave do gasto foi medida.
 *
 * Existe porque o mesmo dinheiro aparece três vezes no Gerenciador de Anúncios:
 * uma por campanha, uma por conjunto e uma por anúncio. Importar os três é o que
 * faz a coluna "Investido" aparecer em qualquer agrupamento que o dono escolher
 * — mas sem esta marca eles se somariam, e o total mostraria três vezes o que
 * foi gasto de verdade. Um erro desses não aparece na tela como erro: aparece
 * como um ROAS três vezes pior, e a decisão que sai dele é desligar um anúncio
 * que estava lucrando.
 */
export type NivelDeInvestimento = 'campanha' | 'conjunto' | 'anuncio';

/** Quanto foi gasto num anúncio, digitado à mão ou importado. */
export interface Investimento {
  chave: string;
  dia: string;
  /**
   * De qual gerenciador saiu este gasto. Vazio no que não sabe.
   *
   * Sem isto o painel consegue dizer quanto CADA BM faturou, mas não quanto cada
   * uma gastou — e receita sem custo ao lado é o número que faz escalar a conta
   * errada. Fica vazio no gasto digitado à mão e no importado da planilha, que
   * não têm como saber a conta de origem; só a importação por conta de anúncios
   * carimba.
   */
  bm?: string;
  /** Ausente no que foi digitado antes desta coluna existir: vale `campanha`. */
  nivel?: NivelDeInvestimento;
  centavos: number;
  /**
   * Impressões e cliques da plataforma, no mesmo dia e na mesma campanha.
   *
   * Sem eles não existe CTR, CPM nem CPC: essas três medem o que acontece
   * ANTES de a pessoa chegar no site, e o nosso banco só enxerga quem chegou.
   * Um anúncio caro que ninguém clica e um anúncio barato que todo mundo clica
   * e ninguém compra produzem o mesmo número de visitas por real gasto — e
   * pedem decisões opostas (trocar o criativo x trocar a página).
   */
  impressoes: number;
  cliques: number;
}

export interface EnvioMeta {
  id: number;
  t: string;
  pedidoId: string | null;
  evento: string;
  eventId: string;
  statusHttp: number | null;
  resposta: string | null;
  tentativas: number;
  sucesso: boolean;
  /**
   * Chaves de `user_data` que foram no evento (em, ph, fbc, fbp, ip, ua...),
   * sem valor nenhum. `null` nos envios anteriores a 15/08/2026, quando isso
   * não era guardado.
   */
  chaves: string[] | null;
}

/* -------------------------------------------------------------------------- */
/* Padrões do catálogo                                                         */
/* -------------------------------------------------------------------------- */

/** Natureza de cada produto. A vela é um ritual: não existe link para entregar. */
const TIPO_PADRAO: Record<string, TipoEntrega> = {
  main: 'arquivo',
  salmos_150: 'arquivo',
  vela_7dias: 'servico',
  upsell: 'acesso',
  downsell: 'acesso',
};

function urlDoAmbiente(itemId: string): string {
  return (process.env[`DELIVERY_URL_${itemId.toUpperCase()}`] ?? '').trim();
}

function padraoDoItem(itemId: string): LinkDeEntrega {
  const doAmbiente = urlDoAmbiente(itemId);
  return {
    itemId,
    nome: CATALOG[itemId]?.title ?? itemId,
    url: doAmbiente,
    ativo: true,
    tipo: TIPO_PADRAO[itemId] ?? 'arquivo',
    atualizadoEm: null,
    atualizadoPor: null,
    origem: doAmbiente ? 'ambiente' : 'vazio',
  };
}

/* -------------------------------------------------------------------------- */
/* Contrato                                                                    */
/* -------------------------------------------------------------------------- */

/** Uma opção do quiz, com quantas pessoas escolheram e quantas dessas compraram. */
export interface RespostaDoQuiz {
  pergunta: string;
  resposta: string;
  pessoas: number;
  compraram: number;
}

export interface EventoDaSessao {
  sessionId: string;
  /** ISO. */
  t: string;
  evento: string;
  step: number | null;
  pedidoId: string | null;
  pergunta: string | null;
  resposta: string | null;
  atribuicao: Atribuicao;
}

export interface SessaoResumida {
  sessionId: string;
  primeiroEm: string;
  ultimoEm: string;
  stepMaximo: number;
  temPedidoDeOracao: boolean;
}

export interface NotaCrm {
  id: string;
  sessao: string;
  autor: string;
  texto: string;
  criadaEm: string;
}

export interface MarcacaoCrm {
  sessao: string;
  statusManual: string | null;
  optOut: boolean;
  contatadoEm: string | null;
  atualizadaEm: string;
}

/**
 * Uma linha da auditoria (aba Acessos, 15/08/2026): quem fez o quê, quando,
 * de onde. `papel` é 'dono' | 'equipe' | 'anonimo' | 'cliente' — cliente é
 * quem abriu a página de entrega ou o link de escolha.
 */
export interface RegistroDeAuditoria {
  id: string;
  /** ISO. */
  t: string;
  papel: string;
  ip: string | null;
  acao: string;
  alvo: string | null;
  detalhe: string | null;
  status: number | null;
}

export interface PedidoDeOracaoBruto {
  sessionId: string;
  /** ISO. */
  quando: string;
  /** O JSON empacotado pela tela (nome, email, tel, pedido) — cru. */
  resposta: string;
  utmContent: string | null;
  fbAdId: string | null;
}

/**
 * Em que ponto está um pedido de boleto. Quem move essa agulha é o dono, à mão,
 * na aba Boletos — não existe webhook nenhum deste lado.
 *
 *  - `pedido`   a pessoa preencheu os dados e foi para o WhatsApp. É o único
 *               estado que o site cria sozinho.
 *  - `gerado`   o boleto foi emitido no outro gateway e mandado para ela.
 *  - `pago`     compensou. É o estado que manda a compra ao Meta.
 *  - `nao_pago` venceu, desistiu, sumiu. Fica registrado de propósito: é a
 *               diferença entre "ninguém quis boleto" e "todo mundo quis e
 *               ninguém pagou", e as duas pedem decisões opostas.
 */
export type SituacaoDoBoleto = 'pedido' | 'gerado' | 'pago' | 'nao_pago';

export const SITUACOES_DO_BOLETO: SituacaoDoBoleto[] = ['pedido', 'gerado', 'pago', 'nao_pago'];

/**
 * Um pedido de boleto, do clique no checkout até o dono marcar o desfecho.
 *
 * Tabela própria, e não um `Order` com `metodo: 'boleto'`, por uma razão só: o
 * boleto aqui é OFFLINE. Não há cobrança em gateway nenhum, ninguém consulta
 * status, e o pedido não pode entrar nas contas de PIX pendente, nem receber
 * lembrete de "seu PIX expirou", nem ser varrido pelo expirador. Misturar os
 * dois faria o painel cobrar por um PIX que nunca existiu.
 *
 * Guarda o CPF inteiro de propósito: quem emite o boleto à mão precisa dele, e
 * é exatamente esse o serviço que esta tela presta. Só sai por rota com senha
 * de dono.
 */
export interface PedidoDeBoletoRegistrado {
  id: string;
  /** ISO. */
  criadoEm: string;
  atualizadoEm: string;
  /** Sessão do funil, quando o navegador mandou. Liga este pedido ao CRM. */
  sessao: string | null;
  nome: string;
  email: string;
  /** Só dígitos, com DDD. Vazio quando a pessoa não preencheu. */
  telefone: string | null;
  /** CPF, só dígitos. Sem ele não existe boleto. */
  documento: string;
  /** Calculado pelo catálogo do servidor. Nunca vem do navegador. */
  valorCentavos: number;
  itemIds: string[];
  situacao: SituacaoDoBoleto;
  /** Anotação do dono: número do boleto, o que combinaram, por que não pagou. */
  observacao: string | null;
  geradoEm: string | null;
  pagoEm: string | null;
  naoPagoEm: string | null;
  /**
   * De qual anúncio veio. É o que permite mandar a compra ao Meta com o clique
   * original (`fbc`) e o que faz esta venda aparecer no criativo que a pagou.
   */
  atribuicao: Atribuicao;
  ip: string | null;
  userAgent: string | null;
  /** Identificador do Purchase mandado ao Meta, quando já foi mandado. */
  metaEventId: string | null;
  metaEnviadoEm: string | null;
}

/**
 * Uma venda confirmada, com a origem achatada em campos.
 *
 * NÃO CARREGA DADO PESSOAL: nome, e-mail, telefone e CPF ficam no pedido, que é
 * onde servem para atender o cliente. Aqui só entra o que responde "de qual
 * anúncio veio esta venda". Resposta de quiz e qualquer inferência sobre a
 * pessoa estão fora por decisão explícita — ver server/mensuracao.ts.
 */
export interface ConversaoRegistrada {
  orderId: string;
  paidAt: string;
  valorCentavos: number;
  moeda: string;
  metodo: string;
  itemIds: string[];
  fbclid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  utmId: string | null;
  fbCampaignId: string | null;
  fbAdsetId: string | null;
  fbAdId: string | null;
  fbPlacement: string | null;
  fbSource: string | null;
  gclid: string | null;
  ttclid: string | null;
  ttCampaignId: string | null;
  ttAdgroupId: string | null;
  ttAdId: string | null;
  ttPlacement: string | null;
  bm: string | null;
  landingUrl: string | null;
  referrer: string | null;
  sessionId: string | null;
  /**
   * Quando esta conversão foi levada para uma exportação do Meta.
   *
   * `null` = nunca saiu. Existe para a segunda barreira contra importar duas
   * vezes: a primeira é o `order_id` no arquivo, que o Meta usa para deduplicar
   * do lado dele; esta é a nossa, e é a que responde "o que eu ainda não
   * mandei?" sem depender de o dono lembrar qual arquivo já subiu.
   */
  exportadoMetaEm?: string | null;
}

/**
 * Um lote de exportação para o Meta.
 *
 * O LOTE NASCE NO DOWNLOAD, MAS SÓ CONTA DEPOIS DA CONFIRMAÇÃO — e essa
 * separação é a razão de a tabela existir. Baixar um arquivo não quer dizer que
 * ele foi carregado no Gerenciador: o dono pode ver um erro, fechar a aba,
 * baixar de novo amanhã. Se o download marcasse, aquelas vendas sumiriam da
 * fila de "ainda não mandei" sem nunca terem chegado ao Meta, e ninguém
 * descobriria — o número simplesmente ficaria menor para sempre.
 *
 * `orderIds` é a lista congelada do que estava no arquivo. Sem ela, confirmar
 * "o lote de ontem" marcaria o que estivesse na consulta HOJE, que já inclui
 * vendas que nunca entraram naquele CSV.
 */
export interface LoteDeExportacao {
  batchId: string;
  criadoEm: string;
  criadoPor: string;
  desde: string | null;
  ate: string | null;
  apenasNovas: boolean;
  orderIds: string[];
  quantidade: number;
  /** `null` enquanto o dono não confirmar que subiu o arquivo. */
  confirmadoEm: string | null;
  confirmadoPor: string | null;
}

/** Uma linha de `exportacoes_meta` virando objeto. Usada pelos quatro métodos. */
function loteDaLinha(l: Record<string, any>): LoteDeExportacao {
  return {
    batchId: String(l.batch_id),
    criadoEm: new Date(l.criado_em).toISOString(),
    criadoPor: String(l.criado_por ?? ''),
    desde: l.desde ? new Date(l.desde).toISOString() : null,
    ate: l.ate ? new Date(l.ate).toISOString() : null,
    apenasNovas: Boolean(l.apenas_novas),
    orderIds: String(l.order_ids ?? '').split(',').filter(Boolean),
    quantidade: Number(l.quantidade ?? 0),
    confirmadoEm: l.confirmado_em ? new Date(l.confirmado_em).toISOString() : null,
    confirmadoPor: l.confirmado_por ? String(l.confirmado_por) : null,
  };
}

export interface RepositorioDoPainel {
  readonly tipo: 'postgres' | 'memoria';
  preparar(): Promise<void>;
  listarEntregas(): Promise<LinkDeEntrega[]>;
  salvarEntrega(
    entrada: { itemId: string; nome: string; url: string; ativo: boolean; tipo: TipoEntrega },
    por: string,
  ): Promise<LinkDeEntrega>;
  historicoDeEntregas(limite: number): Promise<MudancaDeEntrega[]>;
  registrarWebhook(entrada: Omit<WebhookRecebido, 'id' | 't'> & { corpo?: unknown }): Promise<void>;
  listarWebhooks(limite: number): Promise<WebhookRecebido[]>;
  registrarEvento(entrada: { pedidoId: string; evento: string; origem?: string; detalhe?: string }): Promise<void>;
  listarEventos(pedidoId: string): Promise<EventoDePedido[]>;
  /**
   * Quantas vezes um evento aconteceu em cada pedido, e quando foi a última.
   *
   * Uma consulta para a lista inteira, e não uma por pedido: a tela de pedidos
   * mostra 125 linhas, e 125 idas ao banco para escrever "Lembretes enviados: 0"
   * em quase todas seria trocar uma tela rápida por uma lenta em troca de nada.
   */
  contarEventosPorPedido(evento: string): Promise<Array<{ pedidoId: string; total: number; ultimoEm: string }>>;

  /** Uma linha por evento do funil. É o que alimenta a aba Anúncios. */
  registrarEventoDoFunil(entrada: EventoDoFunil): Promise<void>;

  /**
   * Grava a venda confirmada. Idempotente pelo `orderId`.
   *
   * Chamada de `server/mensuracao.ts`, que por sua vez só é chamada de
   * `applyStatus` quando o pedido vira `completed`. Ver o cabeçalho de lá.
   */
  registrarConversao(entrada: ConversaoRegistrada): Promise<void>;

  /** As conversões do período, mais novas primeiro. Alimenta a exportação CSV. */
  listarConversoes(opcoes: {
    desde?: string;
    ate?: string;
    limite?: number;
    /** Só as que nunca entraram numa exportação do Meta. */
    apenasNaoExportadas?: boolean;
  }): Promise<ConversaoRegistrada[]>;

  /** Carimba as conversões como já exportadas para o Meta. Idempotente. */
  marcarConversoesExportadas(orderIds: string[]): Promise<void>;

  /** Registra o lote gerado por um download. NÃO marca nada como exportado. */
  criarLoteDeExportacao(entrada: Omit<LoteDeExportacao, 'criadoEm' | 'confirmadoEm' | 'confirmadoPor'>): Promise<LoteDeExportacao>;
  obterLoteDeExportacao(batchId: string): Promise<LoteDeExportacao | null>;
  /** Carimba o lote como confirmado. Idempotente: já confirmado não muda a data. */
  confirmarLoteDeExportacao(batchId: string, por: string): Promise<LoteDeExportacao | null>;
  listarLotesDeExportacao(limite: number): Promise<LoteDeExportacao[]>;
  /**
   * Etapas alcançadas por sessão, agrupadas por anúncio. Agregado no banco.
   *
   * `ate` existe para a mesma consulta poder recortar a janela ANTERIOR — é ela
   * que dá o "subiu ou caiu" ao lado de cada número. Sem limite superior só dá
   * para perguntar "quanto foi", nunca "está melhor que antes".
   */
  contarFunil(opcoes: {
    desde: string;
    ate?: string;
    agrupamento: AgrupamentoDeAnuncio;
    /* Quando presente, so as sessoes carimbadas com esta BM. Ausente = todas. */
    bm?: string | null;
  }): Promise<EtapasDoFunil[]>;

  /**
   * Quais BMs aparecem no periodo, para o painel montar o seletor.
   *
   * Sai de consulta propria em vez de ser deduzida das linhas do funil porque
   * o seletor precisa mostrar tambem a BM que existe e NAO VENDEU nada -- que
   * e exatamente a que o dono precisa enxergar para desligar.
   */
  listarBms(opcoes: { desde: string; ate?: string }): Promise<string[]>;

  /**
   * O topo do funil agregado POR GERENCIADOR.
   *
   * Uma consulta so, e nao um contarFunil por BM em laco: com cinco contas
   * seriam cinco idas ao banco a cada abertura de aba, e o painel atualiza
   * sozinho a cada 30 segundos.
   */
  contarPorBm(opcoes: { desde: string; ate?: string }): Promise<ContagemPorBm[]>;

  /**
   * O caminho pelas telas do funil, agregado no banco. Alimenta a aba Funil.
   *
   * `agoraMs` entra por parâmetro em vez de ser lido aqui dentro para o corte
   * de abandono (30 min sem evento) poder ser testado com um relógio fixo.
   */
  resumoDoFunil(opcoes: { desde: string; ate: string; agoraMs: number }): Promise<ResumoDoFunil>;

  /**
   * O topo do funil por DIA-CALENDÁRIO em São Paulo. Alimenta o fechamento
   * diário (aba Relatórios, 15/08/2026).
   *
   * A sessão inteira cai no dia em que começou — quem entrou 23h50 e gerou o
   * PIX 00h05 é uma visita de ontem, não meia de cada. Contar evento a evento
   * por dia partiria a mesma pessoa em duas e o funil deixaria de fechar.
   */
  funilPorDia(opcoes: { desde: string; ate: string }): Promise<FunilDoDia[]>;

  /**
   * O que as pessoas responderam no quiz, e quais respostas viram venda.
   *
   * Este funil é de diagnóstico: cada pergunta pede que a pessoa diga em voz
   * alta o que está apertando na vida dela. Isso é a matéria-prima da oferta —
   * qual dor escrever no anúncio, qual frase usar na mensagem de recuperação —
   * e estava sendo gravada sem nunca ser lida.
   *
   * `sessoesQueCompraram` entra por parâmetro em vez de ser descoberta aqui
   * porque a verdade financeira mora nos PEDIDOS, não nos eventos: o navegador
   * morre quando a pessoa vai pagar no aplicativo do banco, e contar venda por
   * evento daria sempre menos do que de fato entrou.
   */
  respostasDoQuiz(opcoes: {
    desde: string;
    ate: string;
    sessoesQueCompraram: string[];
  }): Promise<RespostaDoQuiz[]>;

  /**
   * Os pedidos de oração do fluxo "peça e será dado" (15/08/2026), um por
   * sessão, do mais recente ao mais antigo — a lista SEPARADA que o dono
   * pediu para trabalhar a reciprocidade e o WhatsApp de quem não comprou.
   *
   * A resposta crua é o JSON que a tela empacotou (nome, email, tel, pedido);
   * o chamador desempacota. Vem também a origem, para o painel saber de qual
   * anúncio o pedido veio.
   */
  pedidosDeOracao(opcoes: { desde: string; limite: number }): Promise<PedidoDeOracaoBruto[]>;

  /**
   * CRM (15/08/2026): TODOS os eventos de um conjunto de sessões, crus e em
   * ordem de tempo. É a matéria-prima do perfil da pessoa — etapa máxima,
   * respostas do quiz, pedido de oração, timeline. Uma consulta só, por
   * lista de sessões, para o perfil não fazer dez idas ao banco.
   */
  eventosDasSessoes(opcoes: { sessoes: string[] }): Promise<EventoDaSessao[]>;

  /**
   * CRM: as sessões que tiveram QUALQUER evento na janela, com o instante do
   * primeiro e do último — a base da lista de leads. Só quem passou da capa
   * (step >= 1) ou deixou pedido; visita que só abriu a página não é lead.
   */
  sessoesDaJanela(opcoes: { desde: string; ate: string; limite: number }): Promise<SessaoResumida[]>;

  /** Auditoria: grava uma ação. Nunca deve derrubar a rota que a chamou. */
  registrarAuditoria(entrada: Omit<RegistroDeAuditoria, 'id' | 't'>): Promise<void>;
  /** Auditoria: as últimas ações na janela, da mais nova para a mais antiga. */
  listarAuditoria(opcoes: { desde: string; limite: number; papel?: string }): Promise<RegistroDeAuditoria[]>;

  /** CRM: notas internas e marcações manuais (status forçado, opt-out) por sessão. */
  listarNotasCrm(sessao: string): Promise<NotaCrm[]>;
  listarMarcacoesCrm(sessoes: string[]): Promise<Map<string, MarcacaoCrm>>;
  salvarNotaCrm(entrada: { sessao: string; autor: string; texto: string }): Promise<NotaCrm>;
  salvarMarcacaoCrm(entrada: { sessao: string; statusManual?: string | null; optOut?: boolean; contatadoEm?: string | null }): Promise<MarcacaoCrm>;

  /**
   * Boletos pedidos pelo WhatsApp. Ver `PedidoDeBoletoRegistrado`.
   *
   * `registrarPedidoDeBoleto` é IDEMPOTENTE por CPF + valor dentro da janela:
   * quem toca duas vezes em "gerar boleto" — e toca, porque a primeira abre o
   * WhatsApp e a pessoa volta achando que não funcionou — precisa continuar
   * sendo uma pessoa só na contagem.
   */
  registrarPedidoDeBoleto(
    entrada: Omit<PedidoDeBoletoRegistrado, 'id' | 'criadoEm' | 'atualizadoEm' | 'situacao' | 'observacao' | 'geradoEm' | 'pagoEm' | 'naoPagoEm' | 'metaEventId' | 'metaEnviadoEm'>,
  ): Promise<{ pedido: PedidoDeBoletoRegistrado; jaExistia: boolean }>;
  listarPedidosDeBoleto(opcoes: { desde: string; limite: number }): Promise<PedidoDeBoletoRegistrado[]>;
  obterPedidoDeBoleto(id: string): Promise<PedidoDeBoletoRegistrado | null>;
  /** Grava o que mudou. Campo ausente fica como estava. */
  atualizarPedidoDeBoleto(
    id: string,
    mudanca: Partial<Pick<PedidoDeBoletoRegistrado, 'situacao' | 'observacao' | 'geradoEm' | 'pagoEm' | 'naoPagoEm' | 'metaEventId' | 'metaEnviadoEm'>>,
  ): Promise<PedidoDeBoletoRegistrado | null>;

  /**
   * De qual anúncio veio cada sessão. Só as que o chamador pediu.
   *
   * Existe para o pedido que chega sem carimbo: o navegador guarda a origem no
   * `localStorage` e ela pode se perder entre a visita e o pagamento (aba
   * anônima, storage cheio, limpeza do sistema). Sem isto a venda cai em
   * "(sem origem)" enquanto as visitas ficam na linha do anúncio — e a campanha
   * que pagou pela venda aparece como se não tivesse vendido nada.
   */
  chaveDasSessoes(opcoes: {
    sessoes: string[];
    agrupamento: AgrupamentoDeAnuncio;
    desde: string;
  }): Promise<Map<string, string>>;

  /**
   * Reserva o envio de um evento ao Meta. Devolve false quando o `eventId` já
   * existia — é o que impede o mesmo Purchase de ser enviado duas vezes quando
   * o webhook é reentregue.
   */
  reservarEnvioMeta(entrada: { eventId: string; evento: string; pedidoId?: string | null }): Promise<boolean>;
  concluirEnvioMeta(entrada: {
    eventId: string;
    sucesso: boolean;
    statusHttp: number;
    resposta: string;
    tentativas: number;
    /** Ver `EnvioMeta.chaves`. */
    chaves?: string[];
  }): Promise<void>;
  listarEnviosMeta(opcoes: { limite: number; sóPendentes?: boolean }): Promise<EnvioMeta[]>;

  /**
   * Investimento por campanha e por dia, digitado à mão.
   *
   * O quanto foi gasto vive no Gerenciador de Anúncios, não aqui — puxar isso
   * sozinho exige a API de Marketing e um usuário do sistema, que é um projeto
   * à parte. Até lá, digitar o número é o que permite ver retorno em vez de só
   * faturamento.
   */
  salvarInvestimento(entrada: Investimento): Promise<void>;
  /**
   * `nivel` filtra o que voltar. Sem ele vem tudo — e somar tudo conta o mesmo
   * gasto três vezes, porque campanha, conjunto e anúncio são o mesmo dinheiro
   * visto de três alturas. Quem chama pela tela SEMPRE passa o nível.
   */
  listarInvestimentos(opcoes: {
    desde: string;
    ate?: string;
    nivel?: NivelDeInvestimento;
    /** Só o gasto desta BM. Ausente traz tudo, inclusive o sem carimbo. */
    bm?: string | null;
  }): Promise<Investimento[]>;
  /** Grava várias linhas de uma vez. É o que a importação da planilha usa. */
  salvarInvestimentos(linhas: Investimento[]): Promise<void>;

  /**
   * Ajustes que o dono muda sozinho, sem deploy — hoje só o endereço da
   * planilha de investimento e a data da última importação. Mesmo motivo dos
   * links de entrega: o que muda mais rápido que o código não pode depender de
   * publicar uma versão nova.
   */
  lerConfiguracao(chave: string): Promise<string | null>;
  salvarConfiguracao(chave: string, valor: string): Promise<void>;
}

/** A última tela do funil. Vem de src/App.tsx e muda junto com ele. */
export const ULTIMA_ETAPA_DO_FUNIL = 13;

interface ParadaPorEtapa {
  ultimaEtapa: number;
  pararam: number;
  abandonaram: number;
  comTelasDoMeio: number;
  medianaAteOferta: number | null;
  medianaAtePix: number | null;
}

/**
 * Transforma "quantos pararam em cada tela" em "quantos chegaram em cada tela".
 *
 * O banco sabe responder onde cada sessão parou; o funil precisa do acumulado
 * de trás para frente — quem parou na tela 9 passou por todas as anteriores.
 * Fazer essa soma aqui, e não em SQL, mantém as duas implementações do
 * repositório (Postgres e memória) contando a MESMA história a partir do mesmo
 * código: quando elas divergem, quem descobre é o dono, olhando um número
 * errado em produção que os testes locais juravam estar certo.
 *
 * A mediana chega repetida em cada linha do agrupamento (é a mesma para o
 * conjunto todo), então basta pegar a primeira que não for nula.
 */
function montarResumoDoFunil(paradas: ParadaPorEtapa[]): ResumoDoFunil {
  const pararamPorEtapa = new Map<number, number>();
  const abandonoPorEtapa = new Map<number, number>();
  let sessoes = 0;
  let sessoesComTelasDoMeio = 0;
  let ateAOfertaS: number | null = null;
  let ateOPixS: number | null = null;

  for (const parada of paradas) {
    const etapa = Math.min(Math.max(parada.ultimaEtapa, 0), ULTIMA_ETAPA_DO_FUNIL);
    pararamPorEtapa.set(etapa, (pararamPorEtapa.get(etapa) ?? 0) + parada.pararam);
    if (parada.abandonaram > 0) {
      abandonoPorEtapa.set(etapa, (abandonoPorEtapa.get(etapa) ?? 0) + parada.abandonaram);
    }
    sessoes += parada.pararam;
    sessoesComTelasDoMeio += parada.comTelasDoMeio;
    if (ateAOfertaS === null && parada.medianaAteOferta !== null) ateAOfertaS = parada.medianaAteOferta;
    if (ateOPixS === null && parada.medianaAtePix !== null) ateOPixS = parada.medianaAtePix;
  }

  // De trás para frente: quem chegou na tela N é quem parou nela mais todos os
  // que foram além.
  const etapas: EtapaDoQuiz[] = [];
  let acumulado = 0;
  for (let step = ULTIMA_ETAPA_DO_FUNIL; step >= 0; step -= 1) {
    acumulado += pararamPorEtapa.get(step) ?? 0;
    etapas.unshift({ step, alcancaram: acumulado, pararam: pararamPorEtapa.get(step) ?? 0 });
  }

  return {
    sessoes,
    sessoesComTelasDoMeio,
    etapas,
    abandono: [...abandonoPorEtapa.entries()]
      .map(([step, quantas]) => ({ step, sessoes: quantas }))
      .sort((a, b) => b.sessoes - a.sessoes || a.step - b.step),
    tempos: {
      ateAOfertaS: ateAOfertaS === null ? null : Math.round(ateAOfertaS),
      ateOPixS: ateOPixS === null ? null : Math.round(ateOPixS),
    },
  };
}

/* Colunas de atribuição, na ordem em que entram nas queries. */
function valoresDaAtribuicao(a: Atribuicao): Array<string | null> {
  const limpar = (valor: string | null | undefined): string | null => {
    const texto = (valor ?? '').trim();
    return texto === '' ? null : texto.slice(0, 300);
  };
  return [
    limpar(a.utm_source), limpar(a.utm_medium), limpar(a.utm_campaign), limpar(a.utm_term),
    limpar(a.utm_content), limpar(a.utm_id), limpar(a.fb_campaign_id), limpar(a.fb_adset_id),
    limpar(a.fb_ad_id), limpar(a.fb_placement), limpar(a.fb_source), limpar(a.fbclid), limpar(a.gclid),
    /* No FIM da lista, sempre. A ordem daqui e a ordem das colunas nas
       queries; inserir no meio deslocaria todas as seguintes em silencio, e
       utm_medium iria parar na coluna do utm_campaign sem nenhum erro. */
    limpar(a.bm),
  ];
}


/* -------------------------------------------------------------------------- */
/* Postgres                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Em quanto tempo um pedido de boleto repetido ainda é o MESMO pedido.
 *
 * Doze horas. O caminho do boleto abre o WhatsApp numa aba nova e volta para o
 * site: parte das pessoas acha que não funcionou e toca de novo, às vezes
 * horas depois, no mesmo celular. Se cada toque virasse uma linha, a pergunta
 * que esta tela existe para responder — "quantas pessoas pediram boleto?" —
 * seria respondida com o número de cliques, sempre para cima.
 *
 * Só reaproveita quem ainda está em `pedido`: a partir do momento em que o dono
 * marcou gerado, pago ou não pago, um pedido novo com o mesmo CPF é uma
 * segunda tentativa de verdade e merece linha própria.
 */
const BOLETO_REPETIDO_MS = 12 * 60 * 60 * 1000;

/** Uma linha de `boletos_pedidos` no formato que o resto do sistema conhece. */
function linhaParaBoleto(l: Record<string, any>): PedidoDeBoletoRegistrado {
  const itens = typeof l.itens === 'string' ? JSON.parse(l.itens) : l.itens;
  const atribuicao = typeof l.atribuicao === 'string' ? JSON.parse(l.atribuicao) : l.atribuicao;
  return {
    id: String(l.id),
    criadoEm: new Date(l.criado_em).toISOString(),
    atualizadoEm: new Date(l.atualizado_em).toISOString(),
    sessao: l.sessao ? String(l.sessao) : null,
    nome: String(l.nome),
    email: String(l.email),
    telefone: l.telefone ? String(l.telefone) : null,
    documento: String(l.documento),
    valorCentavos: Number(l.valor_centavos),
    itemIds: Array.isArray(itens) ? itens.map(String) : [],
    situacao: String(l.situacao) as SituacaoDoBoleto,
    observacao: l.observacao ? String(l.observacao) : null,
    geradoEm: l.gerado_em ? new Date(l.gerado_em).toISOString() : null,
    pagoEm: l.pago_em ? new Date(l.pago_em).toISOString() : null,
    naoPagoEm: l.nao_pago_em ? new Date(l.nao_pago_em).toISOString() : null,
    atribuicao: (atribuicao ?? {}) as Atribuicao,
    ip: l.ip ? String(l.ip) : null,
    userAgent: l.user_agent ? String(l.user_agent) : null,
    metaEventId: l.meta_event_id ? String(l.meta_event_id) : null,
    metaEnviadoEm: l.meta_enviado_em ? new Date(l.meta_enviado_em).toISOString() : null,
  };
}

function criarRepositorioPostgres(connectionString: string): RepositorioDoPainel {
  const sql: NeonQueryFunction<false, false> = neon(connectionString);
  let pronto: Promise<void> | null = null;

  async function migrar(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS entrega_links (
        item_id        TEXT PRIMARY KEY,
        nome           TEXT        NOT NULL,
        url            TEXT        NOT NULL DEFAULT '',
        ativo          BOOLEAN     NOT NULL DEFAULT true,
        tipo           TEXT        NOT NULL DEFAULT 'arquivo',
        atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_por TEXT
      )
    `;
    // Histórico append only: uma linha por campo alterado, nunca sobrescrita.
    await sql`
      CREATE TABLE IF NOT EXISTS entrega_links_historico (
        id      BIGSERIAL PRIMARY KEY,
        t       TIMESTAMPTZ NOT NULL DEFAULT now(),
        item_id TEXT        NOT NULL,
        campo   TEXT        NOT NULL,
        de      TEXT,
        para    TEXT,
        por     TEXT        NOT NULL
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS entrega_hist_idx ON entrega_links_historico (t DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS webhooks_recebidos (
        id                BIGSERIAL PRIMARY KEY,
        t                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        evento            TEXT,
        cobranca_id       TEXT,
        pedido_id         TEXT,
        status_informado  TEXT,
        status_confirmado TEXT,
        resultado         TEXT        NOT NULL,
        detalhe           TEXT,
        corpo             JSONB
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS webhooks_t_idx ON webhooks_recebidos (t DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS pedido_eventos (
        id        BIGSERIAL PRIMARY KEY,
        t         TIMESTAMPTZ NOT NULL DEFAULT now(),
        pedido_id TEXT        NOT NULL,
        evento    TEXT        NOT NULL,
        origem    TEXT,
        detalhe   TEXT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS pedido_eventos_idx ON pedido_eventos (pedido_id, t DESC)`;

    /*
     * Caminho de quem passou pelo funil, com o carimbo do anúncio em cada
     * linha. É o que responde "quantos chegaram na VSL e quantos desses
     * abriram o checkout", por campanha.
     *
     * O carimbo é repetido em cada linha de propósito, em vez de ficar só na
     * sessão: nome e ID de anúncio mudam com o tempo, e um relatório que
     * recalcula a origem depois contaria a história errada do passado.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS eventos_funil (
        id             BIGSERIAL PRIMARY KEY,
        t              TIMESTAMPTZ NOT NULL DEFAULT now(),
        session_id     TEXT        NOT NULL,
        pedido_id      TEXT,
        evento         TEXT        NOT NULL,
        step           INTEGER,
        url            TEXT,
        ip             TEXT,
        user_agent     TEXT,
        utm_source     TEXT, utm_medium  TEXT, utm_campaign TEXT, utm_term TEXT,
        utm_content    TEXT, utm_id      TEXT,
        fb_campaign_id TEXT, fb_adset_id TEXT, fb_ad_id     TEXT,
        fb_placement   TEXT, fb_source   TEXT,
        fbclid         TEXT, gclid       TEXT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS eventos_funil_t_idx ON eventos_funil (t DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS eventos_funil_sessao_idx ON eventos_funil (session_id)`;
    await sql`CREATE INDEX IF NOT EXISTS eventos_funil_ad_idx ON eventos_funil (fb_ad_id, t DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS eventos_funil_camp_idx ON eventos_funil (utm_campaign, t DESC)`;

    /*
     * Auditoria dos envios ao Meta. O `event_id` é PRIMARY KEY porque é ele que
     * garante o envio único: o webhook da PixGo é reentregue, e sem esta trava
     * a mesma compra poderia ser enviada duas vezes por instâncias diferentes.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS eventos_meta (
        event_id    TEXT PRIMARY KEY,
        t           TIMESTAMPTZ NOT NULL DEFAULT now(),
        pedido_id   TEXT,
        evento      TEXT        NOT NULL,
        status_http INTEGER,
        resposta    TEXT,
        tentativas  INTEGER     NOT NULL DEFAULT 0,
        sucesso     BOOLEAN     NOT NULL DEFAULT false
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS eventos_meta_t_idx ON eventos_meta (t DESC)`;
    /*
     * Prova do que foi no evento: as CHAVES de user_data ("em,ph,fbc,fbp,ip,ua"),
     * nunca os valores. Existe porque em 15/08/2026 seis vendas não apareceram
     * atribuídas e não havia como saber, olhando o banco, se o Purchase saiu com
     * `fbc`/`fbp`. Coluna nova em vez de tabela nova: é atributo do envio.
     */
    await sql`ALTER TABLE eventos_meta ADD COLUMN IF NOT EXISTS chaves TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS eventos_meta_pendentes_idx ON eventos_meta (sucesso, t DESC)`;

    // Quanto foi gasto, digitado à mão. O número vive no Gerenciador de
    // Anúncios; sem ele o painel mostra faturamento, não retorno.
    await sql`
      CREATE TABLE IF NOT EXISTS configuracoes (
        chave         TEXT PRIMARY KEY,
        valor         TEXT        NOT NULL,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    /*
     * CRM (15/08/2026). As DUAS únicas estruturas novas do CRM: nota interna
     * e marcação manual por sessão. Todo o resto — pessoa, pedido, quiz,
     * PIX, compra, contatos — é lido do que já existe (eventos_funil e
     * orders). Não há tabela de "leads": o lead É a sessão.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS crm_notas (
        id        BIGSERIAL PRIMARY KEY,
        sessao    TEXT        NOT NULL,
        autor     TEXT        NOT NULL,
        texto     TEXT        NOT NULL,
        criada_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS crm_notas_sessao ON crm_notas (sessao, criada_em DESC)`;
    await sql`
      CREATE TABLE IF NOT EXISTS crm_marcacoes (
        sessao         TEXT PRIMARY KEY,
        status_manual  TEXT,
        opt_out        BOOLEAN     NOT NULL DEFAULT false,
        contatado_em   TIMESTAMPTZ,
        atualizada_em  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    /*
     * Boletos pedidos pelo WhatsApp (17/08/2026).
     *
     * Fica FORA da tabela `orders` de propósito: aqui não existe cobrança em
     * gateway, e um pedido de boleto no meio dos pedidos de PIX entraria nas
     * contas de pendente, nos lembretes e no expirador. Ver o comentário em
     * `PedidoDeBoletoRegistrado`.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS boletos_pedidos (
        id             TEXT PRIMARY KEY,
        criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
        sessao         TEXT,
        nome           TEXT        NOT NULL,
        email          TEXT        NOT NULL,
        telefone       TEXT,
        documento      TEXT        NOT NULL,
        valor_centavos INTEGER     NOT NULL,
        itens          JSONB       NOT NULL,
        situacao       TEXT        NOT NULL DEFAULT 'pedido',
        observacao     TEXT,
        gerado_em      TIMESTAMPTZ,
        pago_em        TIMESTAMPTZ,
        nao_pago_em    TIMESTAMPTZ,
        atribuicao     JSONB       NOT NULL,
        ip             TEXT,
        user_agent     TEXT,
        meta_event_id  TEXT,
        meta_enviado_em TIMESTAMPTZ
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS boletos_pedidos_criado ON boletos_pedidos (criado_em DESC)`;
    // A busca do idempotente: mesmo CPF, mesmo valor, ainda sem desfecho.
    await sql`CREATE INDEX IF NOT EXISTS boletos_pedidos_repetido ON boletos_pedidos (documento, valor_centavos, situacao, criado_em DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS auditoria (
        id       BIGSERIAL PRIMARY KEY,
        t        TIMESTAMPTZ NOT NULL DEFAULT now(),
        papel    TEXT        NOT NULL,
        ip       TEXT,
        acao     TEXT        NOT NULL,
        alvo     TEXT,
        detalhe  TEXT,
        status   INTEGER
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS auditoria_t ON auditoria (t DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS conversoes (
        order_id       TEXT PRIMARY KEY,
        paid_at        TIMESTAMPTZ NOT NULL,
        valor_centavos INTEGER     NOT NULL,
        moeda          TEXT        NOT NULL DEFAULT 'BRL',
        metodo         TEXT        NOT NULL DEFAULT 'pix',
        item_ids       TEXT        NOT NULL DEFAULT '',
        fbclid         TEXT, utm_source  TEXT, utm_medium   TEXT, utm_campaign TEXT,
        utm_term       TEXT, utm_content TEXT, utm_id       TEXT,
        fb_campaign_id TEXT, fb_adset_id TEXT, fb_ad_id     TEXT,
        fb_placement   TEXT, fb_source   TEXT,
        gclid          TEXT, ttclid      TEXT,
        tt_campaign_id TEXT, tt_adgroup_id TEXT, tt_ad_id   TEXT, tt_placement TEXT,
        bm             TEXT, landing_url TEXT, referrer     TEXT, session_id   TEXT,
        criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    /*
     * `order_id` é a PRIMARY KEY, e é ela que faz a idempotência.
     *
     * A gravação usa ON CONFLICT DO NOTHING: a reentrega do webhook — que todo
     * gateway faz por desenho — encontra a linha já lá e não cria uma segunda.
     * É a mesma trava de `webhook_events`, pelo mesmo motivo, e nenhuma das
     * duas depende da outra: se uma falhar, a outra ainda impede a duplicata.
     */
    /*
     * Coluna acrescentada depois, e por isso `ADD COLUMN IF NOT EXISTS`: a
     * tabela pode já ter linhas de vendas confirmadas antes de a exportação
     * para o Meta existir. NULL nelas quer dizer "nunca exportada", que é a
     * verdade.
     */
    await sql`ALTER TABLE conversoes ADD COLUMN IF NOT EXISTS exportado_meta_em TIMESTAMPTZ`;

    await sql`
      CREATE TABLE IF NOT EXISTS exportacoes_meta (
        batch_id       TEXT PRIMARY KEY,
        criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
        criado_por     TEXT        NOT NULL,
        desde          TIMESTAMPTZ,
        ate            TIMESTAMPTZ,
        apenas_novas   BOOLEAN     NOT NULL DEFAULT false,
        /* Separados por vírgula: a lista é lida inteira e nunca filtrada em SQL. */
        order_ids      TEXT        NOT NULL,
        quantidade     INTEGER     NOT NULL,
        confirmado_em  TIMESTAMPTZ,
        confirmado_por TEXT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS exportacoes_meta_criado_idx ON exportacoes_meta (criado_em DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS conversoes_exportado_idx ON conversoes (exportado_meta_em, paid_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS conversoes_pago_idx ON conversoes (paid_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS conversoes_ad_idx ON conversoes (fb_ad_id, paid_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS conversoes_camp_idx ON conversoes (utm_campaign, paid_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS conversoes_bm_idx ON conversoes (bm, paid_at DESC)`;

    await sql`
      CREATE TABLE IF NOT EXISTS investimento_anuncios (
        chave         TEXT        NOT NULL,
        dia           DATE        NOT NULL,
        centavos      INTEGER     NOT NULL DEFAULT 0,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (chave, dia)
      )
    `;

    /*
     * Colunas acrescentadas depois, em produção que já tinha dados.
     *
     * `ADD COLUMN IF NOT EXISTS` com DEFAULT 0 em vez de recriar a tabela: o
     * histórico de gasto já digitado à mão é insubstituível — não sai de lugar
     * nenhum se for apagado, porque o Gerenciador de Anúncios não guarda o que
     * o dono anotou aqui.
     */
    await sql`ALTER TABLE investimento_anuncios ADD COLUMN IF NOT EXISTS impressoes BIGINT NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE investimento_anuncios ADD COLUMN IF NOT EXISTS cliques BIGINT NOT NULL DEFAULT 0`;
    /*
     * `DEFAULT 'campanha'` para o que já estava gravado: tudo o que existe hoje
     * veio da planilha ou da digitação à mão, e as duas trabalham com o ID da
     * campanha. Sem o padrão, o histórico de gasto sairia da tela no primeiro
     * deploy — e ele é insubstituível, porque o Gerenciador de Anúncios não
     * guarda o que o dono anotou aqui.
     */
    await sql`ALTER TABLE investimento_anuncios ADD COLUMN IF NOT EXISTS nivel TEXT NOT NULL DEFAULT 'campanha'`;
    await sql`CREATE INDEX IF NOT EXISTS investimento_nivel_idx ON investimento_anuncios (nivel, dia)`;
    /*
     * De qual gerenciador veio o gasto.
     *
     * `DEFAULT ''` e não NULL: todo gasto já gravado veio da planilha ou da
     * digitação à mão, e nenhum deles sabe a conta de origem. Vazio quer dizer
     * "não sei", que é diferente de pertencer a alguma BM — e a diferença
     * importa, porque o painel soma o vazio no total geral e não o atribui a
     * gerenciador nenhum.
     */
    await sql`ALTER TABLE investimento_anuncios ADD COLUMN IF NOT EXISTS bm TEXT NOT NULL DEFAULT ''`;
    await sql`CREATE INDEX IF NOT EXISTS investimento_bm_idx ON investimento_anuncios (bm, dia)`;

    /*
     * A resposta do quiz, gravada junto da passagem pela tela.
     *
     * Até aqui a escolha vivia só na memória do navegador e sumia quando a aba
     * fechava — e é justamente quem fecha a aba que precisamos chamar de volta.
     * O servidor sabia "passou pela pergunta 4", que não serve para escrever
     * e-mail nenhum; agora sabe que ela respondeu "estou afogado em dívidas".
     *
     * Colunas novas em vez de tabela nova: a resposta pertence à passagem, tem
     * a mesma sessão e o mesmo instante, e uma tabela à parte exigiria um JOIN
     * em toda consulta do funil para não ganhar nada.
     *
     * Guarda o TEXTO da pergunta e da opção, não os ids. Quando alguém
     * reescrever o quiz — e vai —, o histórico continua legível em vez de virar
     * uma lista de "q2_op3" sem tradução.
     */
    await sql`ALTER TABLE eventos_funil ADD COLUMN IF NOT EXISTS pergunta TEXT`;
    await sql`ALTER TABLE eventos_funil ADD COLUMN IF NOT EXISTS resposta TEXT`;

    /*
     * De qual gerenciador de negocios veio o visitante.
     *
     * Nao e dedutivel: duas BMs produzem fb_campaign_id no mesmo formato, sem
     * nada que diga de qual conta sairam. O valor vem carimbado na URL do
     * anuncio (`bm=alpha`), e sem esta coluna cinco contas rodando em paralelo
     * viram um balaio so no painel -- justamente quando a pergunta que importa
     * e qual delas esta pagando.
     *
     * Linhas antigas ficam NULL, e o painel as mostra como '(sem BM)'. Nao ha
     * o que preencher para tras: o dado nunca existiu.
     */
    await sql`ALTER TABLE eventos_funil ADD COLUMN IF NOT EXISTS bm TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS idx_eventos_funil_bm ON eventos_funil (bm)`;
  }

  return {
    tipo: 'postgres',

    preparar(): Promise<void> {
      if (!pronto) {
        pronto = migrar().catch((erro: unknown) => {
          pronto = null;
          throw erro;
        });
      }
      return pronto;
    },

    async listarEntregas() {
      await this.preparar();
      const linhas = (await sql`
        SELECT item_id, nome, url, ativo, tipo, atualizado_em, atualizado_por FROM entrega_links
      `) as Array<{
        item_id: string;
        nome: string;
        url: string;
        ativo: boolean;
        tipo: string;
        atualizado_em: string;
        atualizado_por: string | null;
      }>;

      const salvos = new Map(linhas.map((linha) => [linha.item_id, linha]));

      // O catálogo manda: todo produto aparece, editado ou não.
      return Object.keys(CATALOG).map((itemId) => {
        const padrao = padraoDoItem(itemId);
        const salvo = salvos.get(itemId);
        if (!salvo) return padrao;

        return {
          itemId,
          nome: salvo.nome || padrao.nome,
          url: salvo.url ?? '',
          ativo: salvo.ativo,
          tipo: (TIPOS_DE_ENTREGA.includes(salvo.tipo as TipoEntrega) ? salvo.tipo : padrao.tipo) as TipoEntrega,
          atualizadoEm: new Date(salvo.atualizado_em).toISOString(),
          atualizadoPor: salvo.atualizado_por,
          origem: salvo.url ? 'painel' : padrao.url ? 'ambiente' : 'vazio',
        } satisfies LinkDeEntrega;
      });
    },

    async salvarEntrega(entrada, por) {
      await this.preparar();
      const anteriores = await this.listarEntregas();
      const antes = anteriores.find((item) => item.itemId === entrada.itemId);

      await sql`
        INSERT INTO entrega_links (item_id, nome, url, ativo, tipo, atualizado_em, atualizado_por)
        VALUES (${entrada.itemId}, ${entrada.nome}, ${entrada.url}, ${entrada.ativo}, ${entrada.tipo}, now(), ${por})
        ON CONFLICT (item_id) DO UPDATE SET
          nome = EXCLUDED.nome, url = EXCLUDED.url, ativo = EXCLUDED.ativo,
          tipo = EXCLUDED.tipo, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por
      `;

      // Uma linha de histórico por campo que realmente mudou.
      const campos: Array<[string, string | null, string | null]> = [
        ['url', antes?.url ?? null, entrada.url],
        ['nome', antes?.nome ?? null, entrada.nome],
        ['ativo', antes ? String(antes.ativo) : null, String(entrada.ativo)],
        ['tipo', antes?.tipo ?? null, entrada.tipo],
      ];
      for (const [campo, de, para] of campos) {
        if (de === para) continue;
        await sql`
          INSERT INTO entrega_links_historico (item_id, campo, de, para, por)
          VALUES (${entrada.itemId}, ${campo}, ${de}, ${para}, ${por})
        `;
      }

      const depois = await this.listarEntregas();
      return depois.find((item) => item.itemId === entrada.itemId) ?? padraoDoItem(entrada.itemId);
    },

    async historicoDeEntregas(limite) {
      await this.preparar();
      const linhas = (await sql`
        SELECT t, item_id, campo, de, para, por FROM entrega_links_historico
        ORDER BY t DESC LIMIT ${limite}
      `) as Array<{ t: string; item_id: string; campo: string; de: string | null; para: string | null; por: string }>;

      return linhas.map((linha) => ({
        t: new Date(linha.t).toISOString(),
        itemId: linha.item_id,
        campo: linha.campo,
        de: linha.de,
        para: linha.para,
        por: linha.por,
      }));
    },

    async registrarWebhook(entrada) {
      await this.preparar();
      await sql`
        INSERT INTO webhooks_recebidos
          (evento, cobranca_id, pedido_id, status_informado, status_confirmado, resultado, detalhe, corpo)
        VALUES (${entrada.evento}, ${entrada.cobrancaId}, ${entrada.pedidoId}, ${entrada.statusInformado},
                ${entrada.statusConfirmado}, ${entrada.resultado}, ${entrada.detalhe},
                ${entrada.corpo ? JSON.stringify(entrada.corpo) : null})
      `;
    },

    async listarWebhooks(limite) {
      await this.preparar();
      const linhas = (await sql`
        SELECT id, t, evento, cobranca_id, pedido_id, status_informado, status_confirmado, resultado, detalhe
        FROM webhooks_recebidos ORDER BY t DESC LIMIT ${limite}
      `) as Array<Record<string, any>>;

      return linhas.map((linha) => ({
        id: Number(linha.id),
        t: new Date(linha.t).toISOString(),
        evento: linha.evento,
        cobrancaId: linha.cobranca_id,
        pedidoId: linha.pedido_id,
        statusInformado: linha.status_informado,
        statusConfirmado: linha.status_confirmado,
        resultado: linha.resultado,
        detalhe: linha.detalhe,
      }));
    },

    async registrarEvento(entrada) {
      await this.preparar();
      await sql`
        INSERT INTO pedido_eventos (pedido_id, evento, origem, detalhe)
        VALUES (${entrada.pedidoId}, ${entrada.evento}, ${entrada.origem ?? null}, ${entrada.detalhe ?? null})
      `;
    },

    async listarEventos(pedidoId) {
      await this.preparar();
      const linhas = (await sql`
        SELECT t, pedido_id, evento, origem, detalhe FROM pedido_eventos
        WHERE pedido_id = ${pedidoId} ORDER BY t DESC LIMIT 50
      `) as Array<Record<string, any>>;

      return linhas.map((linha) => ({
        t: new Date(linha.t).toISOString(),
        pedidoId: linha.pedido_id,
        evento: linha.evento,
        origem: linha.origem,
        detalhe: linha.detalhe,
      }));
    },

    async contarEventosPorPedido(evento) {
      await this.preparar();
      const linhas = (await sql`
        SELECT pedido_id, COUNT(*)::int AS total, MAX(t) AS ultimo
          FROM pedido_eventos
         WHERE evento = ${evento}
         GROUP BY pedido_id
      `) as Array<Record<string, any>>;
      return linhas.map((linha) => ({
        pedidoId: String(linha.pedido_id),
        total: Number(linha.total),
        ultimoEm: new Date(linha.ultimo).toISOString(),
      }));
    },

    async registrarConversao(entrada) {
      await this.preparar();
      await sql`
        INSERT INTO conversoes (
          order_id, paid_at, valor_centavos, moeda, metodo, item_ids,
          fbclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id,
          fb_campaign_id, fb_adset_id, fb_ad_id, fb_placement, fb_source,
          gclid, ttclid, tt_campaign_id, tt_adgroup_id, tt_ad_id, tt_placement,
          bm, landing_url, referrer, session_id
        ) VALUES (
          ${entrada.orderId}, ${entrada.paidAt}, ${entrada.valorCentavos}, ${entrada.moeda},
          ${entrada.metodo}, ${entrada.itemIds.join(',')},
          ${entrada.fbclid}, ${entrada.utmSource}, ${entrada.utmMedium}, ${entrada.utmCampaign},
          ${entrada.utmTerm}, ${entrada.utmContent}, ${entrada.utmId},
          ${entrada.fbCampaignId}, ${entrada.fbAdsetId}, ${entrada.fbAdId},
          ${entrada.fbPlacement}, ${entrada.fbSource},
          ${entrada.gclid}, ${entrada.ttclid}, ${entrada.ttCampaignId}, ${entrada.ttAdgroupId},
          ${entrada.ttAdId}, ${entrada.ttPlacement},
          ${entrada.bm}, ${entrada.landingUrl}, ${entrada.referrer}, ${entrada.sessionId}
        )
        ON CONFLICT (order_id) DO NOTHING
      `;
    },

    async listarConversoes({ desde, ate, limite, apenasNaoExportadas }) {
      await this.preparar();
      /*
       * Os filtros vão como `($1::text IS NULL OR coluna >= $1)` — o mesmo
       * padrão do resto do arquivo. Montar SQL por concatenação para pular um
       * filtro ausente é como se abre uma injeção num sistema que só recebe
       * texto de fora.
       */
      const linhas = (await sql`
        SELECT * FROM conversoes
         WHERE (${desde ?? null}::timestamptz IS NULL OR paid_at >= ${desde ?? null}::timestamptz)
           AND (${ate ?? null}::timestamptz IS NULL OR paid_at < ${ate ?? null}::timestamptz)
           AND (${apenasNaoExportadas ? 1 : 0} = 0 OR exportado_meta_em IS NULL)
         ORDER BY paid_at DESC
         LIMIT ${Math.min(Math.max(limite ?? 5000, 1), 50_000)}
      `) as Array<Record<string, any>>;

      return linhas.map((l) => ({
        orderId: String(l.order_id),
        paidAt: new Date(l.paid_at).toISOString(),
        valorCentavos: Number(l.valor_centavos ?? 0),
        moeda: String(l.moeda ?? 'BRL'),
        metodo: String(l.metodo ?? 'pix'),
        itemIds: String(l.item_ids ?? '').split(',').filter(Boolean),
        fbclid: l.fbclid ?? null,
        utmSource: l.utm_source ?? null,
        utmMedium: l.utm_medium ?? null,
        utmCampaign: l.utm_campaign ?? null,
        utmTerm: l.utm_term ?? null,
        utmContent: l.utm_content ?? null,
        utmId: l.utm_id ?? null,
        fbCampaignId: l.fb_campaign_id ?? null,
        fbAdsetId: l.fb_adset_id ?? null,
        fbAdId: l.fb_ad_id ?? null,
        fbPlacement: l.fb_placement ?? null,
        fbSource: l.fb_source ?? null,
        gclid: l.gclid ?? null,
        ttclid: l.ttclid ?? null,
        ttCampaignId: l.tt_campaign_id ?? null,
        ttAdgroupId: l.tt_adgroup_id ?? null,
        ttAdId: l.tt_ad_id ?? null,
        ttPlacement: l.tt_placement ?? null,
        bm: l.bm ?? null,
        landingUrl: l.landing_url ?? null,
        referrer: l.referrer ?? null,
        sessionId: l.session_id ?? null,
        exportadoMetaEm: l.exportado_meta_em ? new Date(l.exportado_meta_em).toISOString() : null,
      }));
    },

    async criarLoteDeExportacao(entrada) {
      await this.preparar();
      const linhas = (await sql`
        INSERT INTO exportacoes_meta (batch_id, criado_por, desde, ate, apenas_novas, order_ids, quantidade)
        VALUES (
          ${entrada.batchId}, ${entrada.criadoPor}, ${entrada.desde}, ${entrada.ate},
          ${entrada.apenasNovas}, ${entrada.orderIds.join(',')}, ${entrada.quantidade}
        )
        RETURNING *
      `) as Array<Record<string, any>>;
      return loteDaLinha(linhas[0]);
    },

    async obterLoteDeExportacao(batchId) {
      await this.preparar();
      const linhas = (await sql`SELECT * FROM exportacoes_meta WHERE batch_id = ${batchId}`) as Array<Record<string, any>>;
      return linhas[0] ? loteDaLinha(linhas[0]) : null;
    },

    async confirmarLoteDeExportacao(batchId, por) {
      await this.preparar();
      /*
       * COALESCE nos dois campos: reconfirmar não reescreve quem confirmou nem
       * quando. A primeira confirmação é a que vale — é ela que responde "desde
       * quando o Meta tem estas vendas" se um número lá não bater.
       */
      const linhas = (await sql`
        UPDATE exportacoes_meta
           SET confirmado_em  = COALESCE(confirmado_em, now()),
               confirmado_por = COALESCE(confirmado_por, ${por})
         WHERE batch_id = ${batchId}
        RETURNING *
      `) as Array<Record<string, any>>;
      return linhas[0] ? loteDaLinha(linhas[0]) : null;
    },

    async listarLotesDeExportacao(limite) {
      await this.preparar();
      const linhas = (await sql`
        SELECT * FROM exportacoes_meta ORDER BY criado_em DESC LIMIT ${Math.min(Math.max(limite, 1), 200)}
      `) as Array<Record<string, any>>;
      return linhas.map(loteDaLinha);
    },

    async marcarConversoesExportadas(orderIds) {
      if (orderIds.length === 0) return;
      await this.preparar();
      /*
       * `COALESCE` mantém o carimbo ORIGINAL: reexportar o mesmo período não
       * reescreve a data da primeira vez. É ela que responde "quando isto saiu
       * daqui pela primeira vez" quando um número no Gerenciador não bate.
       */
      await sql`
        UPDATE conversoes
           SET exportado_meta_em = COALESCE(exportado_meta_em, now())
         WHERE order_id = ANY(${orderIds}::text[])
      `;
    },

    async registrarEventoDoFunil(entrada) {
      await this.preparar();
      const [origem, meio, campanha, termo, conteudo, idUtm, campId, adsetId, adId, posicao, plataforma, fbclid, gclid, bm] =
        valoresDaAtribuicao(entrada.atribuicao);

      await sql`
        INSERT INTO eventos_funil (
          session_id, pedido_id, evento, step, url, ip, user_agent, pergunta, resposta,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id,
          fb_campaign_id, fb_adset_id, fb_ad_id, fb_placement, fb_source, fbclid, gclid, bm
        ) VALUES (
          ${entrada.sessionId}, ${entrada.pedidoId ?? null}, ${entrada.evento}, ${entrada.step ?? null},
          ${entrada.url ?? null}, ${entrada.ip ?? null}, ${entrada.userAgent ?? null},
          ${entrada.pergunta ?? null}, ${entrada.resposta ?? null},
          ${origem}, ${meio}, ${campanha}, ${termo}, ${conteudo}, ${idUtm},
          ${campId}, ${adsetId}, ${adId}, ${posicao}, ${plataforma}, ${fbclid}, ${gclid}, ${bm}
        )
      `;
    },

    /*
     * As BMs do periodo, em ordem alfabetica.
     *
     * DISTINCT direto na coluna, apoiado no indice criado no preparar(). Nao
     * deduz da tabela de anuncios de proposito: assim a lista mostra tambem a
     * BM que trouxe visita e nao vendeu nada -- que e a que o dono precisa ver
     * para decidir desligar.
     */
    /*
     * Mesma reducao do contarFunil: a SESSAO primeiro, a BM depois.
     *
     * A sessao vira uma linha so (uma BM e o degrau mais alto que alcancou) e
     * so entao as sessoes sao agrupadas. Agrupar linha a linha contaria a
     * MESMA pessoa como visita de uma BM e checkout de outra sempre que o
     * carimbo faltasse num evento -- e ele falta, porque o PageView sai da
     * pagina que ainda tem os parametros e um evento posterior pode sair
     * depois de o localStorage ter sido limpo.
     */
    async contarPorBm({ desde, ate }) {
      await this.preparar();
      const limite = ate ?? '9999-12-31';
      const linhas = (await sql`
        WITH sessoes AS (
          SELECT session_id,
                 COALESCE(MAX(NULLIF(bm,'')), '') AS bm,
                 MAX(CASE evento
                       WHEN 'PageView'             THEN 1
                       WHEN 'CompleteRegistration' THEN 2
                       WHEN 'ViewContent'          THEN 3
                       WHEN 'InitiateCheckout'     THEN 4
                       WHEN 'Lead'                 THEN 4
                       WHEN 'AddPaymentInfo'       THEN 4
                       ELSE 0 END)                 AS estagio
            FROM eventos_funil
           WHERE t >= ${desde} AND t < ${limite}
           GROUP BY session_id
        )
        SELECT bm,
               COUNT(*)                                AS visitas,
               COUNT(*) FILTER (WHERE estagio >= 2)    AS quiz,
               COUNT(*) FILTER (WHERE estagio >= 3)    AS vsl,
               COUNT(*) FILTER (WHERE estagio >= 4)    AS checkout
          FROM sessoes
         GROUP BY bm
         ORDER BY visitas DESC
      `) as Array<Record<string, unknown>>;
      return linhas.map((l) => ({
        bm: String(l.bm ?? ''),
        visitas: Number(l.visitas ?? 0),
        quiz: Number(l.quiz ?? 0),
        vsl: Number(l.vsl ?? 0),
        checkout: Number(l.checkout ?? 0),
      }));
    },

    async listarBms({ desde, ate }) {
      await this.preparar();
      const limite = ate ?? '9999-12-31';
      const linhas = (await sql`
        SELECT DISTINCT bm
          FROM eventos_funil
         WHERE t >= ${desde} AND t < ${limite}
           AND bm IS NOT NULL AND bm <> ''
         ORDER BY bm
      `) as Array<{ bm: string }>;
      return linhas.map((l) => l.bm);
    },

    async contarFunil({ desde, ate, agrupamento, bm }) {
      await this.preparar();

      // Sem `ate`, um limite que nunca chega — assim as três consultas abaixo
      // têm a mesma forma, em vez de duas versões de cada uma.
      const limite = ate ?? '9999-12-31';

      /*
       * Duas etapas: primeiro a SESSÃO, depois o anúncio.
       *
       * A sessão é reduzida a uma linha só — uma chave de anúncio e o degrau
       * mais alto que ela alcançou — e só então as sessões são agrupadas. A
       * ordem importa por dois motivos:
       *
       *  - o degrau máximo é o que torna o funil monotônico (ver EtapasDoFunil);
       *  - a chave consolidada conserta a sessão cujo carimbo aparece em umas
       *    linhas e não em outras. Isso acontece de verdade: o `PageView` sai da
       *    página que ainda tem os parâmetros na URL, e um evento posterior pode
       *    sair depois de o `localStorage` ter sido limpo. Agrupando linha a
       *    linha, a MESMA pessoa era contada como visita do anúncio e como
       *    checkout de "(sem origem)".
       *
       * Uma query por agrupamento em vez de nome de coluna montado em texto: o
       * driver só interpola VALORES, e concatenar identificador na mão é como se
       * abre uma porta de injeção de SQL num painel autenticado.
       */
      const linhas = (
        agrupamento === 'campanha'
          ? await sql`
              WITH sessoes AS (
                SELECT session_id,
                       COALESCE(MAX(NULLIF(fb_campaign_id,'')), MAX(NULLIF(utm_campaign,'')),
                                MAX(NULLIF(utm_id,'')), '')  AS chave,
                       MAX(NULLIF(utm_campaign,''))          AS nome,
                       MAX(NULLIF(utm_source,''))            AS fonte,
                       MAX(CASE WHEN COALESCE(fb_campaign_id,'') <> '' OR COALESCE(fbclid,'') <> ''
                                THEN 1 ELSE 0 END)           AS tem_fb,
                       MAX(CASE evento
                             WHEN 'PageView'             THEN 1
                             WHEN 'CompleteRegistration' THEN 2
                             WHEN 'ViewContent'          THEN 3
                             WHEN 'InitiateCheckout'     THEN 4
                             WHEN 'Lead'                 THEN 4
                             WHEN 'AddPaymentInfo'       THEN 4
                             ELSE 0 END)                     AS estagio
                  FROM eventos_funil WHERE t >= ${desde} AND t < ${limite} AND (${bm ?? null}::text IS NULL OR bm = ${bm ?? null})
                 GROUP BY session_id
              )
              SELECT chave, MAX(nome) AS nome, MAX(fonte) AS fonte, MAX(tem_fb) AS tem_fb,
                     COUNT(*)                                AS visitas,
                     COUNT(*) FILTER (WHERE estagio >= 2)    AS quiz,
                     COUNT(*) FILTER (WHERE estagio >= 3)    AS vsl,
                     COUNT(*) FILTER (WHERE estagio >= 4)    AS checkout
                FROM sessoes GROUP BY chave
            `
          : agrupamento === 'conjunto'
            ? await sql`
                WITH sessoes AS (
                  SELECT session_id,
                         COALESCE(MAX(NULLIF(fb_adset_id,'')), MAX(NULLIF(utm_term,'')), '') AS chave,
                         MAX(NULLIF(utm_term,''))              AS nome,
                         MAX(NULLIF(utm_source,''))            AS fonte,
                         MAX(CASE WHEN COALESCE(fb_adset_id,'') <> '' OR COALESCE(fbclid,'') <> ''
                                  THEN 1 ELSE 0 END)           AS tem_fb,
                         MAX(CASE evento
                               WHEN 'PageView'             THEN 1
                               WHEN 'CompleteRegistration' THEN 2
                               WHEN 'ViewContent'          THEN 3
                               WHEN 'InitiateCheckout'     THEN 4
                               WHEN 'Lead'                 THEN 4
                               WHEN 'AddPaymentInfo'       THEN 4
                               ELSE 0 END)                     AS estagio
                    FROM eventos_funil WHERE t >= ${desde} AND t < ${limite} AND (${bm ?? null}::text IS NULL OR bm = ${bm ?? null})
                   GROUP BY session_id
                )
                SELECT chave, MAX(nome) AS nome, MAX(fonte) AS fonte, MAX(tem_fb) AS tem_fb,
                       COUNT(*)                                AS visitas,
                       COUNT(*) FILTER (WHERE estagio >= 2)    AS quiz,
                       COUNT(*) FILTER (WHERE estagio >= 3)    AS vsl,
                       COUNT(*) FILTER (WHERE estagio >= 4)    AS checkout
                  FROM sessoes GROUP BY chave
              `
            : await sql`
                WITH sessoes AS (
                  SELECT session_id,
                         COALESCE(MAX(NULLIF(fb_ad_id,'')), MAX(NULLIF(utm_content,'')), '') AS chave,
                         MAX(NULLIF(utm_content,''))           AS nome,
                         MAX(NULLIF(utm_source,''))            AS fonte,
                         MAX(CASE WHEN COALESCE(fb_ad_id,'') <> '' OR COALESCE(fbclid,'') <> ''
                                  THEN 1 ELSE 0 END)           AS tem_fb,
                         MAX(CASE evento
                               WHEN 'PageView'             THEN 1
                               WHEN 'CompleteRegistration' THEN 2
                               WHEN 'ViewContent'          THEN 3
                               WHEN 'InitiateCheckout'     THEN 4
                               WHEN 'Lead'                 THEN 4
                               WHEN 'AddPaymentInfo'       THEN 4
                               ELSE 0 END)                     AS estagio
                    FROM eventos_funil WHERE t >= ${desde} AND t < ${limite} AND (${bm ?? null}::text IS NULL OR bm = ${bm ?? null})
                   GROUP BY session_id
                )
                SELECT chave, MAX(nome) AS nome, MAX(fonte) AS fonte, MAX(tem_fb) AS tem_fb,
                       COUNT(*)                                AS visitas,
                       COUNT(*) FILTER (WHERE estagio >= 2)    AS quiz,
                       COUNT(*) FILTER (WHERE estagio >= 3)    AS vsl,
                       COUNT(*) FILTER (WHERE estagio >= 4)    AS checkout
                  FROM sessoes GROUP BY chave
              `
      ) as Array<Record<string, any>>;

      return linhas.map((linha) => ({
        chave: linha.chave ?? '',
        nome: linha.nome ?? null,
        fonte: linha.fonte ?? null,
        temFacebook: Number(linha.tem_fb ?? 0) > 0,
        visitas: Number(linha.visitas ?? 0),
        quiz: Number(linha.quiz ?? 0),
        vsl: Number(linha.vsl ?? 0),
        checkout: Number(linha.checkout ?? 0),
      }));
    },

    async funilPorDia({ desde, ate }) {
      await this.preparar();
      // O fuso vai como VALOR: o driver só interpola valores, e é o mesmo fuso
      // do resto do painel (server/periodo.ts).
      const linhas = (await sql`
        WITH sessoes AS (
          SELECT session_id,
                 MIN(t) AS inicio,
                 MAX(CASE evento
                       WHEN 'PageView'             THEN 1
                       WHEN 'CompleteRegistration' THEN 2
                       WHEN 'ViewContent'          THEN 3
                       WHEN 'InitiateCheckout'     THEN 4
                       WHEN 'Lead'                 THEN 4
                       WHEN 'AddPaymentInfo'       THEN 4
                       ELSE 0 END)                 AS estagio
            FROM eventos_funil WHERE t >= ${desde} AND t < ${ate}
           GROUP BY session_id
        )
        SELECT to_char(inicio AT TIME ZONE ${FUSO_DO_PAINEL}, 'YYYY-MM-DD') AS dia,
               COUNT(*)                                AS visitas,
               COUNT(*) FILTER (WHERE estagio >= 2)    AS quiz,
               COUNT(*) FILTER (WHERE estagio >= 3)    AS vsl,
               COUNT(*) FILTER (WHERE estagio >= 4)    AS checkout
          FROM sessoes GROUP BY 1 ORDER BY 1
      `) as Array<Record<string, any>>;

      return linhas.map((linha) => ({
        dia: String(linha.dia),
        visitas: Number(linha.visitas ?? 0),
        quiz: Number(linha.quiz ?? 0),
        vsl: Number(linha.vsl ?? 0),
        checkout: Number(linha.checkout ?? 0),
      }));
    },

    async resumoDoFunil({ desde, ate, agoraMs }) {
      await this.preparar();

      /*
       * Uma passada só, e o agrupamento por sessão vem primeiro.
       *
       * `MAX(step)` é o que responde "até onde essa pessoa foi" — e ele funciona
       * para qualquer evento, porque todos gravam a tela em que aconteceram.
       * Isso vale inclusive para os eventos que existiam antes de as telas do
       * meio serem instrumentadas: uma visita antiga tem step 0, 12 ou 13, e
       * aparece no lugar certo do funil em vez de sumir do relatório.
       *
       * `COALESCE(step, 0)`: evento sem tela informada conta como entrada. Zero
       * é a única suposição segura — a pessoa esteve no site.
       */
      const linhas = (await sql`
        WITH sessoes AS (
          SELECT session_id,
                 MAX(COALESCE(step, 0)) AS ultima_etapa,
                 MAX(t)                 AS visto_por_ultimo,
                 MIN(t)                 AS primeiro_evento,
                 MAX(t) FILTER (WHERE evento = 'AddPaymentInfo') AS gerou_pix,
                 MAX(t) FILTER (WHERE COALESCE(step, 0) >= 13)   AS chegou_na_oferta,
                 BOOL_OR(pedido_id IS NOT NULL)                  AS tem_pedido,
                 BOOL_OR(step BETWEEN 1 AND 11)                  AS tem_telas_do_meio
            FROM eventos_funil
           WHERE t >= ${desde} AND t < ${ate}
           GROUP BY session_id
        )
        SELECT ultima_etapa,
               COUNT(*) AS pararam,
               COUNT(*) FILTER (WHERE tem_telas_do_meio) AS com_telas_do_meio,
               COUNT(*) FILTER (WHERE visto_por_ultimo < ${new Date(agoraMs - 30 * 60_000).toISOString()}
                                  AND NOT tem_pedido) AS abandonaram,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (chegou_na_oferta - primeiro_evento))
               ) FILTER (WHERE chegou_na_oferta IS NOT NULL) AS mediana_ate_oferta,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (gerou_pix - primeiro_evento))
               ) FILTER (WHERE gerou_pix IS NOT NULL) AS mediana_ate_pix
          FROM sessoes
         GROUP BY ultima_etapa
         ORDER BY ultima_etapa
      `) as Array<Record<string, any>>;

      return montarResumoDoFunil(
        linhas.map((linha) => ({
          ultimaEtapa: Number(linha.ultima_etapa ?? 0),
          pararam: Number(linha.pararam ?? 0),
          abandonaram: Number(linha.abandonaram ?? 0),
          comTelasDoMeio: Number(linha.com_telas_do_meio ?? 0),
          medianaAteOferta: linha.mediana_ate_oferta === null ? null : Number(linha.mediana_ate_oferta),
          medianaAtePix: linha.mediana_ate_pix === null ? null : Number(linha.mediana_ate_pix),
        })),
      );
    },

    async respostasDoQuiz({ desde, ate, sessoesQueCompraram }) {
      await this.preparar();

      /*
       * `DISTINCT session_id` e não `COUNT(*)`: quem volta para trás no quiz e
       * responde de novo geraria dois eventos para a mesma escolha, e a opção
       * pareceria mais popular do que é.
       */
      const linhas = (await sql`
        SELECT pergunta,
               resposta,
               COUNT(DISTINCT session_id) AS pessoas,
               COUNT(DISTINCT session_id) FILTER (
                 WHERE session_id = ANY(${sessoesQueCompraram}::text[])
               ) AS compraram
          FROM eventos_funil
         WHERE t >= ${desde} AND t < ${ate}
           AND pergunta IS NOT NULL
           AND resposta IS NOT NULL
         GROUP BY pergunta, resposta
         ORDER BY pergunta, pessoas DESC
      `) as Array<Record<string, any>>;

      return linhas.map((linha) => ({
        pergunta: String(linha.pergunta ?? ''),
        resposta: String(linha.resposta ?? ''),
        pessoas: Number(linha.pessoas ?? 0),
        compraram: Number(linha.compraram ?? 0),
      }));
    },

    async pedidosDeOracao({ desde, limite }) {
      await this.preparar();
      /*
       * DISTINCT ON (session_id) com o mais recente primeiro: quem volta e
       * reenvia o pedido conta uma vez, com o texto final. O corte pela
       * pergunta é literal — é o rótulo que a tela manda (src/App.tsx).
       */
      const linhas = (await sql`
        SELECT DISTINCT ON (session_id)
               session_id, t, resposta, utm_content, fb_ad_id
          FROM eventos_funil
         WHERE t >= ${desde}
           AND pergunta ILIKE ${PREFIXO_SQL_PEDIDO}
           AND resposta IS NOT NULL
         ORDER BY session_id, t DESC
      `) as Array<Record<string, any>>;

      return linhas
        .map((linha) => ({
          sessionId: String(linha.session_id),
          quando: new Date(linha.t).toISOString(),
          resposta: String(linha.resposta ?? ''),
          utmContent: linha.utm_content ? String(linha.utm_content) : null,
          fbAdId: linha.fb_ad_id ? String(linha.fb_ad_id) : null,
        }))
        .sort((a, b) => b.quando.localeCompare(a.quando))
        .slice(0, limite);
    },

    async eventosDasSessoes({ sessoes }) {
      if (sessoes.length === 0) return [];
      await this.preparar();
      const linhas = (await sql`
        SELECT session_id, t, evento, step, pedido_id, pergunta, resposta,
               utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id,
               fb_campaign_id, fb_adset_id, fb_ad_id, fb_placement, fb_source, fbclid, gclid
          FROM eventos_funil
         WHERE session_id = ANY(${sessoes}::text[])
         ORDER BY t ASC
      `) as Array<Record<string, any>>;
      return linhas.map((l) => ({
        sessionId: String(l.session_id),
        t: new Date(l.t).toISOString(),
        evento: String(l.evento ?? ''),
        step: l.step === null || l.step === undefined ? null : Number(l.step),
        pedidoId: l.pedido_id ? String(l.pedido_id) : null,
        pergunta: l.pergunta ? String(l.pergunta) : null,
        resposta: l.resposta ? String(l.resposta) : null,
        atribuicao: {
          utm_source: l.utm_source ?? undefined,
          utm_medium: l.utm_medium ?? undefined,
          utm_campaign: l.utm_campaign ?? undefined,
          utm_term: l.utm_term ?? undefined,
          utm_content: l.utm_content ?? undefined,
          utm_id: l.utm_id ?? undefined,
          fb_campaign_id: l.fb_campaign_id ?? undefined,
          fb_adset_id: l.fb_adset_id ?? undefined,
          fb_ad_id: l.fb_ad_id ?? undefined,
          fb_placement: l.fb_placement ?? undefined,
          fb_source: l.fb_source ?? undefined,
          fbclid: l.fbclid ?? undefined,
          gclid: l.gclid ?? undefined,
        },
      }));
    },

    async sessoesDaJanela({ desde, ate, limite }) {
      await this.preparar();
      /*
       * Lead = sessão que passou da capa (step >= 1) OU deixou pedido de
       * oração. Quem só abriu a página é visita, não pessoa — e entraria aos
       * milhares. O HAVING faz esse corte no banco, não em memória.
       */
      const linhas = (await sql`
        SELECT session_id,
               MIN(t) AS primeiro_em,
               MAX(t) AS ultimo_em,
               COALESCE(MAX(step), 0) AS step_maximo,
               BOOL_OR(pergunta ILIKE ${PREFIXO_SQL_PEDIDO}) AS tem_pedido
          FROM eventos_funil
         WHERE t >= ${desde} AND t < ${ate}
         GROUP BY session_id
        HAVING COALESCE(MAX(step), 0) >= 1 OR BOOL_OR(pergunta ILIKE ${PREFIXO_SQL_PEDIDO})
         ORDER BY MAX(t) DESC
         LIMIT ${limite}
      `) as Array<Record<string, any>>;
      return linhas.map((l) => ({
        sessionId: String(l.session_id),
        primeiroEm: new Date(l.primeiro_em).toISOString(),
        ultimoEm: new Date(l.ultimo_em).toISOString(),
        stepMaximo: Number(l.step_maximo ?? 0),
        temPedidoDeOracao: Boolean(l.tem_pedido),
      }));
    },

    async registrarAuditoria({ papel, ip, acao, alvo, detalhe, status }) {
      await this.preparar();
      await sql`
        INSERT INTO auditoria (papel, ip, acao, alvo, detalhe, status)
        VALUES (${papel}, ${ip}, ${acao}, ${alvo}, ${detalhe}, ${status})
      `;
    },

    async listarAuditoria({ desde, limite, papel }) {
      await this.preparar();
      const linhas = (
        papel
          ? await sql`
              SELECT id, t, papel, ip, acao, alvo, detalhe, status FROM auditoria
               WHERE t >= ${desde} AND papel = ${papel} ORDER BY t DESC LIMIT ${limite}
            `
          : await sql`
              SELECT id, t, papel, ip, acao, alvo, detalhe, status FROM auditoria
               WHERE t >= ${desde} ORDER BY t DESC LIMIT ${limite}
            `
      ) as Array<Record<string, any>>;
      return linhas.map((l) => ({
        id: String(l.id),
        t: new Date(l.t).toISOString(),
        papel: String(l.papel),
        ip: l.ip ?? null,
        acao: String(l.acao),
        alvo: l.alvo ?? null,
        detalhe: l.detalhe ?? null,
        status: l.status === null || l.status === undefined ? null : Number(l.status),
      }));
    },

    async listarNotasCrm(sessao) {
      await this.preparar();
      const linhas = (await sql`
        SELECT id, sessao, autor, texto, criada_em FROM crm_notas WHERE sessao = ${sessao} ORDER BY criada_em DESC
      `) as Array<Record<string, any>>;
      return linhas.map((l) => ({
        id: String(l.id),
        sessao: String(l.sessao),
        autor: String(l.autor),
        texto: String(l.texto),
        criadaEm: new Date(l.criada_em).toISOString(),
      }));
    },

    async listarMarcacoesCrm(sessoes) {
      const mapa = new Map<string, MarcacaoCrm>();
      if (sessoes.length === 0) return mapa;
      await this.preparar();
      const linhas = (await sql`
        SELECT sessao, status_manual, opt_out, contatado_em, atualizada_em
          FROM crm_marcacoes WHERE sessao = ANY(${sessoes}::text[])
      `) as Array<Record<string, any>>;
      for (const l of linhas) {
        mapa.set(String(l.sessao), {
          sessao: String(l.sessao),
          statusManual: l.status_manual ? String(l.status_manual) : null,
          optOut: Boolean(l.opt_out),
          contatadoEm: l.contatado_em ? new Date(l.contatado_em).toISOString() : null,
          atualizadaEm: new Date(l.atualizada_em).toISOString(),
        });
      }
      return mapa;
    },

    async salvarNotaCrm({ sessao, autor, texto }) {
      await this.preparar();
      const [l] = (await sql`
        INSERT INTO crm_notas (sessao, autor, texto) VALUES (${sessao}, ${autor}, ${texto})
        RETURNING id, sessao, autor, texto, criada_em
      `) as Array<Record<string, any>>;
      return { id: String(l.id), sessao, autor, texto, criadaEm: new Date(l.criada_em).toISOString() };
    },

    async salvarMarcacaoCrm({ sessao, statusManual, optOut, contatadoEm }) {
      await this.preparar();
      const atual = (await this.listarMarcacoesCrm([sessao])).get(sessao);
      const novo: MarcacaoCrm = {
        sessao,
        statusManual: statusManual === undefined ? (atual?.statusManual ?? null) : statusManual,
        optOut: optOut === undefined ? (atual?.optOut ?? false) : optOut,
        contatadoEm: contatadoEm === undefined ? (atual?.contatadoEm ?? null) : contatadoEm,
        atualizadaEm: new Date().toISOString(),
      };
      await sql`
        INSERT INTO crm_marcacoes (sessao, status_manual, opt_out, contatado_em, atualizada_em)
        VALUES (${sessao}, ${novo.statusManual}, ${novo.optOut}, ${novo.contatadoEm}, now())
        ON CONFLICT (sessao) DO UPDATE SET
          status_manual = EXCLUDED.status_manual,
          opt_out       = EXCLUDED.opt_out,
          contatado_em  = EXCLUDED.contatado_em,
          atualizada_em = now()
      `;
      return novo;
    },

    async registrarPedidoDeBoleto(entrada) {
      await this.preparar();

      const corte = new Date(Date.now() - BOLETO_REPETIDO_MS).toISOString();
      const repetidos = (await sql`
        SELECT * FROM boletos_pedidos
         WHERE documento = ${entrada.documento}
           AND valor_centavos = ${entrada.valorCentavos}
           AND situacao = 'pedido'
           AND criado_em >= ${corte}
         ORDER BY criado_em DESC
         LIMIT 1
      `) as Array<Record<string, any>>;

      if (repetidos.length > 0) {
        /*
         * Toque repetido: nada é sobrescrito além do relógio. O carimbo do
         * anúncio da PRIMEIRA vez é o que vale — é o clique que pagou pela
         * visita, e o segundo toque costuma vir de uma aba sem carimbo nenhum.
         */
        const [linha] = (await sql`
          UPDATE boletos_pedidos SET atualizado_em = now() WHERE id = ${String(repetidos[0].id)} RETURNING *
        `) as Array<Record<string, any>>;
        return { pedido: linhaParaBoleto(linha), jaExistia: true };
      }

      const [criado] = (await sql`
        INSERT INTO boletos_pedidos (
          id, sessao, nome, email, telefone, documento, valor_centavos, itens, atribuicao, ip, user_agent
        ) VALUES (
          ${`bol_${newId(8)}`}, ${entrada.sessao}, ${entrada.nome}, ${entrada.email}, ${entrada.telefone},
          ${entrada.documento}, ${entrada.valorCentavos}, ${JSON.stringify(entrada.itemIds)},
          ${JSON.stringify(entrada.atribuicao)}, ${entrada.ip}, ${entrada.userAgent}
        )
        RETURNING *
      `) as Array<Record<string, any>>;
      return { pedido: linhaParaBoleto(criado), jaExistia: false };
    },

    async listarPedidosDeBoleto({ desde, limite }) {
      await this.preparar();
      const linhas = (await sql`
        SELECT * FROM boletos_pedidos WHERE criado_em >= ${desde} ORDER BY criado_em DESC LIMIT ${limite}
      `) as Array<Record<string, any>>;
      return linhas.map(linhaParaBoleto);
    },

    async obterPedidoDeBoleto(id) {
      await this.preparar();
      const linhas = (await sql`SELECT * FROM boletos_pedidos WHERE id = ${id} LIMIT 1`) as Array<Record<string, any>>;
      return linhas.length > 0 ? linhaParaBoleto(linhas[0]) : null;
    },

    async atualizarPedidoDeBoleto(id, mudanca) {
      await this.preparar();
      const atual = await this.obterPedidoDeBoleto(id);
      if (!atual) return null;

      /*
       * COALESCE não serve aqui: ele trataria `null` como "não mexe", e desmarcar
       * uma data (voltar um boleto pago para pedido) é exatamente mandar null.
       * O valor de cada campo é decidido em JavaScript, onde `undefined` e `null`
       * ainda são coisas diferentes.
       */
      const novo: PedidoDeBoletoRegistrado = {
        ...atual,
        situacao: mudanca.situacao ?? atual.situacao,
        observacao: mudanca.observacao === undefined ? atual.observacao : mudanca.observacao,
        geradoEm: mudanca.geradoEm === undefined ? atual.geradoEm : mudanca.geradoEm,
        pagoEm: mudanca.pagoEm === undefined ? atual.pagoEm : mudanca.pagoEm,
        naoPagoEm: mudanca.naoPagoEm === undefined ? atual.naoPagoEm : mudanca.naoPagoEm,
        metaEventId: mudanca.metaEventId === undefined ? atual.metaEventId : mudanca.metaEventId,
        metaEnviadoEm: mudanca.metaEnviadoEm === undefined ? atual.metaEnviadoEm : mudanca.metaEnviadoEm,
        atualizadoEm: new Date().toISOString(),
      };

      const [linha] = (await sql`
        UPDATE boletos_pedidos SET
          situacao        = ${novo.situacao},
          observacao      = ${novo.observacao},
          gerado_em       = ${novo.geradoEm},
          pago_em         = ${novo.pagoEm},
          nao_pago_em     = ${novo.naoPagoEm},
          meta_event_id   = ${novo.metaEventId},
          meta_enviado_em = ${novo.metaEnviadoEm},
          atualizado_em   = now()
        WHERE id = ${id}
        RETURNING *
      `) as Array<Record<string, any>>;
      return linha ? linhaParaBoleto(linha) : null;
    },

    async chaveDasSessoes({ sessoes, agrupamento, desde }) {
      const achadas = new Map<string, string>();
      if (sessoes.length === 0) return achadas;
      await this.preparar();

      // Só as sessões pedidas, e só dentro da janela já consultada: a tabela de
      // eventos cresce para sempre e uma varredura inteira aqui custaria mais
      // que todo o resto da tela junto.
      const linhas = (
        agrupamento === 'campanha'
          ? await sql`
              SELECT session_id,
                     COALESCE(MAX(NULLIF(fb_campaign_id,'')), MAX(NULLIF(utm_campaign,'')),
                              MAX(NULLIF(utm_id,'')), '') AS chave
                FROM eventos_funil
               WHERE t >= ${desde} AND session_id = ANY(${sessoes}::text[])
               GROUP BY session_id
            `
          : agrupamento === 'conjunto'
            ? await sql`
                SELECT session_id,
                       COALESCE(MAX(NULLIF(fb_adset_id,'')), MAX(NULLIF(utm_term,'')), '') AS chave
                  FROM eventos_funil
                 WHERE t >= ${desde} AND session_id = ANY(${sessoes}::text[])
                 GROUP BY session_id
              `
            : await sql`
                SELECT session_id,
                       COALESCE(MAX(NULLIF(fb_ad_id,'')), MAX(NULLIF(utm_content,'')), '') AS chave
                  FROM eventos_funil
                 WHERE t >= ${desde} AND session_id = ANY(${sessoes}::text[])
                 GROUP BY session_id
              `
      ) as Array<Record<string, any>>;

      for (const linha of linhas) {
        const chave = String(linha.chave ?? '');
        if (chave !== '') achadas.set(String(linha.session_id), chave);
      }
      return achadas;
    },

    async salvarInvestimento(entrada) {
      await this.preparar();
      await sql`
        INSERT INTO investimento_anuncios (chave, dia, nivel, bm, centavos, impressoes, cliques)
        VALUES (${entrada.chave}, ${entrada.dia}, ${entrada.nivel ?? 'campanha'}, ${entrada.bm ?? ''},
                ${entrada.centavos}, ${entrada.impressoes}, ${entrada.cliques})
        ON CONFLICT (chave, dia) DO UPDATE SET
          nivel = EXCLUDED.nivel,
          bm = COALESCE(NULLIF(EXCLUDED.bm, ''), investimento_anuncios.bm),
          centavos = EXCLUDED.centavos,
          impressoes = EXCLUDED.impressoes,
          cliques = EXCLUDED.cliques,
          atualizado_em = now()
      `;
    },

    async listarInvestimentos({ desde, ate, nivel, bm }) {
      await this.preparar();
      const limite = ate ?? '9999-12-31';
      /*
       * `${x}::text IS NULL OR coluna = ${x}` em vez de montar SQL ou de uma
       * consulta por combinação: o driver só interpola VALORES, e com dois
       * filtros opcionais as duas consultas de antes virariam quatro. O `::text`
       * é obrigatório — sem ele o Postgres não sabe o tipo do parâmetro nulo e
       * recusa a consulta inteira.
       */
      const nivelFiltro = nivel ?? null;
      const bmFiltro = bm === undefined || bm === null || bm === '' ? null : bm;
      const linhas = (await sql`
        SELECT chave, dia::text AS dia, nivel, bm, centavos, impressoes, cliques
          FROM investimento_anuncios
         WHERE dia >= ${desde} AND dia < ${limite}
           AND (${nivelFiltro}::text IS NULL OR nivel = ${nivelFiltro})
           AND (${bmFiltro}::text IS NULL OR bm = ${bmFiltro})
      `) as Array<Record<string, string | number>>;
      return linhas.map((linha) => ({
        chave: String(linha.chave),
        dia: String(linha.dia),
        nivel: (String(linha.nivel ?? 'campanha') as NivelDeInvestimento),
        bm: String(linha.bm ?? ''),
        centavos: Number(linha.centavos),
        impressoes: Number(linha.impressoes ?? 0),
        cliques: Number(linha.cliques ?? 0),
      }));
    },

    async salvarInvestimentos(linhas) {
      await this.preparar();
      // Em lotes: a função da Vercel tem 20 s, e uma planilha de 90 dias com
      // várias campanhas passa fácil de mil linhas.
      const TAMANHO = 50;
      for (let inicio = 0; inicio < linhas.length; inicio += TAMANHO) {
        const lote = linhas.slice(inicio, inicio + TAMANHO);
        await Promise.all(
          /*
             * `nivel` PRECISA ir no INSERT. A coluna nasceu com
             * `DEFAULT 'campanha'` para não apagar o histórico digitado à mão,
             * e omiti-la aqui fazia toda linha importada do Meta — campanha,
             * conjunto e anúncio — entrar gravada como campanha.
             *
             * O estrago não aparecia como erro: a tela de campanhas somava as
             * três alturas do mesmo dinheiro e mostrava o triplo do gasto, com
             * o ROAS a um terço do real; as telas de conjunto e de anúncio
             * ficavam com investimento zero, porque nenhuma linha tinha esse
             * nível. Decidir orçamento por esses números é decidir ao contrário.
             */
          /*
           * `bm = COALESCE(NULLIF(EXCLUDED.bm, ''), ...bm)`: uma gravação SEM
           * carimbo não apaga o carimbo que já existia. Sem isso, importar a
           * planilha depois de importar por conta de anúncios zeraria o vínculo
           * de todo o histórico, e o gasto de três gerenciadores voltaria a
           * virar um monte só — em silêncio, porque o total continuaria certo.
           */
          lote.map((linha) => sql`
            INSERT INTO investimento_anuncios (chave, dia, nivel, bm, centavos, impressoes, cliques)
            VALUES (${linha.chave}, ${linha.dia}, ${linha.nivel ?? 'campanha'}, ${linha.bm ?? ''},
                    ${linha.centavos}, ${linha.impressoes}, ${linha.cliques})
            ON CONFLICT (chave, dia) DO UPDATE SET
              nivel = EXCLUDED.nivel,
              bm = COALESCE(NULLIF(EXCLUDED.bm, ''), investimento_anuncios.bm),
              centavos = EXCLUDED.centavos,
              impressoes = EXCLUDED.impressoes,
              cliques = EXCLUDED.cliques,
              atualizado_em = now()
          `),
        );
      }
    },

    async lerConfiguracao(chave) {
      await this.preparar();
      const linhas = (await sql`SELECT valor FROM configuracoes WHERE chave = ${chave}`) as Array<{ valor: string }>;
      return linhas[0]?.valor ?? null;
    },

    async salvarConfiguracao(chave, valor) {
      await this.preparar();
      await sql`
        INSERT INTO configuracoes (chave, valor) VALUES (${chave}, ${valor})
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()
      `;
    },

    async reservarEnvioMeta(entrada) {
      await this.preparar();
      const linhas = await sql`
        INSERT INTO eventos_meta (event_id, evento, pedido_id)
        VALUES (${entrada.eventId}, ${entrada.evento}, ${entrada.pedidoId ?? null})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `;
      return linhas.length > 0;
    },

    async concluirEnvioMeta(entrada) {
      await this.preparar();
      const chaves = entrada.chaves ? entrada.chaves.join(',').slice(0, 200) : null;
      await sql`
        UPDATE eventos_meta
           SET sucesso = ${entrada.sucesso}, status_http = ${entrada.statusHttp},
               resposta = ${entrada.resposta.slice(0, 500)}, tentativas = ${entrada.tentativas},
               chaves = COALESCE(${chaves}, chaves), t = now()
         WHERE event_id = ${entrada.eventId}
      `;
    },

    async listarEnviosMeta({ limite, sóPendentes }) {
      await this.preparar();
      const linhas = (
        sóPendentes
          ? await sql`
              SELECT event_id, t, pedido_id, evento, status_http, resposta, tentativas, sucesso, chaves
                FROM eventos_meta WHERE sucesso = false ORDER BY t DESC LIMIT ${limite}
            `
          : await sql`
              SELECT event_id, t, pedido_id, evento, status_http, resposta, tentativas, sucesso, chaves
                FROM eventos_meta ORDER BY t DESC LIMIT ${limite}
            `
      ) as Array<Record<string, any>>;

      return linhas.map((linha, indice) => ({
        id: indice,
        t: new Date(linha.t).toISOString(),
        pedidoId: linha.pedido_id,
        evento: linha.evento,
        eventId: linha.event_id,
        statusHttp: linha.status_http === null ? null : Number(linha.status_http),
        resposta: linha.resposta,
        tentativas: Number(linha.tentativas ?? 0),
        sucesso: Boolean(linha.sucesso),
        chaves: typeof linha.chaves === 'string' && linha.chaves !== '' ? linha.chaves.split(',') : null,
      }));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Memória, só para desenvolvimento sem banco                                  */
/* -------------------------------------------------------------------------- */

/**
 * Exportado para os testes.
 *
 * A agregação do funil tem duas partes que a rota HTTP não alcança: o corte de
 * abandono (30 min sem evento) e as medianas de tempo. Pela API não dá para
 * envelhecer um evento — o `t` é `now()` do banco —, então o teste que garante
 * essas contas precisa falar com o repositório direto, passando o relógio.
 */
export function criarRepositorioEmMemoria(): RepositorioDoPainel {
  const entregas = new Map<string, LinkDeEntrega>();
  const historico: MudancaDeEntrega[] = [];
  const webhooks: WebhookRecebido[] = [];
  const eventos: EventoDePedido[] = [];
  const funil: Array<EventoDoFunil & { t: string }> = [];
  const notasCrm: NotaCrm[] = [];
  const auditoria: RegistroDeAuditoria[] = [];
  const marcacoesCrm = new Map<string, MarcacaoCrm>();
  const boletos = new Map<string, PedidoDeBoletoRegistrado>();
  const enviosMeta = new Map<string, EnvioMeta>();
  const investimentos = new Map<string, Investimento>();

/**
 * Grava um gasto preservando o carimbo de BM que já estava lá.
 *
 * Espelha o `COALESCE(NULLIF(EXCLUDED.bm, ''), ...)` do Postgres. Se as duas
 * implementações divergirem aqui, o teste passa em memória e o painel erra em
 * produção — que é o pior lugar para uma diferença destas aparecer.
 */
function guardarInvestimento(entrada: Investimento): void {
  const chave = `${entrada.chave} ${entrada.dia}`;
  const anterior = investimentos.get(chave);
  investimentos.set(chave, {
    nivel: 'campanha',
    ...entrada,
    bm: entrada.bm || anterior?.bm || '',
  });
}
  const configuracoes = new Map<string, string>();
  const conversoes = new Map<string, ConversaoRegistrada>();
  const lotes = new Map<string, LoteDeExportacao>();
  let proximoId = 1;

  return {
    tipo: 'memoria',

    async preparar() {
      /* nada a preparar */
    },

    async listarEntregas() {
      return Object.keys(CATALOG).map((itemId) => entregas.get(itemId) ?? padraoDoItem(itemId));
    },

    async salvarEntrega(entrada, por) {
      const antes = entregas.get(entrada.itemId) ?? padraoDoItem(entrada.itemId);
      const agora = new Date().toISOString();

      const campos: Array<[string, string | null, string | null]> = [
        ['url', antes.url, entrada.url],
        ['nome', antes.nome, entrada.nome],
        ['ativo', String(antes.ativo), String(entrada.ativo)],
        ['tipo', antes.tipo, entrada.tipo],
      ];
      for (const [campo, de, para] of campos) {
        if (de === para) continue;
        historico.unshift({ t: agora, itemId: entrada.itemId, campo, de, para, por });
      }

      const atual: LinkDeEntrega = {
        ...entrada,
        atualizadoEm: agora,
        atualizadoPor: por,
        origem: entrada.url ? 'painel' : urlDoAmbiente(entrada.itemId) ? 'ambiente' : 'vazio',
      };
      entregas.set(entrada.itemId, atual);
      return atual;
    },

    async historicoDeEntregas(limite) {
      return historico.slice(0, limite);
    },

    async registrarWebhook(entrada) {
      webhooks.unshift({ id: proximoId++, t: new Date().toISOString(), ...entrada });
      if (webhooks.length > 500) webhooks.length = 500;
    },

    async listarWebhooks(limite) {
      return webhooks.slice(0, limite);
    },

    async registrarEvento(entrada) {
      eventos.unshift({
        t: new Date().toISOString(),
        pedidoId: entrada.pedidoId,
        evento: entrada.evento,
        origem: entrada.origem ?? null,
        detalhe: entrada.detalhe ?? null,
      });
      if (eventos.length > 1000) eventos.length = 1000;
    },

    async listarEventos(pedidoId) {
      return eventos.filter((evento) => evento.pedidoId === pedidoId).slice(0, 50);
    },

    async contarEventosPorPedido(evento) {
      const porPedido = new Map();
      for (const e of eventos) {
        if (e.evento !== evento) continue;
        const atual = porPedido.get(e.pedidoId);
        // `eventos` guarda do mais novo para o mais velho: o primeiro visto é o último.
        if (atual) atual.total += 1;
        else porPedido.set(e.pedidoId, { pedidoId: e.pedidoId, total: 1, ultimoEm: e.t });
      }
      return [...porPedido.values()];
    },

    async registrarEventoDoFunil(entrada) {
      funil.unshift({ t: new Date().toISOString(), ...entrada });
      if (funil.length > 5000) funil.length = 5000;
    },

    /* Mesma idempotência da versão Postgres: o primeiro grava, o resto ignora. */
    async registrarConversao(entrada) {
      if (conversoes.has(entrada.orderId)) return;
      conversoes.set(entrada.orderId, { ...entrada });
    },

    async listarConversoes({ desde, ate, limite, apenasNaoExportadas }) {
      const corte = desde ? Date.parse(desde) : Number.NEGATIVE_INFINITY;
      const teto = ate ? Date.parse(ate) : Number.POSITIVE_INFINITY;
      return [...conversoes.values()]
        .filter((c) => {
          if (apenasNaoExportadas && c.exportadoMetaEm) return false;
          const q = Date.parse(c.paidAt);
          return q >= corte && q < teto;
        })
        .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt))
        .slice(0, Math.min(Math.max(limite ?? 5000, 1), 50_000));
    },

    async criarLoteDeExportacao(entrada) {
      const lote = {
        ...entrada,
        criadoEm: new Date().toISOString(),
        confirmadoEm: null,
        confirmadoPor: null,
      };
      lotes.set(entrada.batchId, lote);
      return lote;
    },

    async obterLoteDeExportacao(batchId) {
      return lotes.get(batchId) ?? null;
    },

    async confirmarLoteDeExportacao(batchId, por) {
      const lote = lotes.get(batchId);
      if (!lote) return null;
      /* Já confirmado não muda: mesma regra do COALESCE da versão Postgres. */
      if (!lote.confirmadoEm) {
        lote.confirmadoEm = new Date().toISOString();
        lote.confirmadoPor = por;
        lotes.set(batchId, lote);
      }
      return lote;
    },

    async listarLotesDeExportacao(limite) {
      return [...lotes.values()]
        .sort((a, b) => Date.parse(b.criadoEm) - Date.parse(a.criadoEm))
        .slice(0, Math.min(Math.max(limite, 1), 200));
    },

    async marcarConversoesExportadas(orderIds) {
      const agora = new Date().toISOString();
      for (const id of orderIds) {
        const c = conversoes.get(id);
        if (c && !c.exportadoMetaEm) conversoes.set(id, { ...c, exportadoMetaEm: agora });
      }
    },

    /** Mesma leitura da versão Postgres: a sessão primeiro, o anúncio depois. */
    /** Mesma reducao da versao Postgres: a sessao primeiro, a BM depois. */
    async contarPorBm({ desde, ate }) {
      const corte = Date.parse(desde);
      const teto = ate ? Date.parse(ate) : Number.POSITIVE_INFINITY;
      const porSessao = new Map<string, { bm: string; estagio: number }>();
      for (const linha of funil) {
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;
        const atual = porSessao.get(linha.sessionId) ?? { bm: '', estagio: 0 };
        const marca = (linha.atribuicao.bm ?? '').trim();
        if (marca) atual.bm = marca;
        atual.estagio = Math.max(atual.estagio, ESTAGIO_DO_EVENTO[linha.evento] ?? 0);
        porSessao.set(linha.sessionId, atual);
      }
      const porBm = new Map<string, { bm: string; visitas: number; quiz: number; vsl: number; checkout: number }>();
      for (const s of porSessao.values()) {
        const linha = porBm.get(s.bm) ?? { bm: s.bm, visitas: 0, quiz: 0, vsl: 0, checkout: 0 };
        linha.visitas += 1;
        if (s.estagio >= 2) linha.quiz += 1;
        if (s.estagio >= 3) linha.vsl += 1;
        if (s.estagio >= 4) linha.checkout += 1;
        porBm.set(s.bm, linha);
      }
      return [...porBm.values()].sort((a, b) => b.visitas - a.visitas);
    },

    /** Mesma leitura da versao Postgres: DISTINCT sobre as BMs do periodo. */
    async listarBms({ desde, ate }) {
      const corte = Date.parse(desde);
      const teto = ate ? Date.parse(ate) : Number.POSITIVE_INFINITY;
      const achadas = new Set<string>();
      for (const linha of funil) {
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;
        const marca = (linha.atribuicao?.bm ?? '').trim();
        if (marca) achadas.add(marca);
      }
      return [...achadas].sort();
    },

    async contarFunil({ desde, ate, agrupamento, bm }) {
      const corte = Date.parse(desde);
      const teto = ate ? Date.parse(ate) : Number.POSITIVE_INFINITY;
      /* Mesma regra do SQL: BM ausente = todas. */
      const filtroBm = (bm ?? '').trim();

      interface Sessao {
        chave: string;
        nome: string | null;
        fonte: string | null;
        temFacebook: boolean;
        estagio: number;
      }
      const sessoes = new Map<string, Sessao>();

      for (const linha of funil) {
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;
        /* O mesmo filtro do SQL. Fica DEPOIS do corte de tempo porque comparar
           string custa mais que comparar numero, e a maioria das linhas ja cai
           fora pelo periodo. */
        if (filtroBm !== '' && (linha.atribuicao.bm ?? '').trim() !== filtroBm) continue;

        const grupo = chaveDoGrupo(linha.atribuicao, agrupamento);
        const nome =
          agrupamento === 'campanha'
            ? linha.atribuicao.utm_campaign
            : agrupamento === 'conjunto'
              ? linha.atribuicao.utm_term
              : linha.atribuicao.utm_content;

        const atual = sessoes.get(linha.sessionId) ?? {
          chave: '',
          nome: null,
          fonte: null,
          temFacebook: false,
          estagio: 0,
        };

        // Vazio nunca sobrescreve preenchido: é o carimbo que se perdeu no meio
        // da visita, não uma origem nova.
        if (grupo !== '') atual.chave = grupo;
        atual.nome = atual.nome ?? nome ?? null;
        atual.fonte = atual.fonte ?? linha.atribuicao.utm_source ?? null;
        atual.temFacebook = atual.temFacebook || Boolean(linha.atribuicao.fbclid || linha.atribuicao.fb_ad_id);
        atual.estagio = Math.max(atual.estagio, ESTAGIO_DO_EVENTO[linha.evento] ?? 0);
        sessoes.set(linha.sessionId, atual);
      }

      const grupos = new Map<string, EtapasDoFunil>();
      for (const sessao of sessoes.values()) {
        const atual = grupos.get(sessao.chave) ?? {
          chave: sessao.chave,
          nome: null,
          fonte: null,
          temFacebook: false,
          visitas: 0,
          quiz: 0,
          vsl: 0,
          checkout: 0,
        };

        atual.nome = atual.nome ?? sessao.nome;
        atual.fonte = atual.fonte ?? sessao.fonte;
        atual.temFacebook = atual.temFacebook || sessao.temFacebook;
        // Toda sessão registrada é uma visita, inclusive a que perdeu o
        // PageView: alguém esteve no site para gerar o evento seguinte.
        atual.visitas += 1;
        if (sessao.estagio >= 2) atual.quiz += 1;
        if (sessao.estagio >= 3) atual.vsl += 1;
        if (sessao.estagio >= 4) atual.checkout += 1;
        grupos.set(sessao.chave, atual);
      }

      return [...grupos.values()];
    },

    /** Mesma leitura da versão Postgres: a sessão cai no dia em que começou. */
    async funilPorDia({ desde, ate }) {
      const corte = Date.parse(desde);
      const teto = Date.parse(ate);
      const sessoes = new Map<string, { inicioMs: number; estagio: number }>();

      for (const linha of funil) {
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;
        const atual = sessoes.get(linha.sessionId) ?? { inicioMs: quando, estagio: 0 };
        atual.inicioMs = Math.min(atual.inicioMs, quando);
        atual.estagio = Math.max(atual.estagio, ESTAGIO_DO_EVENTO[linha.evento] ?? 0);
        sessoes.set(linha.sessionId, atual);
      }

      const dias = new Map<string, FunilDoDia>();
      for (const sessao of sessoes.values()) {
        const dia = diaLocal(sessao.inicioMs);
        const atual = dias.get(dia) ?? { dia, visitas: 0, quiz: 0, vsl: 0, checkout: 0 };
        atual.visitas += 1;
        if (sessao.estagio >= 2) atual.quiz += 1;
        if (sessao.estagio >= 3) atual.vsl += 1;
        if (sessao.estagio >= 4) atual.checkout += 1;
        dias.set(dia, atual);
      }
      return [...dias.values()].sort((a, b) => a.dia.localeCompare(b.dia));
    },

    /** Mesma leitura da versão Postgres, com o mesmo montador ao final. */
    async resumoDoFunil({ desde, ate, agoraMs }) {
      const corte = Date.parse(desde);
      const teto = Date.parse(ate);
      const limiteDeAbandono = agoraMs - 30 * 60_000;

      interface Sessao {
        ultimaEtapa: number;
        primeiro: number;
        ultimo: number;
        gerouPix: number | null;
        chegouNaOferta: number | null;
        temPedido: boolean;
        temTelasDoMeio: boolean;
      }
      const sessoes = new Map<string, Sessao>();

      for (const linha of funil) {
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;

        const etapa = Math.max(linha.step ?? 0, 0);
        const atual = sessoes.get(linha.sessionId) ?? {
          ultimaEtapa: 0,
          primeiro: quando,
          ultimo: quando,
          gerouPix: null,
          chegouNaOferta: null,
          temPedido: false,
          temTelasDoMeio: false,
        };

        if (etapa >= 1 && etapa <= 11) atual.temTelasDoMeio = true;
        atual.ultimaEtapa = Math.max(atual.ultimaEtapa, etapa);
        atual.primeiro = Math.min(atual.primeiro, quando);
        atual.ultimo = Math.max(atual.ultimo, quando);
        if (linha.evento === 'AddPaymentInfo') atual.gerouPix = Math.max(atual.gerouPix ?? 0, quando);
        if (etapa >= 13) atual.chegouNaOferta = Math.max(atual.chegouNaOferta ?? 0, quando);
        atual.temPedido = atual.temPedido || Boolean(linha.pedidoId);
        sessoes.set(linha.sessionId, atual);
      }

      const mediana = (valores: number[]): number | null => {
        if (valores.length === 0) return null;
        const ordenados = [...valores].sort((a, b) => a - b);
        const meio = Math.floor(ordenados.length / 2);
        return ordenados.length % 2 === 0 ? (ordenados[meio - 1] + ordenados[meio]) / 2 : ordenados[meio];
      };

      const todas = [...sessoes.values()];
      const ateAOferta = mediana(
        todas.filter((s) => s.chegouNaOferta !== null).map((s) => (s.chegouNaOferta! - s.primeiro) / 1000),
      );
      const ateOPix = mediana(
        todas.filter((s) => s.gerouPix !== null).map((s) => (s.gerouPix! - s.primeiro) / 1000),
      );

      const porEtapa = new Map<number, { pararam: number; abandonaram: number; comTelasDoMeio: number }>();
      for (const sessao of todas) {
        const atual = porEtapa.get(sessao.ultimaEtapa) ?? { pararam: 0, abandonaram: 0, comTelasDoMeio: 0 };
        atual.pararam += 1;
        if (sessao.ultimo < limiteDeAbandono && !sessao.temPedido) atual.abandonaram += 1;
        if (sessao.temTelasDoMeio) atual.comTelasDoMeio += 1;
        porEtapa.set(sessao.ultimaEtapa, atual);
      }

      return montarResumoDoFunil(
        [...porEtapa.entries()].map(([ultimaEtapa, contagem], indice) => ({
          ultimaEtapa,
          pararam: contagem.pararam,
          abandonaram: contagem.abandonaram,
          comTelasDoMeio: contagem.comTelasDoMeio,
          // A mediana e do conjunto todo: vai numa linha so, como no Postgres,
          // onde ela chega repetida em cada grupo.
          medianaAteOferta: indice === 0 ? ateAOferta : null,
          medianaAtePix: indice === 0 ? ateOPix : null,
        })),
      );
    },

    /** Mesma contagem da versão Postgres: uma pessoa por escolha, não um evento. */
    async respostasDoQuiz({ desde, ate, sessoesQueCompraram }) {
      const corte = Date.parse(desde);
      const teto = Date.parse(ate);
      const compradoras = new Set(sessoesQueCompraram);
      const grupos = new Map<string, { pergunta: string; resposta: string; sessoes: Set<string> }>();

      for (const linha of funil) {
        if (!linha.pergunta || !linha.resposta) continue;
        const quando = Date.parse(linha.t);
        if (quando < corte || quando >= teto) continue;

        const chave = `${linha.pergunta} ${linha.resposta}`;
        const atual = grupos.get(chave) ?? { pergunta: linha.pergunta, resposta: linha.resposta, sessoes: new Set() };
        atual.sessoes.add(linha.sessionId);
        grupos.set(chave, atual);
      }

      return [...grupos.values()]
        .map((g) => ({
          pergunta: g.pergunta,
          resposta: g.resposta,
          pessoas: g.sessoes.size,
          compraram: [...g.sessoes].filter((s) => compradoras.has(s)).length,
        }))
        .sort((a, b) => a.pergunta.localeCompare(b.pergunta) || b.pessoas - a.pessoas);
    },

    /** Mesma leitura da versão Postgres: o pedido mais recente de cada sessão. */
    async pedidosDeOracao({ desde, limite }) {
      const corte = Date.parse(desde);
      const porSessao = new Map<string, PedidoDeOracaoBruto>();
      for (const linha of funil) {
        if (!ehPedidoDeOracao(linha.pergunta) || !linha.resposta) continue;
        if (Date.parse(linha.t) < corte) continue;
        const atual = porSessao.get(linha.sessionId);
        if (atual && atual.quando >= linha.t) continue;
        porSessao.set(linha.sessionId, {
          sessionId: linha.sessionId,
          quando: linha.t,
          resposta: linha.resposta,
          utmContent: linha.atribuicao?.utm_content ?? null,
          fbAdId: linha.atribuicao?.fb_ad_id ?? null,
        });
      }
      return [...porSessao.values()].sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, limite);
    },

    async eventosDasSessoes({ sessoes }) {
      const pedidas = new Set(sessoes);
      return funil
        .filter((l) => pedidas.has(l.sessionId))
        .sort((a, b) => a.t.localeCompare(b.t))
        .map((l) => ({
          sessionId: l.sessionId,
          t: l.t,
          evento: l.evento,
          step: l.step ?? null,
          pedidoId: l.pedidoId ?? null,
          pergunta: l.pergunta ?? null,
          resposta: l.resposta ?? null,
          atribuicao: l.atribuicao ?? {},
        }));
    },

    async sessoesDaJanela({ desde, ate, limite }) {
      const corte = Date.parse(desde);
      const teto = Date.parse(ate);
      const porSessao = new Map<string, SessaoResumida>();
      for (const l of funil) {
        const q = Date.parse(l.t);
        if (q < corte || q >= teto) continue;
        const atual = porSessao.get(l.sessionId) ?? {
          sessionId: l.sessionId,
          primeiroEm: l.t,
          ultimoEm: l.t,
          stepMaximo: 0,
          temPedidoDeOracao: false,
        };
        if (l.t < atual.primeiroEm) atual.primeiroEm = l.t;
        if (l.t > atual.ultimoEm) atual.ultimoEm = l.t;
        atual.stepMaximo = Math.max(atual.stepMaximo, l.step ?? 0);
        if (ehPedidoDeOracao(l.pergunta)) atual.temPedidoDeOracao = true;
        porSessao.set(l.sessionId, atual);
      }
      return [...porSessao.values()]
        .filter((s) => s.stepMaximo >= 1 || s.temPedidoDeOracao)
        .sort((a, b) => b.ultimoEm.localeCompare(a.ultimoEm))
        .slice(0, limite);
    },

    async registrarAuditoria(entrada) {
      auditoria.unshift({ id: String(auditoria.length + 1), t: new Date().toISOString(), ...entrada });
      if (auditoria.length > 2000) auditoria.length = 2000;
    },

    async listarAuditoria({ desde, limite, papel }) {
      return auditoria
        .filter((r) => r.t >= desde && (!papel || r.papel === papel))
        .slice(0, limite);
    },

    async listarNotasCrm(sessao) {
      return notasCrm.filter((n) => n.sessao === sessao).sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
    },

    async listarMarcacoesCrm(sessoes) {
      const mapa = new Map<string, MarcacaoCrm>();
      for (const s of sessoes) {
        const m = marcacoesCrm.get(s);
        if (m) mapa.set(s, m);
      }
      return mapa;
    },

    async salvarNotaCrm({ sessao, autor, texto }) {
      const nota: NotaCrm = { id: String(notasCrm.length + 1), sessao, autor, texto, criadaEm: new Date().toISOString() };
      notasCrm.push(nota);
      return nota;
    },

    async salvarMarcacaoCrm({ sessao, statusManual, optOut, contatadoEm }) {
      const atual = marcacoesCrm.get(sessao);
      const novo: MarcacaoCrm = {
        sessao,
        statusManual: statusManual === undefined ? (atual?.statusManual ?? null) : statusManual,
        optOut: optOut === undefined ? (atual?.optOut ?? false) : optOut,
        contatadoEm: contatadoEm === undefined ? (atual?.contatadoEm ?? null) : contatadoEm,
        atualizadaEm: new Date().toISOString(),
      };
      marcacoesCrm.set(sessao, novo);
      return novo;
    },

    async registrarPedidoDeBoleto(entrada) {
      const corte = Date.now() - BOLETO_REPETIDO_MS;
      const repetido = [...boletos.values()]
        .filter(
          (b) =>
            b.documento === entrada.documento &&
            b.valorCentavos === entrada.valorCentavos &&
            b.situacao === 'pedido' &&
            Date.parse(b.criadoEm) >= corte,
        )
        .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm))[0];

      if (repetido) {
        const tocado = { ...repetido, atualizadoEm: new Date().toISOString() };
        boletos.set(tocado.id, tocado);
        return { pedido: tocado, jaExistia: true };
      }

      const agora = new Date().toISOString();
      const pedido: PedidoDeBoletoRegistrado = {
        ...entrada,
        id: `bol_${newId(8)}`,
        criadoEm: agora,
        atualizadoEm: agora,
        situacao: 'pedido',
        observacao: null,
        geradoEm: null,
        pagoEm: null,
        naoPagoEm: null,
        metaEventId: null,
        metaEnviadoEm: null,
      };
      boletos.set(pedido.id, pedido);
      return { pedido, jaExistia: false };
    },

    async listarPedidosDeBoleto({ desde, limite }) {
      return [...boletos.values()]
        .filter((b) => b.criadoEm >= desde)
        .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm))
        .slice(0, limite);
    },

    async obterPedidoDeBoleto(id) {
      return boletos.get(id) ?? null;
    },

    async atualizarPedidoDeBoleto(id, mudanca) {
      const atual = boletos.get(id);
      if (!atual) return null;
      const novo: PedidoDeBoletoRegistrado = {
        ...atual,
        situacao: mudanca.situacao ?? atual.situacao,
        observacao: mudanca.observacao === undefined ? atual.observacao : mudanca.observacao,
        geradoEm: mudanca.geradoEm === undefined ? atual.geradoEm : mudanca.geradoEm,
        pagoEm: mudanca.pagoEm === undefined ? atual.pagoEm : mudanca.pagoEm,
        naoPagoEm: mudanca.naoPagoEm === undefined ? atual.naoPagoEm : mudanca.naoPagoEm,
        metaEventId: mudanca.metaEventId === undefined ? atual.metaEventId : mudanca.metaEventId,
        metaEnviadoEm: mudanca.metaEnviadoEm === undefined ? atual.metaEnviadoEm : mudanca.metaEnviadoEm,
        atualizadoEm: new Date().toISOString(),
      };
      boletos.set(id, novo);
      return novo;
    },

    async chaveDasSessoes({ sessoes, agrupamento, desde }) {
      const corte = Date.parse(desde);
      const procuradas = new Set(sessoes);
      const achadas = new Map<string, string>();

      for (const linha of funil) {
        if (!procuradas.has(linha.sessionId)) continue;
        if (Date.parse(linha.t) < corte) continue;
        const grupo = chaveDoGrupo(linha.atribuicao, agrupamento);
        if (grupo !== '') achadas.set(linha.sessionId, grupo);
      }

      return achadas;
    },

    async salvarInvestimento(entrada) {
      guardarInvestimento(entrada);
    },

    async listarInvestimentos({ desde, ate, nivel, bm }) {
      const marca = bm === undefined || bm === null || bm === '' ? null : bm;
      return [...investimentos.values()].filter(
        (item) =>
          item.dia >= desde &&
          (!ate || item.dia < ate) &&
          (!nivel || (item.nivel ?? 'campanha') === nivel) &&
          (marca === null || (item.bm ?? '') === marca),
      );
    },

    async salvarInvestimentos(linhas) {
      for (const linha of linhas) guardarInvestimento(linha);
    },

    async lerConfiguracao(chave) {
      return configuracoes.get(chave) ?? null;
    },

    async salvarConfiguracao(chave, valor) {
      configuracoes.set(chave, valor);
    },

    async reservarEnvioMeta(entrada) {
      if (enviosMeta.has(entrada.eventId)) return false;
      enviosMeta.set(entrada.eventId, {
        id: proximoId++,
        t: new Date().toISOString(),
        pedidoId: entrada.pedidoId ?? null,
        evento: entrada.evento,
        eventId: entrada.eventId,
        statusHttp: null,
        resposta: null,
        tentativas: 0,
        sucesso: false,
        chaves: null,
      });
      return true;
    },

    async concluirEnvioMeta(entrada) {
      const atual = enviosMeta.get(entrada.eventId);
      if (!atual) return;
      enviosMeta.set(entrada.eventId, {
        ...atual,
        sucesso: entrada.sucesso,
        statusHttp: entrada.statusHttp,
        resposta: entrada.resposta.slice(0, 500),
        tentativas: entrada.tentativas,
        chaves: entrada.chaves ?? atual.chaves,
        t: new Date().toISOString(),
      });
    },

    async listarEnviosMeta({ limite, sóPendentes }) {
      return [...enviosMeta.values()]
        .filter((envio) => (sóPendentes ? !envio.sucesso : true))
        .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
        .slice(0, limite);
    },
  };
}

/* -------------------------------------------------------------------------- */

const repositorio: RepositorioDoPainel = config.databaseUrl
  ? criarRepositorioPostgres(config.databaseUrl)
  : criarRepositorioEmMemoria();

if (repositorio.tipo === 'memoria') {
  logger.warn('Painel sem banco: links de entrega e histórico ficam só na memória deste processo.');
}

export function repositorioDoPainel(): RepositorioDoPainel {
  return repositorio;
}
