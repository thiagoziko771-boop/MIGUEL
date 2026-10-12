import { config } from './config.js';
import { logger } from './logger.js';
import { cifrar, decifrar, podeGuardarToken } from './metaCredenciais.js';
import { listarBmsCadastradas, tokenAdsDaBm } from './bms.js';
import { repositorioDoPainel, type Investimento, type NivelDeInvestimento } from './painel/repositorio.js';

/**
 * Quanto foi gasto em anúncio, direto da API de Marketing do Meta.
 *
 * É o caminho INVERSO do que server/meta.ts faz. Lá o funil manda evento para o
 * Meta; aqui o painel busca no Meta o que ele sabe e nós não: o dinheiro que
 * saiu. Sem esse número a aba Anúncios mostra faturamento, nunca retorno — e
 * faturamento sozinho manda escalar anúncio que dá prejuízo.
 *
 * Até aqui esse dado entrava à mão, ou por uma planilha publicada do Google
 * (server/investimento.ts). As duas continuam valendo; esta é a terceira via, e
 * a única que não depende de alguém lembrar de fazer.
 *
 * QUATRO COISAS QUE MUDAM O COMPORTAMENTO e não se descobre lendo o código:
 *
 * 1. O TOKEN NÃO É O MESMO DA API DE CONVERSÕES. Aquele tem permissão de
 *    ESCREVER evento; este precisa de `ads_read`, que é de LER a conta. Colar um
 *    no lugar do outro devolve erro 200 com corpo de erro, não 401.
 * 2. `time_increment=1` é obrigatório para nós. Sem ele o Meta devolve o gasto
 *    somado do período inteiro, e a tabela do painel é por dia — um total
 *    agregado gravado como se fosse de um dia só arruinaria o histórico.
 * 3. O GASTO DE HOJE MUDA O DIA INTEIRO. A conta ainda está rodando, e o Meta
 *    também revisa números de dias fechados por até 72 h (fraude, cobrança
 *    corrigida). Por isso a importação regrava a janela toda em vez de só o que
 *    falta: o `ON CONFLICT` da tabela existe para isso.
 * 4. O VALOR VEM EM REAIS, COM PONTO ("12.34"), na moeda da conta. O painel
 *    guarda centavos inteiros. Arredondar errado aqui vira diferença de
 *    centavos que ninguém explica no fim do mês.
 */

export const CHAVE_CONTA = 'meta.ads_account_id';
export const CHAVE_TOKEN_ADS = 'meta.ads_token';
export const CHAVE_ULTIMA_IMPORTACAO_META = 'meta.ads_ultima_importacao';

/** Erro com mensagem que pode ir para a tela do dono, sem jargão. */
export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly codigo: string,
  ) {
    super(message);
    this.name = 'MetaAdsError';
  }
}

export interface CredenciaisDeAnuncios {
  contaId: string;
  token: string;
  ligado: boolean;
  /** Havia token guardado, mas a chave mestra de hoje não abre. */
  tokenIlegivel: boolean;
}

/**
 * O identificador da conta como o Meta espera: `act_` seguido só de dígitos.
 *
 * O dono vai colar o que estiver na tela do Gerenciador, e ali o número aparece
 * de três jeitos conforme a página — com o prefixo, sem o prefixo, ou dentro de
 * uma URL. Aceitar os três e normalizar aqui evita o erro mais chato possível:
 * credencial certa recusada por causa de quatro caracteres.
 */
export function normalizarConta(bruto: string): string {
  const digitos = (bruto ?? '').replace(/[^\d]/g, '');
  return digitos === '' ? '' : `act_${digitos}`;
}

export async function credenciaisDeAnuncios(): Promise<CredenciaisDeAnuncios> {
  let conta = '';
  let guardado = '';

  try {
    const repo = repositorioDoPainel();
    const [c, t] = await Promise.all([repo.lerConfiguracao(CHAVE_CONTA), repo.lerConfiguracao(CHAVE_TOKEN_ADS)]);
    conta = (c ?? '').trim();
    guardado = (t ?? '').trim();
  } catch (erro) {
    logger.warn('Não consegui ler as credenciais de anúncios do Meta', { erro: (erro as Error).message });
  }

  const aberto = guardado === '' ? null : decifrar(guardado);
  const tokenIlegivel = guardado !== '' && aberto === null;
  const token = (aberto ?? '').trim();

  return { contaId: conta, token, ligado: Boolean(conta && token), tokenIlegivel };
}

export async function salvarCredenciaisDeAnuncios(entrada: { contaId?: string; token?: string }): Promise<void> {
  const repo = repositorioDoPainel();

  if (entrada.contaId !== undefined) {
    await repo.salvarConfiguracao(CHAVE_CONTA, normalizarConta(entrada.contaId));
  }

  if (entrada.token !== undefined) {
    const limpo = entrada.token.trim();
    if (limpo === '') {
      // Campo esvaziado de propósito: é assim que se desliga a importação.
      await repo.salvarConfiguracao(CHAVE_TOKEN_ADS, '');
    } else {
      if (!podeGuardarToken()) {
        throw new MetaAdsError(
          'Sem a chave mestra do painel não há como guardar o token com segurança. Configure PAINEL_CHAVE_MESTRA.',
          'SEM_CHAVE_MESTRA',
        );
      }
      await repo.salvarConfiguracao(CHAVE_TOKEN_ADS, cifrar(limpo));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* A chamada                                                                   */
/* -------------------------------------------------------------------------- */

/** Nível do relatório no vocabulário do Meta. */
const NIVEL_DO_META: Record<NivelDeInvestimento, string> = {
  campanha: 'campaign',
  conjunto: 'adset',
  anuncio: 'ad',
};

/** De onde sai a chave de cada linha, por nível. É o mesmo ID que a URL carimba. */
const CAMPO_DA_CHAVE: Record<NivelDeInvestimento, string> = {
  campanha: 'campaign_id',
  conjunto: 'adset_id',
  anuncio: 'ad_id',
};

interface LinhaDoMeta {
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
}

/**
 * Reais com ponto decimal viram centavos inteiros.
 *
 * `Math.round` e não truncamento: o Meta manda "0.07" para gasto de sete
 * centavos, e truncar zeraria os dias de teste — justamente os que o dono olha
 * com mais atenção quando está começando uma campanha.
 */
function paraCentavos(valor: string | undefined): number {
  const numero = Number.parseFloat((valor ?? '0').trim());
  return Number.isFinite(numero) ? Math.round(numero * 100) : 0;
}

function paraInteiro(valor: string | undefined): number {
  const numero = Number.parseInt((valor ?? '0').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(numero) ? numero : 0;
}

/** Traduz o que o Meta reclama para algo que o dono resolve sozinho. */
function traduzirErro(status: number, corpo: string): MetaAdsError {
  const texto = corpo.toLowerCase();

  if (texto.includes('ads_read') || texto.includes('permission')) {
    return new MetaAdsError(
      'O token não tem permissão para ler os anúncios. Ele precisa de "ads_read" — o token da API de Conversões não serve aqui.',
      'SEM_PERMISSAO',
    );
  }
  if (status === 400 && (texto.includes('unsupported get request') || texto.includes('does not exist'))) {
    return new MetaAdsError(
      'Não encontrei essa conta de anúncios. Confira o número (ele aparece como act_1234567890 no Gerenciador) e se o token pertence ao mesmo Business.',
      'CONTA_NAO_ENCONTRADA',
    );
  }
  if (texto.includes('expired') || texto.includes('session has been invalidated') || status === 401) {
    return new MetaAdsError(
      'O token expirou ou foi invalidado. Gere outro pelo usuário do sistema no Business Manager.',
      'TOKEN_INVALIDO',
    );
  }
  if (status === 429 || texto.includes('rate limit') || texto.includes('too many calls')) {
    return new MetaAdsError(
      'O Meta pediu para esperar: muitas consultas seguidas. A importação automática tenta de novo mais tarde.',
      'LIMITE_DE_CHAMADAS',
    );
  }

  return new MetaAdsError(`O Meta respondeu ${status}: ${corpo.slice(0, 160)}`, 'ERRO_DO_META');
}

/* -------------------------------------------------------------------------- */
/* O que está ligado agora                                                     */
/* -------------------------------------------------------------------------- */

export const CHAVE_ESTADO_ANUNCIOS = 'meta.ads_estado';

/** Onde mora o cadastro de cada nível — nome e situação vivem aqui, não no insights. */
const COLECAO_DO_META: Record<NivelDeInvestimento, string> = {
  campanha: 'campaigns',
  conjunto: 'adsets',
  anuncio: 'ads',
};

export interface EstadoDoAnuncio {
  nome: string;
  ativo: boolean;
  /**
   * Quem está um degrau acima: a campanha de um conjunto, o conjunto de um
   * anúncio. Vazio na campanha, que é o topo.
   *
   * Existe para o painel poder descer a hierarquia — clicar numa campanha e
   * ver só os conjuntos dela. Sem isso, a tabela de conjuntos é uma lista
   * solta, e quem tem cinco campanhas precisa reconhecer o filho pelo nome.
   */
  pai?: string | null;
}

interface LinhaDeEstado {
  id?: string;
  name?: string;
  effective_status?: string;
  campaign_id?: string;
  adset_id?: string;
}

/**
 * Ativo é só `ACTIVE`. Isso é uma decisão, não um detalhe de implementação.
 *
 * O Meta tem uma dúzia de situações: pausado, arquivado, reprovado, em análise,
 * pausado porque a campanha acima está pausada. A pergunta do dono é uma só —
 * "está rodando agora?" — e qualquer coisa fora de ACTIVE responde não.
 *
 * O QUE ISSO NÃO COBRE: conta restrita por pagamento mantém o anúncio ACTIVE e
 * mesmo assim sem entrega nenhuma. Um anúncio pode constar aqui como ativo e
 * não estar sendo mostrado a ninguém.
 */
function ehAtivo(status: string | undefined): boolean {
  return (status ?? '').trim().toUpperCase() === 'ACTIVE';
}

async function buscarEstadoDoNivel(
  credenciais: CredenciaisDeAnuncios,
  nivel: NivelDeInvestimento,
  timeoutMs: number,
): Promise<Record<string, EstadoDoAnuncio>> {
  const url = new URL(
    `${config.meta.baseUrl}/${config.meta.apiVersion}/${credenciais.contaId}/${COLECAO_DO_META[nivel]}`,
  );
  /*
   * O campo do pai muda com o nível, e a campanha não tem pai nenhum. Pedir
   * `campaign_id` numa campanha não dá erro, mas devolve ela mesma — o que
   * criaria um pai apontando para o próprio filho.
   */
  const campoDoPai = nivel === 'conjunto' ? 'campaign_id' : nivel === 'anuncio' ? 'adset_id' : null;
  url.searchParams.set('fields', ['id', 'name', 'effective_status', campoDoPai].filter(Boolean).join(','));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', credenciais.token);

  const linhas = await pedirAoMeta<LinhaDeEstado>(url, timeoutMs);
  const mapa: Record<string, EstadoDoAnuncio> = {};

  for (const linha of linhas) {
    const id = (linha.id ?? '').trim();
    if (id === '') continue;
    const pai = nivel === 'conjunto' ? linha.campaign_id : nivel === 'anuncio' ? linha.adset_id : null;
    mapa[id] = {
      nome: (linha.name ?? '').trim(),
      ativo: ehAtivo(linha.effective_status),
      pai: (pai ?? '').trim() || null,
    };
  }

  return mapa;
}

/**
 * Guarda numa configuração só o nome e a situação de tudo que existe na conta.
 *
 * Configuração, e não tabela nova por dia: situação é uma foto do AGORA. Amanhã
 * o anúncio pode estar pausado e ninguém vai perguntar como ele estava na
 * terça — enquanto o gasto de terça é definitivo, e por isso aquele mora numa
 * tabela por dia.
 *
 * Os três níveis no mesmo mapa porque no Meta o identificador é único entre
 * campanha, conjunto e anúncio: não há colisão a temer.
 */
/**
 * Liga, desliga ou muda o orçamento de uma campanha — a partir do painel.
 *
 * NASCEU DE UM ERRO CARO, em 17/08/2026: as campanhas só podiam ser mexidas por
 * um script de linha de comando, longe dos números. Uma campanha que dava ROAS
 * de 2,13x acabou desligada porque a decisão aconteceu num terminal, e não na
 * tela onde o gasto, a receita e o lucro dela estavam à vista. Daí esta função:
 * decidir OLHANDO o painel, no mesmo lugar em que os números estão.
 *
 * A ação vai direto à Graph API com as credenciais que o painel já guarda
 * cifradas. Não há automação por trás — quem decide é quem clica.
 *
 * O orçamento só existe onde ele mora: na campanha, quando é CBO; no conjunto,
 * quando não é. O Meta recusa no nível errado, e a mensagem dele é devolvida ao
 * painel em vez de virar um "algo deu errado" que não ensina nada.
 */
export async function mudarCampanhaNoMeta(entrada: {
  id: string;
  ativo?: boolean;
  orcamentoDiarioCentavos?: number;
}): Promise<{ id: string; aplicado: Record<string, string> }> {
  const credenciais = await credenciaisDeAnuncios();
  if (!credenciais.ligado || !credenciais.token) {
    throw new MetaAdsError('Sem credenciais do Meta. Configure em Anúncios → Credenciais.', 'SEM_CREDENCIAL');
  }

  const corpo = new URLSearchParams();
  if (entrada.ativo !== undefined) corpo.set('status', entrada.ativo ? 'ACTIVE' : 'PAUSED');
  if (entrada.orcamentoDiarioCentavos !== undefined) {
    corpo.set('daily_budget', String(Math.round(entrada.orcamentoDiarioCentavos)));
  }
  if ([...corpo.keys()].length === 0) throw new MetaAdsError('Nada para alterar.', 'NADA_A_FAZER');
  corpo.set('access_token', credenciais.token);

  const resposta = await fetch(`${config.meta.baseUrl}/${config.meta.apiVersion}/${entrada.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo.toString(),
  });
  const dados = (await resposta.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!resposta.ok) {
    throw new MetaAdsError(dados?.error?.message ?? 'O Meta recusou a alteração.', 'META_RECUSOU');
  }

  const aplicado: Record<string, string> = {};
  for (const [chave, valor] of corpo.entries()) {
    if (chave !== 'access_token') aplicado[chave] = valor;
  }
  logger.info('Painel: campanha alterada no Meta', { id: entrada.id, ...aplicado });
  return { id: entrada.id, aplicado };
}

export async function importarEstadoDosAnuncios(timeoutMs = 15_000): Promise<number> {
  const credenciais = await credenciaisDeAnuncios();
  if (!credenciais.ligado) return 0;

  const mapa: Record<string, EstadoDoAnuncio> = {};
  for (const nivel of ['campanha', 'conjunto', 'anuncio'] as NivelDeInvestimento[]) {
    Object.assign(mapa, await buscarEstadoDoNivel(credenciais, nivel, timeoutMs));
  }

  await repositorioDoPainel().salvarConfiguracao(CHAVE_ESTADO_ANUNCIOS, JSON.stringify(mapa));
  return Object.keys(mapa).length;
}

/**
 * O que a tela lê. Nunca lança: sem estado guardado a tabela volta a ser o que
 * era antes disto existir — uma lista só, sem separar ligado de parado.
 */
export async function estadoDosAnuncios(): Promise<Record<string, EstadoDoAnuncio>> {
  try {
    const guardado = await repositorioDoPainel().lerConfiguracao(CHAVE_ESTADO_ANUNCIOS);
    if (!guardado) return {};
    const aberto = JSON.parse(guardado) as Record<string, EstadoDoAnuncio>;
    return aberto !== null && typeof aberto === 'object' ? aberto : {};
  } catch (erro) {
    logger.warn('Não consegui ler a situação dos anúncios', { erro: (erro as Error).message });
    return {};
  }
}

export interface ResultadoDaImportacao {
  linhas: Investimento[];
  /** Quantos dias a janela cobriu. Vai para a mensagem de conferência. */
  dias: number;
  totalCentavos: number;
}

/**
 * Uma consulta GET à Graph API, com relógio e erro já traduzido.
 *
 * Existe porque passaram a ser duas perguntas ao Meta — quanto gastou e o que
 * está ligado — e as duas falham exatamente pelos mesmos motivos. Tratar cada
 * uma no seu canto seria o jeito mais fácil de o dono ver "o token expirou"
 * numa tela e um silêncio inexplicável na outra, pelo mesmo token.
 */
async function pedirAoMeta<T>(url: URL, timeoutMs: number): Promise<T[]> {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), timeoutMs);

  let resposta: Response;
  try {
    resposta = await fetch(url, { signal: abortar.signal });
  } catch (erro) {
    throw new MetaAdsError(
      (erro as Error)?.name === 'AbortError'
        ? 'O Meta demorou demais para responder.'
        : 'Não consegui falar com o Meta. Tente de novo em alguns minutos.',
      'FALHA_DE_REDE',
    );
  } finally {
    clearTimeout(relogio);
  }

  const texto = await resposta.text().catch(() => '');
  if (!resposta.ok) throw traduzirErro(resposta.status, texto);

  let corpo: { data?: T[] };
  try {
    corpo = JSON.parse(texto) as { data?: T[] };
  } catch {
    throw new MetaAdsError('O Meta respondeu algo que não é JSON.', 'RESPOSTA_INVALIDA');
  }

  return Array.isArray(corpo.data) ? corpo.data : [];
}

/**
 * Busca o gasto de UM nível, dia a dia.
 *
 * Sem paginação por enquanto, e isso é uma escolha: com `limit=500` cabem 500
 * linhas, e uma linha é um dia de um anúncio. Esta conta tem uma dezena de
 * anúncios ativos e a importação roda todo dia sobre uma janela curta — chegar
 * a 500 exigiria 70 anúncios rodando ao mesmo tempo por sete dias. Se um dia
 * chegar, o log avisa em vez de a tela mostrar gasto pela metade.
 */
async function buscarNivel(
  credenciais: CredenciaisDeAnuncios,
  nivel: NivelDeInvestimento,
  desde: string,
  ate: string,
  timeoutMs: number,
  /** Qual BM está sendo lida. Vazio na importação da conta única e antiga. */
  bm = '',
): Promise<Investimento[]> {
  const campos = ['spend', 'impressions', 'clicks', CAMPO_DA_CHAVE[nivel]].join(',');
  // `config.meta.baseUrl` e não o endereço fixo: é a mesma variável que a API
  // de Conversões usa, e é ela que permite as baterias apontarem a um Graph
  // falso local em vez de falar com o Meta de verdade.
  const url = new URL(`${config.meta.baseUrl}/${config.meta.apiVersion}/${credenciais.contaId}/insights`);
  url.searchParams.set('level', NIVEL_DO_META[nivel]);
  url.searchParams.set('fields', campos);
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('time_range', JSON.stringify({ since: desde, until: ate }));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', credenciais.token);

  const linhas = await pedirAoMeta<LinhaDoMeta>(url, timeoutMs);
  if (linhas.length >= 500) {
    logger.warn('Importação de gasto do Meta atingiu o teto de linhas; pode haver dado faltando', { nivel });
  }

  const resultado: Investimento[] = [];
  for (const linha of linhas) {
    const chave = (linha[CAMPO_DA_CHAVE[nivel] as keyof LinhaDoMeta] ?? '') as string;
    const dia = (linha.date_start ?? '').trim();
    if (!chave || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;

    resultado.push({
      chave,
      dia,
      nivel,
      bm,
      centavos: paraCentavos(linha.spend),
      impressoes: paraInteiro(linha.impressions),
      cliques: paraInteiro(linha.clicks),
    });
  }

  return resultado;
}

/**
 * Importa o gasto dos últimos `dias` e grava no painel.
 *
 * Os três níveis, sempre. É o que faz a coluna "Investido" existir seja qual for
 * o agrupamento que o dono escolher na tabela — e cada um vai marcado com o seu
 * nível, para nunca serem somados juntos (ver NivelDeInvestimento).
 */
export async function importarInvestimentoDoMeta(opcoes: {
  dias?: number;
  hoje: string;
  timeoutMs?: number;
}): Promise<ResultadoDaImportacao> {
  const credenciais = await credenciaisDeAnuncios();

  if (credenciais.tokenIlegivel) {
    throw new MetaAdsError(
      'O token guardado não pôde ser aberto com a chave mestra atual. Cole o token de novo.',
      'TOKEN_ILEGIVEL',
    );
  }
  if (!credenciais.ligado) {
    throw new MetaAdsError(
      'Falta a conta de anúncios ou o token de leitura. Preencha os dois em Anúncios → Configuração.',
      'NAO_CONFIGURADO',
    );
  }

  /*
   * Sete dias por padrão, e não um.
   *
   * O Meta revisa números já fechados por até 72 h — cliques marcados como
   * inválidos, cobrança corrigida. Reimportar a última semana toda faz o painel
   * acompanhar essas correções sozinho; importar só ontem congelaria para sempre
   * a primeira versão de cada número.
   */
  const dias = Number.isFinite(opcoes.dias) && (opcoes.dias ?? 0) > 0 && (opcoes.dias ?? 0) <= 90
    ? Math.floor(opcoes.dias as number)
    : 7;

  const [ano, mes, dia] = opcoes.hoje.split('-').map(Number);
  const inicio = new Date(Date.UTC(ano, mes - 1, dia - (dias - 1)));
  const desde = inicio.toISOString().slice(0, 10);

  const niveis: NivelDeInvestimento[] = ['campanha', 'conjunto', 'anuncio'];
  const todas: Investimento[] = [];
  for (const nivel of niveis) {
    todas.push(...(await buscarNivel(credenciais, nivel, desde, opcoes.hoje, opcoes.timeoutMs ?? 15_000)));
  }

  if (todas.length > 0) await repositorioDoPainel().salvarInvestimentos(todas);
  await repositorioDoPainel().salvarConfiguracao(CHAVE_ULTIMA_IMPORTACAO_META, new Date().toISOString());

  /*
   * A situação vem junto, mas não manda na importação.
   *
   * Se o Meta entregar o gasto e falhar aqui, o dinheiro já está gravado e a
   * tela apenas deixa de separar ligados de parados até a próxima passada.
   * Deixar este erro subir desfaria uma importação inteira por causa da parte
   * menos importante das duas.
   */
  let anunciosCadastrados = 0;
  try {
    anunciosCadastrados = await importarEstadoDosAnuncios(opcoes.timeoutMs ?? 15_000);
  } catch (erro) {
    logger.warn('Importei o gasto, mas não a situação dos anúncios', { erro: (erro as Error).message });
  }

  /*
   * O total conferido é só o de campanha. Somar os três níveis daria três vezes
   * o gasto real — é o mesmo dinheiro contado de três alturas, e este número vai
   * direto para a mensagem que o dono lê depois de importar.
   */
  const totalCentavos = todas
    .filter((linha) => linha.nivel === 'campanha')
    .reduce((soma, linha) => soma + linha.centavos, 0);

  logger.info('Investimento importado do Meta', {
    dias,
    linhas: todas.length,
    totalCentavos,
    anunciosCadastrados,
  });
  return { linhas: todas, dias, totalCentavos };
}


/* --------------------------------------------------- Gasto por BM -------- */

/** Como uma conta se saiu na importação. Uma linha por BM, inclusive as que falharam. */
export interface ImportacaoDeUmaBm {
  bm: string;
  nome: string;
  contaAds: string;
  ok: boolean;
  /** O motivo, em português, quando `ok` é falso. */
  erro: string | null;
  linhas: number;
  /** Só o nível campanha — somar os três daria três vezes o gasto real. */
  totalCentavos: number;
}

export interface ResultadoPorBm {
  contas: ImportacaoDeUmaBm[];
  linhas: number;
  totalCentavos: number;
  /** Quantos dias a janela cobriu. */
  dias: number;
}

/**
 * Importa o gasto de CADA gerenciador, da conta de anúncios dele.
 *
 * É a metade que faltava para operar cinco BMs. O painel já sabia quanto cada
 * uma FATUROU — o `bm=` da URL carimba a visita e o pedido —, mas o gasto vinha
 * de uma conta só, sem dono. Receita separada por BM contra gasto de todas
 * juntas não é um relatório impreciso: mostra a BM boa com ROAS de 0,3 e a ruim
 * com ROAS infinito, e manda desligar exatamente a que estava pagando.
 *
 * CADA CONTA FALHA SOZINHA. Um token vencido numa BM não pode impedir a
 * importação das outras quatro: se abortasse tudo, o dono veria a tela inteira
 * zerada e concluiria que ninguém vendeu — no dia em que mais precisa decidir.
 * O que deu errado volta na lista, com nome e motivo.
 */
export async function importarInvestimentoPorBm(opcoes: {
  dias?: number;
  hoje: string;
  timeoutMs?: number;
}): Promise<ResultadoPorBm> {
  const dias = Number.isFinite(opcoes.dias) && (opcoes.dias ?? 0) > 0 && (opcoes.dias ?? 0) <= 90
    ? Math.floor(opcoes.dias as number)
    : 7;

  const [ano, mes, dia] = opcoes.hoje.split('-').map(Number);
  const desde = new Date(Date.UTC(ano, mes - 1, dia - (dias - 1))).toISOString().slice(0, 10);

  const cadastradas = (await listarBmsCadastradas()).filter((b) => b.ativa && b.contaAds !== '');
  const contas: ImportacaoDeUmaBm[] = [];
  const todas: Investimento[] = [];

  for (const bm of cadastradas) {
    const linha: ImportacaoDeUmaBm = {
      bm: bm.slug,
      nome: bm.nome,
      contaAds: bm.contaAds,
      ok: false,
      erro: null,
      linhas: 0,
      totalCentavos: 0,
    };

    try {
      /*
       * O token DA BM, sem cair para o geral.
       *
       * Aqui a queda para o token geral seria um defeito, não uma gentileza: o
       * token geral lê OUTRA conta de anúncios, e o gasto dela entraria gravado
       * com o carimbo desta BM. O número ficaria plausível e errado, que é a
       * única categoria de erro que ninguém encontra olhando.
       */
      const token = await tokenAdsDaBm(bm.slug);
      if (token === '') {
        throw new MetaAdsError(
          'Falta o token de leitura de anúncios desta BM (o campo "Token de leitura", não o de Conversões).',
          'SEM_TOKEN',
        );
      }

      const credenciais: CredenciaisDeAnuncios = {
        contaId: normalizarConta(bm.contaAds),
        token,
        ligado: true,
        tokenIlegivel: false,
      };

      const daBm: Investimento[] = [];
      for (const nivel of ['campanha', 'conjunto', 'anuncio'] as NivelDeInvestimento[]) {
        daBm.push(...(await buscarNivel(credenciais, nivel, desde, opcoes.hoje, opcoes.timeoutMs ?? 15_000, bm.slug)));
      }

      todas.push(...daBm);
      linha.ok = true;
      linha.linhas = daBm.length;
      linha.totalCentavos = daBm
        .filter((l) => l.nivel === 'campanha')
        .reduce((soma, l) => soma + l.centavos, 0);
    } catch (erro) {
      linha.erro = erro instanceof Error ? erro.message : 'Falha desconhecida ao ler esta conta.';
      logger.warn('Falha ao importar o gasto de uma BM; as outras seguem', {
        bm: bm.slug,
        erro: linha.erro,
      });
    }

    contas.push(linha);
  }

  if (todas.length > 0) await repositorioDoPainel().salvarInvestimentos(todas);
  await repositorioDoPainel().salvarConfiguracao(CHAVE_ULTIMA_IMPORTACAO_META, new Date().toISOString());

  const totalCentavos = contas.reduce((soma, c) => soma + c.totalCentavos, 0);
  logger.info('Investimento importado por BM', {
    dias,
    contas: contas.length,
    falharam: contas.filter((c) => !c.ok).length,
    totalCentavos,
  });

  return { contas, linhas: todas.length, totalCentavos, dias };
}

/**
 * Confere se as credenciais funcionam, sem gravar nada.
 *
 * Pede um dia só e um campo só: é a chamada mais barata que ainda prova que o
 * token lê a conta.
 */
export async function testarCredenciaisDeAnuncios(hoje: string): Promise<{ ok: true; conta: string }> {
  const credenciais = await credenciaisDeAnuncios();
  if (credenciais.tokenIlegivel) {
    throw new MetaAdsError('O token guardado não pôde ser aberto com a chave mestra atual.', 'TOKEN_ILEGIVEL');
  }
  if (!credenciais.ligado) {
    throw new MetaAdsError('Preencha a conta de anúncios e o token de leitura.', 'NAO_CONFIGURADO');
  }

  await buscarNivel(credenciais, 'campanha', hoje, hoje, 12_000);
  return { ok: true, conta: credenciais.contaId };
}
