/**
 * Carimbo de origem: de qual anúncio veio a pessoa.
 *
 * Fica num módulo próprio porque três partes do sistema precisam do mesmo
 * formato e nenhuma delas deve depender das outras: o pedido (que guarda o
 * carimbo até o PIX cair), o registro do funil (que alimenta a aba Anúncios) e
 * a rota que recebe o carimbo do navegador.
 *
 * Tudo aqui vem da URL, ou seja, de fora: cada valor é limitado em tamanho e
 * reduzido a texto antes de entrar no banco.
 */

export interface Atribuicao {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  utm_id?: string | null;
  fb_campaign_id?: string | null;
  fb_adset_id?: string | null;
  fb_ad_id?: string | null;
  fb_placement?: string | null;
  fb_source?: string | null;
  fbclid?: string | null;
  gclid?: string | null;

  /* TikTok. `ttclid` é o clique; os `tt_*` vêm das macros __CAMPAIGN_ID__ e
     companhia. Sintaxe `__NOME__`, não `{{campaign.id}}` como no Meta. */
  ttclid?: string | null;
  tt_campaign_id?: string | null;
  tt_adgroup_id?: string | null;
  tt_ad_id?: string | null;
  tt_placement?: string | null;
  tt_source?: string | null;
  /* Qual BM mandou o visitante. Nao e dedutivel do fb_campaign_id: e digitado
     a mao nos parametros de URL de cada gerenciador (`bm=alpha`). */
  bm?: string | null;
  /** Cookies do Pixel. Não são origem, mas viajam junto porque o Meta os exige. */
  fbp?: string | null;
  fbc?: string | null;
  referrer?: string | null;
  landing_url?: string | null;
}

/** Campos de origem propriamente ditos, na ordem das colunas do banco. */
export const CAMPOS_DE_ORIGEM = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fb_campaign_id',
  'fb_adset_id',
  'fb_ad_id',
  'fb_placement',
  'fb_source',
  'fbclid',
  'gclid',
  'ttclid',
  'tt_campaign_id',
  'tt_adgroup_id',
  'tt_ad_id',
  'tt_placement',
  'tt_source',
  'bm',
] as const;

/** Campos que viajam junto mas não agrupam nada. */
const CAMPOS_EXTRAS = ['fbp', 'fbc', 'referrer', 'landing_url'] as const;

const LIMITE = 300;
const LIMITE_URL = 500;
/**
 * `fbclid` e `fbc` (= `fb.1.<ms>.<fbclid>`) são mais longos que o resto: o Meta
 * alongou o identificador de clique e cortá-lo aqui invalidaria o `fbc` que vai
 * no Purchase — a venda chegaria ao Meta sem o clique. Ver src/lib/attribution.ts.
 */
const LIMITE_CLIQUE = 600;

/**
 * Aceita só o que conhecemos, no tamanho que aceitamos.
 *
 * Sem isso, qualquer pessoa poderia mandar um corpo enorme com chaves
 * inventadas para o `POST /api/track`, que é público — e o banco engoliria.
 */
export function limparAtribuicao(bruto: unknown): Atribuicao {
  if (!bruto || typeof bruto !== 'object') return {};
  const fonte = bruto as Record<string, unknown>;
  const limpo: Atribuicao = {};

  for (const campo of CAMPOS_DE_ORIGEM) {
    const valor = fonte[campo];
    if (typeof valor !== 'string') continue;
    const texto = valor.trim().slice(0, campo === 'fbclid' || campo === 'ttclid' ? LIMITE_CLIQUE : LIMITE);
    if (texto !== '') limpo[campo] = texto;
  }

  for (const campo of CAMPOS_EXTRAS) {
    const valor = fonte[campo];
    if (typeof valor !== 'string') continue;
    const teto = campo === 'referrer' || campo === 'landing_url' ? LIMITE_URL : campo === 'fbc' ? LIMITE_CLIQUE : LIMITE;
    const texto = valor.trim().slice(0, teto);
    if (texto !== '') limpo[campo] = texto;
  }

  return limpo;
}

/** Veio de clique pago? É o que separa "anúncio" de "direto" no painel. */
export function veioDeAnuncio(a: Atribuicao | null | undefined): boolean {
  if (!a) return false;
  return Boolean(a.fbclid || a.gclid || a.ttclid || a.fb_ad_id || a.tt_ad_id || a.utm_source);
}

export type AgrupamentoDeAnuncio = 'campanha' | 'conjunto' | 'anuncio';

/**
 * Nome do grupo na aba Anúncios.
 *
 * O ID vem antes do nome porque ele nunca muda: renomear um anúncio no
 * Gerenciador troca o nome mas não o histórico, e agrupar pelo nome partiria o
 * mesmo anúncio em duas linhas. O nome só entra quando não há ID — é o caso do
 * tráfego do Google, que carimba `utm_*` e não os `fb_*`.
 */
export function chaveDoGrupo(a: Atribuicao, agrupamento: AgrupamentoDeAnuncio): string {
  const candidatos =
    agrupamento === 'campanha'
      ? [a.fb_campaign_id, a.utm_campaign, a.utm_id]
      : agrupamento === 'conjunto'
        ? [a.fb_adset_id, a.utm_term]
        : [a.fb_ad_id, a.utm_content];

  for (const valor of candidatos) {
    const texto = (valor ?? '').trim();
    if (texto !== '') return texto;
  }
  return '';
}

/** Plataforma de onde veio o clique, para o filtro do painel. */
export function plataformaDaOrigem(
  a: Atribuicao | null | undefined,
): 'facebook' | 'google' | 'tiktok' | 'direto' {
  if (!a) return 'direto';
  /*
   * A ordem é por CONFIABILIDADE, não por importância: o id de clique é carimbado
   * pela própria plataforma e não dá para errar, enquanto `utm_source` é digitado
   * à mão na URL do anúncio. Quem olhar o utm primeiro classifica errado toda vez
   * que alguém escrever "facebook" num anúncio do TikTok — e escrevem.
   */
  if (a.fbclid || a.fb_ad_id || a.fb_campaign_id) return 'facebook';
  if (a.ttclid || a.tt_ad_id || a.tt_campaign_id) return 'tiktok';
  if (a.gclid) return 'google';
  const fonte = (a.utm_source ?? '').toLowerCase();
  if (fonte.includes('facebook') || fonte.includes('instagram') || fonte === 'meta' || fonte === 'ig') return 'facebook';
  if (fonte.includes('tiktok') || fonte === 'tt') return 'tiktok';
  if (fonte.includes('google') || fonte === 'youtube') return 'google';
  return 'direto';
}
