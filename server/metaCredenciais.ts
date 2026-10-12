import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { repositorioDoPainel } from './painel/repositorio.js';

/**
 * De onde saem o Pixel e o token da API de Conversões.
 *
 * Antes eles vinham só de variável de ambiente, e isso obrigava um deploy
 * inteiro para trocar um número — na Vercel, mudar `VITE_META_PIXEL_ID` exige
 * rebuild, porque ele é embutido no bundle. O dono ficava dependente de alguém
 * com acesso ao painel da Vercel para uma tarefa que é dele: ligar o
 * rastreamento da própria conta de anúncio.
 *
 * Agora as credenciais podem vir do painel, guardadas no banco, e valem
 * imediatamente. A variável de ambiente continua existindo como base — quem
 * está preenchido no painel sobrepõe, campo a campo. Essa ordem é a única que
 * não surpreende: o dono digita, aperta salvar e vê mudar.
 *
 * O TOKEN NUNCA É GUARDADO EM TEXTO. Ele é cifrado com uma chave derivada da
 * PAINEL_CHAVE_MESTRA, que vive fora do banco. Um dump do Postgres — o vazamento
 * mais provável — sai sem o token utilizável. Em troca disso, sem chave mestra o
 * painel se recusa a guardar token: melhor não aceitar do que aceitar e deixar
 * a senha de uma conta de anúncio em texto puro numa tabela.
 */

export interface CredenciaisDoMeta {
  pixelId: string;
  token: string;
  testEventCode: string;
  /** Só é `true` com as duas credenciais presentes e o rastreamento ligado. */
  ligado: boolean;
  origemDoPixel: 'painel' | 'ambiente' | 'nenhuma';
  origemDoToken: 'painel' | 'ambiente' | 'nenhuma';
  /** Havia token guardado, mas a chave mestra de hoje não abre. Ver `decifrar`. */
  tokenIlegivel: boolean;
}

export const CHAVE_PIXEL = 'meta.pixel_id';
export const CHAVE_TOKEN = 'meta.capi_token';
export const CHAVE_TEST_CODE = 'meta.test_event_code';
export const CHAVE_LIGADO = 'meta.ligado';

/* -------------------------------------------------------------------------- */
/* Cifra do token                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Chave de 32 bytes a partir da chave mestra do painel.
 *
 * A mesma chave que assina as sessões e os links de entrega. Trocar a
 * PAINEL_CHAVE_MESTRA derruba as sessões abertas e, agora, também torna o token
 * guardado ilegível — o painel avisa e pede para colar de novo, em vez de falhar
 * calado no meio de um pagamento.
 */
function chaveDeCifra(): Buffer | null {
  const mestra = config.painel.chaveMestra;
  if (!mestra) return null;
  return crypto.createHash('sha256').update(`meta-capi:${mestra}`, 'utf8').digest();
}

export function podeGuardarToken(): boolean {
  return chaveDeCifra() !== null;
}

export function cifrar(valor: string): string {
  const chave = chaveDeCifra();
  if (!chave) throw new Error('PAINEL_CHAVE_MESTRA ausente: não há como cifrar o token.');

  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([cifrador.update(valor, 'utf8'), cifrador.final()]);
  const etiqueta = cifrador.getAuthTag();

  return `v1.${iv.toString('base64')}.${etiqueta.toString('base64')}.${cifrado.toString('base64')}`;
}

/**
 * Devolve `null` quando não dá para abrir, em vez de lançar.
 *
 * Chave mestra trocada, banco restaurado de outro ambiente, valor truncado: em
 * todos esses casos o certo é cair para a variável de ambiente e seguir. Lançar
 * aqui derrubaria o envio de eventos e, por tabela, um caminho que também passa
 * pela confirmação de pagamento.
 */
export function decifrar(guardado: string): string | null {
  const chave = chaveDeCifra();
  if (!chave) return null;

  const partes = guardado.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;

  try {
    const decifrador = crypto.createDecipheriv('aes-256-gcm', chave, Buffer.from(partes[1], 'base64'));
    decifrador.setAuthTag(Buffer.from(partes[2], 'base64'));
    const aberto = Buffer.concat([decifrador.update(Buffer.from(partes[3], 'base64')), decifrador.final()]);
    return aberto.toString('utf8');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Resolução, com cache                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cache curto por instância.
 *
 * Sem ele, cada evento enviado ao Meta viraria três consultas ao Postgres — e
 * há evento em toda etapa do funil. Trinta segundos é o atraso máximo para uma
 * credencial nova valer numa instância que já estava de pé; salvar pelo painel
 * limpa o cache da instância que atendeu, e as outras alcançam no vencimento.
 */
const VALIDADE_MS = 30_000;
let cache: { valor: CredenciaisDoMeta; expiraEm: number } | null = null;

export function invalidarCredenciaisDoMeta(): void {
  cache = null;
}

const TRUTHY = new Set(['1', 'true', 'sim', 'on', 'yes']);
/** O aviso de bloqueio sai uma vez por processo, não a cada evento. */
let avisouBloqueio = false;

export async function credenciaisDoMeta(): Promise<CredenciaisDoMeta> {
  const agora = Date.now();
  if (cache && cache.expiraEm > agora) return cache.valor;

  let doPainel: { pixel: string | null; token: string | null; testCode: string | null; ligado: string | null } = {
    pixel: null,
    token: null,
    testCode: null,
    ligado: null,
  };

  /*
   * Banco fora do ar não pode desligar o rastreamento configurado por ambiente.
   * O `catch` faz a leitura cair para o que já existia antes desta funcionalidade.
   */
  try {
    const repo = repositorioDoPainel();
    const [pixel, token, testCode, ligado] = await Promise.all([
      repo.lerConfiguracao(CHAVE_PIXEL),
      repo.lerConfiguracao(CHAVE_TOKEN),
      repo.lerConfiguracao(CHAVE_TEST_CODE),
      repo.lerConfiguracao(CHAVE_LIGADO),
    ]);
    doPainel = { pixel, token, testCode, ligado };
  } catch (erro) {
    logger.warn('Não consegui ler as credenciais do Meta no banco; usando as variáveis de ambiente', {
      erro: (erro as Error).message,
    });
  }

  const pixelDoPainel = (doPainel.pixel ?? '').trim();
  const pixelId = pixelDoPainel || config.meta.pixelId;

  const guardado = (doPainel.token ?? '').trim();
  const abertoDoPainel = guardado === '' ? null : decifrar(guardado);
  const tokenIlegivel = guardado !== '' && abertoDoPainel === null;
  const token = (abertoDoPainel ?? '').trim() || config.meta.token;

  const testEventCode = (doPainel.testCode ?? '').trim() || config.meta.testEventCode;

  // Interruptor do painel, quando existir, manda no META_TRACKING_ENABLED.
  const ligadoNoPainel = doPainel.ligado === null ? null : TRUTHY.has(doPainel.ligado.trim().toLowerCase());
  const permitidoPeloDono = ligadoNoPainel ?? config.meta.ligadoPorConfig;

  /*
   * Ambiente de desenvolvimento NÃO fala com o Meta de verdade.
   *
   * O `.env.local` da raiz carrega o token e o pixel de PRODUÇÃO (é o que o
   * dono usa para o painel local), e `PIX_MODE=mock` confirma qualquer
   * cobrança sozinho em ~12 s. Em 14/08 e 15/08/2026 isso mandou compras
   * FALSAS ao pixel real — apareceram em /{pixel}/stats com `external_id`
   * (só o nosso servidor manda esse campo) sem nenhum registro em
   * `eventos_meta` de produção. O robô do Meta aprendeu com vendas que não
   * existiram.
   *
   * A regra: em modo mock, ou sem banco (logo, fora da Vercel), apontando
   * para o Meta real e sem código de teste, o envio fica desligado. O código
   * de teste é a saída legítima: com ele os eventos entram na aba "Testar
   * eventos" e não contam como conversão. A bateria de testes sobe um Meta
   * falso em `META_BASE_URL` local e continua passando.
   */
  const apontaParaOMetaReal = /facebook\.com/i.test(config.meta.baseUrl);
  const ambienteDeDesenvolvimento = config.mode === 'mock' || !config.databaseUrl;
  const bloqueadoPorSeguranca = apontaParaOMetaReal && ambienteDeDesenvolvimento && !testEventCode;
  if (bloqueadoPorSeguranca && permitidoPeloDono && !avisouBloqueio) {
    avisouBloqueio = true;
    logger.warn(
      'Rastreamento do Meta DESLIGADO neste ambiente: modo mock ou sem banco, apontando para o Meta real, sem META_TEST_EVENT_CODE. Evento daqui seria conversão falsa no pixel de produção.',
    );
  }
  const permitido = permitidoPeloDono && !bloqueadoPorSeguranca;

  if (tokenIlegivel) {
    logger.warn('Token do Meta guardado no painel não pôde ser aberto com a chave mestra atual', {
      caiuPara: config.meta.token ? 'variável de ambiente' : 'nenhum token',
    });
  }

  const valor: CredenciaisDoMeta = {
    pixelId,
    token,
    testEventCode,
    ligado: permitido && Boolean(pixelId && token),
    origemDoPixel: pixelDoPainel ? 'painel' : config.meta.pixelId ? 'ambiente' : 'nenhuma',
    origemDoToken: abertoDoPainel ? 'painel' : config.meta.token ? 'ambiente' : 'nenhuma',
    tokenIlegivel,
  };

  cache = { valor, expiraEm: agora + VALIDADE_MS };
  return valor;
}

/**
 * Só o que pode ser mostrado numa tela.
 *
 * O token nunca volta inteiro, nem para quem está logado no painel: a tela não
 * precisa dele para funcionar, e um token que trafega de volta é um token a mais
 * em cache de navegador, em log de proxy e em captura de tela.
 */
export function mascararToken(token: string): string {
  if (token === '') return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}
