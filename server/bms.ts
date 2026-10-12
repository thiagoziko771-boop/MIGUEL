/**
 * O cadastro dos gerenciadores de negócios (BMs).
 *
 * Cada BM tem pixel próprio e conta de anúncios própria. Este arquivo é o único
 * lugar que sabe disso — o resto do sistema pede a lista e recebe objetos
 * prontos, do mesmo jeito que faz com `credenciaisDoMeta`.
 *
 * POR QUE O CADASTRO EXISTE, se o `bm=` da URL já separa os números: porque
 * separar não é gerir. Com cinco contas, as perguntas que aparecem são "qual o
 * pixel desta aqui?" e "de qual conta importo o gasto?", e a resposta hoje mora
 * num papel ou na memória do dono. Um `bm=escala` no relatório sem cadastro é um
 * apelido órfão: ninguém lembra, três semanas depois, a qual gerenciador ele
 * pertencia.
 *
 * Guardado como JSON num campo só de `configuracoes`, e não em tabela própria.
 * São cinco linhas que mudam uma vez por mês; uma tabela custaria migração,
 * índice e um caminho de leitura a mais para ganhar nada.
 */
import { logger } from './logger.js';
import { cifrar, credenciaisDoMeta, decifrar, podeGuardarToken, type CredenciaisDoMeta } from './metaCredenciais.js';
import { repositorioDoPainel } from './painel/repositorio.js';

export const CHAVE_BMS = 'bms.lista';

export interface BmCadastrada {
  /**
   * O identificador que vai no `bm=` da URL do anúncio.
   *
   * Alfabeto fechado porque ele vem da URL, digitada à mão, e vira chave de
   * agrupamento no relatório. É o mesmo saneamento de server/atribuicao.ts, e
   * pelo mesmo motivo.
   */
  slug: string;
  /** Como o dono chama essa BM. Só rótulo: nada depende dele. */
  nome: string;
  /** Pixel do Meta desta BM. Vazio = usa o pixel geral do painel. */
  pixelId: string;
  /** Conta de anúncios (`act_...`), de onde o gasto é importado. */
  contaAds: string;
  ativa: boolean;
}

/** O que volta ao navegador: igual ao guardado, mais o token só mascarado. */
export interface BmParaOPainel extends BmCadastrada {
  /** Máscara do token da API de Conversões. O token inteiro nunca sai do servidor. */
  tokenMascarado: string;
  /** Máscara do token de leitura de anúncios. */
  tokenAdsMascarado: string;
}

const LIMITE_DE_BMS = 20;

function saneador(bruto: unknown): BmCadastrada | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const b = bruto as Record<string, unknown>;

  const slug = String(b.slug ?? '').trim().toLowerCase().slice(0, 64);
  if (!slug || !/^[a-z0-9_-]+$/.test(slug)) return null;

  return {
    slug,
    nome: String(b.nome ?? '').trim().slice(0, 80) || slug,
    /*
     * O pixel é só dígitos. Recusar o resto pega o erro que realmente acontece:
     * colar o bloco de <script> inteiro no campo. Sem isso o pixel não subiria
     * e nada acusaria erro — o rastreamento morreria em silêncio.
     */
    pixelId: String(b.pixelId ?? '').replace(/\D/g, '').slice(0, 32),
    /* Aceita `act_123` e `123`: o Gerenciador mostra os dois formatos em telas
       diferentes, e errar isso devolve "conta não encontrada" sem explicar. */
    contaAds: String(b.contaAds ?? '').replace(/\D/g, '').slice(0, 32),
    ativa: b.ativa !== false,
  };
}

/**
 * As BMs cadastradas.
 *
 * Nunca lança: a aba precisa abrir mesmo com o campo corrompido ou o banco
 * fora do ar. JSON inválido vira lista vazia com um aviso no log — o dono vê a
 * tela vazia e recadastra, em vez de ver erro 500 e não poder fazer nada.
 */
export async function listarBmsCadastradas(): Promise<BmCadastrada[]> {
  let bruto: string | null = null;
  try {
    bruto = await repositorioDoPainel().lerConfiguracao(CHAVE_BMS);
  } catch (erro) {
    logger.warn('Não consegui ler o cadastro de BMs', { erro: (erro as Error).message });
    return [];
  }
  if (!bruto) return [];

  try {
    const lista = JSON.parse(bruto);
    if (!Array.isArray(lista)) return [];
    const limpas = lista.map(saneador).filter((b): b is BmCadastrada => b !== null);
    // Slug duplicado: fica o último, que é o que o dono acabou de salvar.
    const porSlug = new Map(limpas.map((b) => [b.slug, b]));
    return [...porSlug.values()].slice(0, LIMITE_DE_BMS);
  } catch {
    logger.warn('O cadastro de BMs não é JSON válido; tratando como vazio');
    return [];
  }
}

/**
 * SÃO DOIS TOKENS DIFERENTES, e confundi-los custa caro.
 *
 * - **Conversões**: gerado no Gerenciador de EVENTOS, escopo do pixel. É o que
 *   manda a compra para o Meta.
 * - **Leitura de anúncios** (`ads_read`): gerado no app de negócios, escopo da
 *   CONTA. É o que traz quanto foi gasto.
 *
 * Um token completo faz os dois, e é por isso que a confusão passa despercebida
 * durante semanas: quem cola um token de escopo largo vê tudo funcionar. Quem
 * cola o token do Gerenciador de Eventos — o caminho mais comum, porque é o que
 * a documentação da API de Conversões manda gerar — vê o rastreamento funcionar
 * e a importação de gasto falhar com "(#278) Requires ads_read permission", que
 * não diz nada sobre haver dois campos.
 */

/** O token da API de CONVERSÕES desta BM, decifrado. Vazio quando não há. */
export async function tokenDaBm(slug: string): Promise<string> {
  return lerTokenCifrado(chaveDoToken(slug));
}

/**
 * O token de LEITURA DE ANÚNCIOS desta BM, decifrado.
 *
 * Cai para o token de Conversões quando não há um próprio: até 20/08/2026 havia
 * um campo só, e quem já tinha colado um token de escopo largo deixaria de
 * importar gasto no dia do deploy se a queda não existisse. Quando o token
 * antigo não servir, o erro vem do Meta e a tela explica.
 */
export async function tokenAdsDaBm(slug: string): Promise<string> {
  return (await lerTokenCifrado(chaveDoTokenAds(slug))) || (await tokenDaBm(slug));
}

/**
 * O token de leitura CADASTRADO nesta BM, sem a queda para o de Conversões.
 *
 * É o que a tela mostra: a queda existe para não quebrar quem já tinha um token
 * largo, mas exibi-la como se fosse um token de leitura preenchido esconderia do
 * dono o campo que ele ainda precisa preencher — e o campo em branco é o aviso.
 */
export async function tokenAdsCadastradoDaBm(slug: string): Promise<string> {
  return lerTokenCifrado(chaveDoTokenAds(slug));
}

async function lerTokenCifrado(chave: string): Promise<string> {
  try {
    const guardado = await repositorioDoPainel().lerConfiguracao(chave);
    if (!guardado) return '';
    return decifrar(guardado) ?? '';
  } catch {
    return '';
  }
}

/**
 * O token de cada BM em chave PRÓPRIA, e não dentro do JSON da lista.
 *
 * Assim o JSON da lista pode ser lido, logado e depurado sem carregar segredo
 * junto — e é exatamente isso que acontece quando alguém investiga por que uma
 * BM sumiu do relatório.
 */
function chaveDoToken(slug: string): string {
  return `bms.token.${slug}`;
}

function chaveDoTokenAds(slug: string): string {
  return `bms.tokenads.${slug}`;
}

export async function guardarBms(lista: unknown[]): Promise<BmCadastrada[]> {
  const limpas = lista.map(saneador).filter((b): b is BmCadastrada => b !== null);
  const porSlug = new Map(limpas.map((b) => [b.slug, b]));
  const final = [...porSlug.values()].slice(0, LIMITE_DE_BMS);
  await repositorioDoPainel().salvarConfiguracao(CHAVE_BMS, JSON.stringify(final));
  return final;
}

/** Grava o token da API de Conversões de uma BM. String vazia apaga. */
export async function guardarTokenDaBm(slug: string, token: string): Promise<void> {
  await guardarCifrado(chaveDoToken(slug), token);
}

/** Grava o token de leitura de anúncios de uma BM. String vazia apaga. */
export async function guardarTokenAdsDaBm(slug: string, token: string): Promise<void> {
  await guardarCifrado(chaveDoTokenAds(slug), token);
}

async function guardarCifrado(chave: string, token: string): Promise<void> {
  const limpo = token.trim();
  if (limpo !== '' && !podeGuardarToken()) {
    throw new Error('Sem PAINEL_CHAVE_MESTRA não há como cifrar o token.');
  }
  await repositorioDoPainel().salvarConfiguracao(chave, limpo === '' ? '' : cifrar(limpo));
}


/**
 * As credenciais do Meta para uma BM específica.
 *
 * É o que faz cinco gerenciadores otimizarem de verdade. Sem isto, os cinco
 * mandam evento para o mesmo pixel: cada conta enxerga as conversões das outras
 * quatro, o algoritmo de cada uma aprende com tráfego que ela não comprou, e o
 * resultado é pior do que não rastrear — porque parece certo.
 *
 * **Cai para o geral, sempre.** BM sem pixel próprio, BM não cadastrada e
 * visitante sem carimbo continuam indo para o pixel do painel. O contrário —
 * deixar de enviar quando a BM não está configurada — perderia venda de verdade
 * por causa de um cadastro incompleto, e o dono descobriria semanas depois.
 */
export async function credenciaisDaBm(bm: string | null | undefined): Promise<CredenciaisDoMeta> {
  const geral = await credenciaisDoMeta();

  const marca = (bm ?? '').trim().toLowerCase();
  if (!marca) return geral;

  const cadastrada = (await listarBmsCadastradas()).find((b) => b.slug === marca);
  if (!cadastrada || !cadastrada.ativa) return geral;

  const pixelId = cadastrada.pixelId || geral.pixelId;
  const token = (await tokenDaBm(marca)) || geral.token;

  /*
   * `ligado` continua sendo do GERAL: o interruptor do painel desliga o
   * rastreamento inteiro, e uma BM não pode furar isso. Mas sem pixel ou sem
   * token não há o que enviar, e mandar assim gera erro na API do Meta a cada
   * evento — barulho que esconde falha de verdade no log.
   */
  return { ...geral, pixelId, token, ligado: geral.ligado && pixelId !== '' && token !== '' };
}

/** A máscara que volta ao navegador. O token inteiro nunca sai do servidor. */
export function mascararToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '•'.repeat(token.length);
  return `${token.slice(0, 4)}${'•'.repeat(Math.min(20, token.length - 8))}${token.slice(-4)}`;
}
