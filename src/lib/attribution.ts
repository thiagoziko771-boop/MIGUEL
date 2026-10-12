/**
 * Carimbo de origem: de qual anúncio veio a pessoa que está no funil.
 *
 * O carimbo é gravado no `localStorage` na PRIMEIRA carga e viaja depois junto
 * com o pedido, até o banco. Isso não é preciosismo: o PIX tira o cliente do
 * site, ele paga no app do banco e às vezes só volta horas depois — e no
 * celular a aba costuma ser descartada nesse meio-tempo. Com o carimbo só na
 * memória, a venda chegaria ao servidor sem saber de onde veio, que é
 * exatamente a pergunta que o painel precisa responder.
 *
 * Também não dá para reler a URL mais tarde: quem recarrega volta para a
 * primeira tela do funil (o passo não é persistido) e a URL já perdeu os
 * parâmetros do anúncio.
 */

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;

  fb_campaign_id?: string;
  fb_adset_id?: string;
  fb_ad_id?: string;
  fb_placement?: string;
  fb_source?: string;

  fbclid?: string;
  gclid?: string;
  /*
   * TikTok. `ttclid` é o clique; os `tt_*` vêm das macros __CAMPAIGN_ID__ e
   * companhia, que o Ads Manager substitui na URL de destino.
   *
   * Sintaxe diferente da do Meta, e é o erro que mais acontece na troca de
   * plataforma: aqui é `__NOME__` com dois underscores de cada lado, não
   * `{{campaign.id}}`. Trocado, o parâmetro chega literal — com as chaves e tudo
   * — e o relatório enche de linha "{{campaign.id}}" sem nada acusar erro.
   */
  ttclid?: string;
  tt_campaign_id?: string;
  tt_adgroup_id?: string;
  tt_ad_id?: string;
  tt_placement?: string;
  tt_source?: string;
  /*
   * Qual gerenciador de negocios mandou este visitante.
   *
   * NAO da para deduzir: `fb_campaign_id` identifica campanha, e duas BMs
   * diferentes produzem ids no mesmo formato, sem nada que diga de qual conta
   * vieram. O unico sinal possivel e o que o proprio anuncio carimbar na URL --
   * por isso este campo existe, e por isso ele e digitado a mao nos parametros
   * de URL de cada BM (`bm=alpha`, `bm=beta`, ...).
   *
   * Sem ele, cinco BMs viram um balaio so no painel, e a pergunta que importa
   * quando se roda cinco contas em paralelo -- qual delas esta pagando -- fica
   * sem resposta.
   */
  bm?: string;

  /** Cookies do Pixel. Sem eles a correspondência de evento do Meta despenca. */
  fbp?: string;
  fbc?: string;

  referrer?: string;
  landing_url?: string;
  capturado_em?: number;
}

const CHAVE = 'rs_attrib';
const CHAVE_SESSAO = 'rs_sid';
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;
/** Prazo do cookie `_fbc`, igual ao que o próprio Pixel usa. */
const DIAS_FBC = 90;

/** Campos lidos da URL, na ordem em que aparecem no parâmetro do anúncio. */
const CAMPOS_DA_URL = [
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

/** Tamanho máximo de cada valor. Vem da URL, então vem de fora: não confie. */
const LIMITE = 200;
/**
 * O `fbclid` tem teto próprio, e maior. O Meta alongou o identificador de
 * clique ao longo de 2024–2026 (hoje passa fácil de 150 caracteres, com sufixo
 * `_aem_`), e cortá-lo em 200 gera um `_fbc` que o Meta recusa como inválido —
 * silenciosamente: o Purchase chega, mas sem o clique, e a venda não volta
 * atribuída ao anúncio. 500 cobre o que existe com folga e continua sendo um
 * teto contra URL forjada.
 */
const LIMITE_FBCLID = 500;

/**
 * Lê um parâmetro da URL.
 *
 * `get()` devolve `null` quando o parâmetro não existe, e o projeto já quebrou
 * uma vez por confiar no valor bruto — `Number(null)` é 0, não NaN, e o botão
 * de compra passou a aparecer na hora para todo cliente. Aqui a ausência vira
 * `undefined` explicitamente, e nada mais adiante precisa se lembrar disso.
 */
function param(busca: URLSearchParams, nome: string): string | undefined {
  const bruto = busca.get(nome);
  if (bruto === null) return undefined;
  const limpo = bruto.trim().slice(0, nome === 'fbclid' ? LIMITE_FBCLID : LIMITE);
  return limpo === '' ? undefined : limpo;
}

function lerCookie(nome: string): string | undefined {
  try {
    const achado = document.cookie
      .split(';')
      .map((parte) => parte.trim())
      .find((parte) => parte.startsWith(`${nome}=`));
    if (!achado) return undefined;
    const valor = decodeURIComponent(achado.slice(nome.length + 1)).trim();
    return valor === '' ? undefined : valor;
  } catch {
    return undefined;
  }
}

function gravarCookie(nome: string, valor: string, dias: number): void {
  try {
    const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${nome}=${encodeURIComponent(valor)}; expires=${expira}; path=/; SameSite=Lax`;
  } catch {
    // Storage bloqueado: seguimos sem o cookie, o resto continua valendo.
  }
}

function lerGuardado(): Attribution | null {
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const salvo = JSON.parse(bruto) as Attribution;
    if (!salvo || typeof salvo !== 'object') return null;
    // Carimbo vencido não vale mais: 30 dias é a janela que o próprio Meta usa.
    if (!salvo.capturado_em || Date.now() - salvo.capturado_em > VALIDADE_MS) return null;
    return salvo;
  } catch {
    return null;
  }
}

function gravar(valor: Attribution): void {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(valor));
  } catch {
    // Navegação privada: o carimbo vale só para esta carga da página.
  }
}

/**
 * Monta o `_fbc` à mão quando o Pixel ainda não criou o cookie.
 *
 * O formato é fixo e documentado pelo Meta: `fb.1.<milissegundos>.<fbclid>`.
 * Sem `fbc` a taxa de correspondência do evento cai muito, porque é ele que
 * liga a compra ao clique exato no anúncio. Isso acontece de verdade quando um
 * bloqueador atrasa ou impede o script do Pixel.
 */
function montarFbc(fbclid: string): string {
  return `fb.1.${Date.now()}.${fbclid}`;
}

/**
 * Desempacota o formato "nome|id" usado por ferramentas como a UTMify.
 *
 * Elas espremem nome e ID dentro dos cinco campos UTM padrão porque precisam
 * funcionar com checkouts de terceiros, que só repassam esses cinco. Aqui o
 * checkout é nosso e usamos campos dedicados (`fb_ad_id` e companhia) — mas
 * entender o formato empacotado é o que impede uma string copiada de outra
 * ferramenta de chegar sem ID nenhum e a venda aparecer como "(sem origem)".
 *
 * Só o rabo numérico vira ID: nome de campanha pode conter "|" por acidente, e
 * tratar "Promo | Julho" como identificador estragaria o agrupamento.
 */
function desempacotar(valor: string | undefined): { nome: string; id?: string } | undefined {
  if (valor === undefined) return undefined;
  const corte = valor.lastIndexOf('|');
  if (corte <= 0) return { nome: valor };

  const cauda = valor.slice(corte + 1).trim();
  if (!/^\d{6,}$/.test(cauda)) return { nome: valor };

  return { nome: valor.slice(0, corte).trim(), id: cauda };
}

/**
 * Preenche os campos dedicados a partir dos UTM empacotados, quando o anúncio
 * não trouxe os `fb_*` separados. O que já veio explícito nunca é sobrescrito.
 */
function aproveitarEmpacotados(dados: Attribution): void {
  // Só os campos de texto: `keyof Attribution` incluiria `capturado_em`, que é
  // número, e o compilador (com razão) recusaria a atribuição.
  type CampoDeTexto = 'utm_campaign' | 'utm_medium' | 'utm_term' | 'utm_content' | 'fb_campaign_id' | 'fb_adset_id' | 'fb_ad_id';

  const slots: Array<[CampoDeTexto, CampoDeTexto]> = [
    ['utm_campaign', 'fb_campaign_id'],
    ['utm_medium', 'fb_adset_id'],
    ['utm_term', 'fb_adset_id'],
    ['utm_content', 'fb_ad_id'],
  ];

  for (const [origem, destino] of slots) {
    const separado = desempacotar(dados[origem]);
    if (!separado) continue;
    dados[origem] = separado.nome;
    if (separado.id && !dados[destino]) dados[destino] = separado.id;
  }
}

let memoria: Attribution | null = null;

/**
 * Captura a origem desta visita. Roda uma vez, o mais cedo possível.
 *
 * Regra de sobrescrita: visita nova COM identificador de clique pago
 * (`fbclid` ou `gclid`) vence a anterior — é o último clique que pagou por
 * esta pessoa. Visita sem identificador nenhum não apaga nada: quem voltou
 * digitando o endereço, ou por um link do WhatsApp, continua creditado ao
 * anúncio que o trouxe da primeira vez.
 */
export function capturarAtribuicao(): Attribution {
  const busca = new URLSearchParams(window.location.search);

  const daUrl: Attribution = {};
  for (const campo of CAMPOS_DA_URL) {
    const valor = param(busca, campo);
    if (valor !== undefined) daUrl[campo] = valor;
  }
  aproveitarEmpacotados(daUrl);

  const guardado = lerGuardado();
  const temCliquePago = Boolean(daUrl.fbclid || daUrl.gclid);

  // O `_fbc` precisa nascer aqui: o Pixel pode estar bloqueado, e mesmo quando
  // não está, ele só grava o cookie depois de carregar. E precisa ser TROCADO
  // quando chega um clique novo: quem voltou por outro anúncio não pode
  // continuar carregando o clique da semana passada — é o mesmo "último
  // clique pago vence" da regra abaixo, e é o que o próprio Pixel faz.
  if (daUrl.fbclid) {
    const cookieAtual = lerCookie('_fbc');
    if (!cookieAtual || !cookieAtual.endsWith(`.${daUrl.fbclid}`)) {
      gravarCookie('_fbc', montarFbc(daUrl.fbclid), DIAS_FBC);
    }
  }

  const base = temCliquePago || !guardado ? daUrl : guardado;

  const atual: Attribution = {
    ...base,
    // Os cookies do Pixel são relidos sempre: eles aparecem depois da primeira
    // carga, e o carimbo antigo pode ter sido gravado antes de existirem.
    fbp: lerCookie('_fbp') ?? guardado?.fbp,
    fbc: lerCookie('_fbc') ?? guardado?.fbc,
    referrer: base.referrer ?? (document.referrer || undefined),
    landing_url: base.landing_url ?? window.location.href.slice(0, 500),
    capturado_em: temCliquePago || !guardado ? Date.now() : guardado.capturado_em,
  };

  memoria = atual;
  gravar(atual);
  return atual;
}

export function getAttribution(): Attribution {
  if (memoria) {
    // Os cookies podem ter nascido depois da captura inicial.
    const fbp = lerCookie('_fbp');
    const fbc = lerCookie('_fbc');
    if (fbp && fbp !== memoria.fbp) memoria = { ...memoria, fbp };
    if (fbc && fbc !== memoria.fbc) memoria = { ...memoria, fbc };
    return memoria;
  }
  return lerGuardado() ?? {};
}

function novoId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Navegador antigo ou contexto sem crypto: cai no gerador abaixo.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Identificador da sessão do funil. Fica no `sessionStorage` porque é para
 * ligar as etapas de UMA visita: é ele que permite ao painel dizer quantas
 * pessoas chegaram na VSL e quantas dessas abriram o checkout.
 */
export function getSessionId(): string {
  try {
    const salvo = window.sessionStorage.getItem(CHAVE_SESSAO);
    if (salvo) return salvo;
    const novo = novoId();
    window.sessionStorage.setItem(CHAVE_SESSAO, novo);
    return novo;
  } catch {
    return novoId();
  }
}

/** Identificador de evento, o mesmo no navegador e no servidor (deduplicação). */
export function novoEventId(): string {
  return `evt_${novoId()}`;
}
