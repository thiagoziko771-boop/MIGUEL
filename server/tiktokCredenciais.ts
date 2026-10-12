/**
 * De onde saem o pixel e os parâmetros de rastreio do TikTok.
 *
 * Espelha server/metaCredenciais.ts, e a ordem de precedência é a mesma:
 * **o painel manda, o ambiente é o piso**. Quem lê `process.env` direto ignora
 * em silêncio o que o dono digitou no /admin — foi a regra 13 do CLAUDE.md que
 * nasceu de exatamente esse bug com o Meta, e não vale a pena repeti-lo aqui.
 *
 * O token da API de Eventos é cifrado com a PAINEL_CHAVE_MESTRA, que vive fora
 * do banco: um dump do Postgres sozinho não entrega credencial de anúncio.
 * Reaproveitar `cifrar`/`decifrar` do Meta não é atalho — é garantir que os dois
 * usem o mesmo cofre, para trocar a chave mestra não deixar metade do sistema
 * legível e a outra metade não.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { cifrar, decifrar, podeGuardarToken } from './metaCredenciais.js';
import { repositorioDoPainel } from './painel/repositorio.js';

export const CHAVE_PIXEL = 'tiktok.pixel_id';
export const CHAVE_TOKEN = 'tiktok.events_token';
export const CHAVE_LIGADO = 'tiktok.ligado';
/**
 * Os parâmetros de URL que os anúncios do TikTok carimbam.
 *
 * Guardado como JSON num campo só, e não uma chave por parâmetro, porque a
 * lista muda: o TikTok acrescentou macro nova três vezes desde 2024, e cada
 * acréscimo viraria uma migração de banco se fossem colunas.
 */
export const CHAVE_PARAMETROS = 'tiktok.parametros';

const TRUTHY = new Set(['1', 'true', 'sim', 'on', 'ligado']);

/**
 * As macros que o TikTok Ads Manager substitui na URL de destino.
 *
 * O padrão existe para o dono não precisar decorar a sintaxe do TikTok, que é
 * `__NOME__` com dois underscores de cada lado — diferente do `{{campaign.id}}`
 * do Meta, e trocar um pelo outro faz o parâmetro chegar literal, com as chaves
 * e tudo, poluindo o relatório sem que nada acuse erro.
 */
export const PARAMETROS_PADRAO_DO_TIKTOK = [
  'ttclid',
  'tt_campaign_id',
  'tt_adgroup_id',
  'tt_ad_id',
  'tt_placement',
  'tt_source',
];

export interface CredenciaisDoTikTok {
  pixelId: string;
  token: string;
  ligado: boolean;
  /** Nomes de parâmetro aceitos da URL. Nunca vazio: cai no padrão. */
  parametros: string[];
  /** Havia token guardado que não abriu? Sinal de chave mestra trocada. */
  tokenIlegivel: boolean;
  podeGuardarToken: boolean;
}

/** Cache curto, igual ao do Meta: o pixel é lido a cada visita. */
let cache: { valor: CredenciaisDoTikTok; expiraEm: number } | null = null;
const VALIDADE_MS = 30_000;

export function invalidarCredenciaisDoTikTok(): void {
  cache = null;
}

function normalizarParametros(bruto: string | null): string[] {
  if (!bruto) return PARAMETROS_PADRAO_DO_TIKTOK;
  let lista: unknown;
  try {
    lista = JSON.parse(bruto);
  } catch {
    return PARAMETROS_PADRAO_DO_TIKTOK;
  }
  if (!Array.isArray(lista)) return PARAMETROS_PADRAO_DO_TIKTOK;

  /*
   * Saneamento igual ao de server/atribuicao.ts: nome de parâmetro vem da URL,
   * então vem de fora. Limite de 64 e só letra, número e underscore — sem isso,
   * um nome forjado viraria chave de objeto no relatório do painel.
   */
  const limpos = lista
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().toLowerCase().slice(0, 64))
    .filter((n) => n !== '' && /^[a-z0-9_]+$/.test(n));

  const unicos = [...new Set(limpos)].slice(0, 40);
  return unicos.length ? unicos : PARAMETROS_PADRAO_DO_TIKTOK;
}

export async function credenciaisDoTikTok(): Promise<CredenciaisDoTikTok> {
  const agora = Date.now();
  if (cache && cache.expiraEm > agora) return cache.valor;

  let doPainel: { pixel: string | null; token: string | null; ligado: string | null; parametros: string | null } = {
    pixel: null,
    token: null,
    ligado: null,
    parametros: null,
  };

  /*
   * Banco fora do ar não pode desligar o rastreamento. O `catch` faz a leitura
   * cair para a variável de ambiente, que é o comportamento de antes do painel.
   */
  try {
    const repo = repositorioDoPainel();
    const [pixel, token, ligado, parametros] = await Promise.all([
      repo.lerConfiguracao(CHAVE_PIXEL),
      repo.lerConfiguracao(CHAVE_TOKEN),
      repo.lerConfiguracao(CHAVE_LIGADO),
      repo.lerConfiguracao(CHAVE_PARAMETROS),
    ]);
    doPainel = { pixel, token, ligado, parametros };
  } catch (erro) {
    logger.warn('Não consegui ler as credenciais do TikTok no banco; usando as variáveis de ambiente', {
      erro: (erro as Error).message,
    });
  }

  const doAmbiente = (process.env.TIKTOK_PIXEL_ID ?? '').trim();
  const pixelId = (doPainel.pixel ?? '').trim() || doAmbiente;

  const guardado = (doPainel.token ?? '').trim();
  const aberto = guardado === '' ? null : decifrar(guardado);
  const tokenIlegivel = guardado !== '' && aberto === null;
  const token = (aberto ?? '').trim() || (process.env.TIKTOK_EVENTS_TOKEN ?? '').trim();

  const ligadoNoPainel = doPainel.ligado === null ? null : TRUTHY.has(doPainel.ligado.trim().toLowerCase());
  /*
   * Sem escolha do dono, o TikTok fica LIGADO quando há pixel.
   *
   * O oposto do Meta, e de propósito: o Meta tem META_TRACKING_ENABLED porque
   * ele já rodava antes do interruptor existir e desligá-lo por padrão apagaria
   * rastreamento em produção. Aqui não há histórico — quem cadastra um pixel
   * quer que ele dispare, e um pixel cadastrado que não dispara é o tipo de
   * silêncio que custa semanas para alguém notar.
   */
  const ligado = (ligadoNoPainel ?? true) && pixelId !== '';

  const valor: CredenciaisDoTikTok = {
    pixelId,
    token,
    ligado,
    parametros: normalizarParametros(doPainel.parametros),
    tokenIlegivel,
    podeGuardarToken: podeGuardarToken(),
  };

  /*
   * Desenvolvimento NÃO fala com o TikTok de verdade, mesma trava do Meta: o
   * .env.local carrega credencial de produção e PIX_MODE=mock confirma cobrança
   * sozinho, o que já mandou compra falsa para o Meta em 14 e 15/08/2026.
   */
  if (config.mode === 'mock' || !config.databaseUrl) {
    valor.ligado = false;
  }

  cache = { valor, expiraEm: agora + VALIDADE_MS };
  return valor;
}

/** Grava o pixel. String vazia apaga e devolve o controle ao ambiente. */
export async function guardarPixelDoTikTok(pixelId: string): Promise<void> {
  await repositorioDoPainel().salvarConfiguracao(CHAVE_PIXEL, pixelId.trim());
  invalidarCredenciaisDoTikTok();
}

export async function guardarTokenDoTikTok(token: string): Promise<void> {
  const limpo = token.trim();
  await repositorioDoPainel().salvarConfiguracao(CHAVE_TOKEN, limpo === '' ? '' : cifrar(limpo));
  invalidarCredenciaisDoTikTok();
}

export async function guardarLigadoDoTikTok(ligado: boolean): Promise<void> {
  await repositorioDoPainel().salvarConfiguracao(CHAVE_LIGADO, ligado ? '1' : '0');
  invalidarCredenciaisDoTikTok();
}

export async function guardarParametrosDoTikTok(parametros: string[]): Promise<string[]> {
  const limpos = normalizarParametros(JSON.stringify(parametros));
  await repositorioDoPainel().salvarConfiguracao(CHAVE_PARAMETROS, JSON.stringify(limpos));
  invalidarCredenciaisDoTikTok();
  return limpos;
}

/** A máscara que volta ao navegador. O token inteiro nunca sai daqui. */
export function mascarar(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '•'.repeat(token.length);
  return `${token.slice(0, 4)}${'•'.repeat(Math.min(20, token.length - 8))}${token.slice(-4)}`;
}
