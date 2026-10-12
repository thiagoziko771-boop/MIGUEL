import { config } from './config.js';
import { logger } from './logger.js';
import { centsToAmount, newId, normalizeApiDate, onlyDigits } from './utils.js';
import type { OrderStatus } from './store/index.js';

/**
 * Gateway de PIX — PixGo (https://pixgo.org/api/v1).
 *
 * O resto do sistema conhece exatamente duas funções — createPayment e
 * fetchPaymentStatus — e mais nada sobre quem processa o pagamento. Trocar de
 * provedor de novo é reescrever só este arquivo.
 *
 * Três coisas da PixGo que mudam como o funil se comporta, e que não dá para
 * descobrir lendo o código:
 *
 * 1. NÃO EXISTE AMBIENTE DE TESTE. Toda chave é de produção, e toda cobrança
 *    criada é dinheiro de verdade. Por isso o modo mock continua aqui: é ele
 *    que permite rodar o funil inteiro sem gerar cobrança.
 * 2. O CPF informado TRAVA quem pode pagar. Se outra pessoa pagar o QR, o
 *    pagamento é rejeitado e o estorno para o terceiro leva até 48 h. O
 *    checkout já pede "CPF de quem vai pagar" justamente por isso.
 * 3. O teto por QR Code depende do nível da conta, e o nível sobe conforme o
 *    total já confirmado. Conta nova começa em R$ 300 por cobrança — um pedido
 *    acima disso é recusado pela API, não por nós.
 */

export class PixGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'PixGatewayError';
    this.status = options.status ?? 502;
    this.code = options.code ?? 'PIX_GATEWAY_ERROR';
    this.details = options.details;
  }
}

export interface CreatePaymentInput {
  amountCents: number;
  description: string;
  /** Nosso id do pedido. Vai ao gateway para o callback dizer de quem é o pagamento. */
  externalId: string;
  customer: { name: string; email: string; phone: string; document: string };
  webhookUrl?: string;
}

/**
 * O nome do adquirente, se a resposta trouxer.
 *
 * Os nomes de campo variam por provedor e por versão da API, então a busca é
 * por uma lista de candidatos em vez de um caminho fixo. Não achar é o caso
 * normal, e devolve `null` — o resto do sistema trata ausência como "não sei",
 * nunca como erro.
 */
function acharAdquirente(dados: Record<string, unknown> | undefined | null): string | null {
  if (!dados || typeof dados !== 'object') return null;
  for (const campo of ['acquirer', 'adquirente', 'acquirer_name', 'psp', 'provider', 'processor', 'bank']) {
    const valor = (dados as Record<string, unknown>)[campo];
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim().slice(0, 60);
    // Alguns devolvem um objeto: { acquirer: { name: "..." } }
    if (valor && typeof valor === 'object') {
      const nome = (valor as Record<string, unknown>).name ?? (valor as Record<string, unknown>).nome;
      if (typeof nome === 'string' && nome.trim() !== '') return nome.trim().slice(0, 60);
    }
  }
  return null;
}

export interface PixCharge {
  /** Quem liquidou, quando o gateway informa. `null` quando não vem. */
  adquirente?: string | null;
  /** Id da cobrança no gateway. É por ele que consultamos o status depois. */
  paymentId: string;
  status: OrderStatus;
  /** Status cru do gateway, guardado no pedido para o painel mostrar o original. */
  statusBruto: string;
  /** Copia e cola do PIX. É o que o cliente cola no app do banco. */
  qrCode: string;
  qrImageUrl: string | null;
  expiresAt: string | null;
}

export interface PixPaymentStatus {
  paymentId: string;
  status: OrderStatus;
  /**
   * Status cru do gateway (PAID, MED, EXPIRED...). Guardamos porque o nosso
   * mapeamento perde informação: MED vira "pendente" para não revogar acesso
   * indevidamente, e sem o valor original o painel não teria como mostrar que
   * a transação está em análise de devolução.
   */
  statusBruto: string;
  updatedAt: string | null;
}

/**
 * Nomes de status usuais nas APIs de PIX brasileiras. A comparação é por
 * igualdade exata do valor normalizado: `includes` transformaria "unpaid" em
 * "paid" e liberaria produto sem pagamento.
 *
 * Ao integrar o provedor novo, confira a lista dele e acrescente aqui o que
 * faltar. O que não estiver mapeado cai em "pendente", que é o lado seguro.
 */
const STATUS_MAP: Record<string, OrderStatus> = {
  paid: 'completed',
  approved: 'completed',
  completed: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  refunded: 'refunded',
  chargeback: 'refunded',
  failed: 'failed',
  error: 'failed',
  pending: 'pending',
  waiting: 'pending',
  waiting_payment: 'pending',
  created: 'pending',
  processing: 'pending',
  /*
   * MED é o Mecanismo Especial de Devolução do PIX: análise de devolução, não
   * devolução consumada. Tratar como pendente evita os dois erros graves: não
   * revoga o acesso de quem pagou (applyStatus recusa voltar de pago para
   * pendente) e não libera nada para quem ainda não pagou. Exige decisão
   * humana, por isso vira alerta.
   */
  med: 'pending',
  /*
   * ZuckPay: os quatro abaixo entraram em 20/08/2026, e cada um consertava um
   * erro concreto.
   *
   * EXPIRADO em PORTUGUES e o nome que a ZuckPay da para cobranca vencida — o
   * resto da lista esta em ingles, e por isso ele passava batido. Caindo no
   * padrao "pendente", o pedido nunca era marcado como expirado: a varredura
   * seguiria reconsultando um QR que ninguem mais pode pagar, e a tela nunca
   * ofereceria gerar outro codigo para quem voltasse.
   *
   * REFUSED e recusa definitiva. Como "pendente" ele ficaria em aberto no
   * painel para sempre, engordando a fila de recuperacao com gente cujo
   * pagamento nao vai acontecer.
   *
   * UNKNOWN e status DOCUMENTADO da ZuckPay, nao nome desconhecido. O destino e
   * o mesmo (pendente, o lado seguro), mas mapea-lo aqui evita um aviso de
   * "status desconhecido" no log a cada consulta — ruido que faz o log de
   * verdade deixar de ser lido.
   */
  expirado: 'expired',
  refused: 'failed',
  refund: 'refunded',
  unknown: 'pending',
};

export function mapStatus(raw: unknown): OrderStatus {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (normalized === 'med') {
    logger.warn('Gateway devolveu MED: transação em análise de devolução, confira no painel do provedor');
  }
  const mapped = STATUS_MAP[normalized];
  if (!mapped) {
    logger.warn('Status desconhecido recebido do gateway; tratando como pendente', { raw });
    return 'pending';
  }
  return mapped;
}

/**
 * Lê o primeiro campo preenchido dentre vários nomes possíveis.
 *
 * Fica de herança porque toda API de PIX nomeia as mesmas coisas de um jeito
 * diferente — e às vezes muda entre endpoints do próprio provedor.
 */
export function primeiroTexto(fonte: unknown, chaves: string[]): string | undefined {
  if (!fonte || typeof fonte !== 'object') return undefined;
  for (const chave of chaves) {
    const valor = (fonte as Record<string, unknown>)[chave];
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') return String(valor).trim();
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Chamadas à API da PixGo                                                     */
/* -------------------------------------------------------------------------- */

interface RespostaCrua {
  status: number;
  body: any;
}

/**
 * Uma requisição à PixGo, com timeout próprio.
 *
 * O timeout existe porque a função da Vercel tem maxDuration de 20 s: uma
 * conexão pendurada seguraria a invocação até o corte e o cliente veria a tela
 * travar sem explicação.
 */
/* -------------------------------------------------------------------------- */
/* SyncPay: o Bearer de uma hora                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cache do token da SyncPay, por instância do processo.
 *
 * A doc pede "gere um novo token apenas quando o anterior expirar" — o par
 * client_id/client_secret compra um Bearer de 1 h. Em serverless cada
 * instância mantém o seu, e instâncias frias geram um novo: a SyncPay não
 * documenta revogação do anterior, então a coexistência é o comportamento
 * esperado. A folga de 5 minutos evita usar um token que morre no meio da
 * criação da cobrança.
 */
let tokenSyncPay: { valor: string; expiraEmMs: number } | null = null;

async function bearerDaSyncPay(timeoutMs?: number): Promise<string> {
  const agora = Date.now();
  if (tokenSyncPay && tokenSyncPay.expiraEmMs - agora > 5 * 60_000) return tokenSyncPay.valor;

  const { clientId, clientSecret, baseUrl } = config.pix.syncpay;
  if (!clientId || !clientSecret) {
    throw new PixGatewayError(
      'SYNCPAY_CLIENT_ID/SYNCPAY_CLIENT_SECRET não configurados: sem eles não há como falar com a SyncPay.',
      { status: 503, code: 'GATEWAY_SEM_CREDENCIAL' },
    );
  }

  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), timeoutMs ?? config.pix.requestTimeoutMs);
  try {
    /*
     * O corpo leva só o par de credenciais, como no exemplo oficial. O schema
     * da doc lista um terceiro campo obrigatório de nome "01K1259MAX..." — um
     * ULID como NOME de chave — que o próprio exemplo deles omite. Seguimos o
     * exemplo; se o teste real devolver 4xx reclamando de campo, é aqui que se
     * mexe.
     */
    const resposta = await fetch(`${baseUrl}/api/partner/v1/auth-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      signal: controlador.signal,
    });
    const corpo: any = await resposta.json().catch(() => null);
    const token = String(corpo?.access_token ?? '').trim();
    if (!resposta.ok || !token) {
      throw new PixGatewayError('A SyncPay recusou as credenciais.', {
        status: resposta.status === 429 ? 429 : 502,
        code: 'SYNCPAY_AUTH',
        details: corpo,
      });
    }
    const validadeS = Number(corpo?.expires_in);
    tokenSyncPay = {
      valor: token,
      expiraEmMs: Date.now() + (Number.isFinite(validadeS) && validadeS > 0 ? validadeS * 1000 : 3_600_000),
    };
    return token;
  } catch (erro) {
    if (erro instanceof PixGatewayError) throw erro;
    if ((erro as Error).name === 'AbortError') {
      throw new PixGatewayError('A SyncPay não respondeu a tempo no auth-token.', { status: 504, code: 'GATEWAY_TIMEOUT' });
    }
    throw new PixGatewayError(`Falha ao autenticar na SyncPay: ${(erro as Error).message}`, {
      status: 502,
      code: 'GATEWAY_INDISPONIVEL',
    });
  } finally {
    clearTimeout(relogio);
  }
}

/** Descarta o token guardado. Chamado quando uma requisição volta 401. */
function esquecerTokenSyncPay(): void {
  tokenSyncPay = null;
}

async function requisicao(caminho: string, init: RequestInit = {}, timeoutMs?: number): Promise<RespostaCrua> {
  if (config.pix.provider === 'syncpay') return requisicaoSyncPay(caminho, init, timeoutMs);
  if (config.pix.provider === 'zuckpay') return requisicaoZuckPay(caminho, init, timeoutMs);

  if (!config.pix.apiKey) {
    throw new PixGatewayError(
      'PIXGO_API_KEY não configurada: sem ela não há como falar com a PixGo.',
      { status: 503, code: 'GATEWAY_SEM_CREDENCIAL' },
    );
  }

  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), timeoutMs ?? config.pix.requestTimeoutMs);

  try {
    const resposta = await fetch(`${config.pix.baseUrl}${caminho}`, {
      ...init,
      signal: controlador.signal,
      headers: {
        Accept: 'application/json',
        'X-API-Key': config.pix.apiKey,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });

    const texto = await resposta.text();
    let body: any = null;
    try {
      body = texto ? JSON.parse(texto) : null;
    } catch {
      // Resposta que não é JSON (página de erro, HTML de manutenção): guardamos
      // o texto para o log, sem deixar o parse derrubar o pedido.
      body = { raw: texto.slice(0, 500) };
    }
    return { status: resposta.status, body };
  } catch (erro) {
    if ((erro as Error).name === 'AbortError') {
      throw new PixGatewayError('A PixGo não respondeu a tempo.', { status: 504, code: 'GATEWAY_TIMEOUT' });
    }
    throw new PixGatewayError(`Falha ao falar com a PixGo: ${(erro as Error).message}`, {
      status: 502,
      code: 'GATEWAY_INDISPONIVEL',
    });
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * A conversa com a SyncPay: Bearer renovável no lugar da chave fixa.
 *
 * Um 401 derruba o token guardado e tenta UMA vez com token novo — é o caso da
 * instância que hibernou com um Bearer que venceu no meio-tempo. Mais de uma
 * repetição seria mascarar credencial revogada como instabilidade.
 */
async function requisicaoSyncPay(caminho: string, init: RequestInit = {}, timeoutMs?: number): Promise<RespostaCrua> {
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const token = await bearerDaSyncPay(timeoutMs);
    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeoutMs ?? config.pix.requestTimeoutMs);
    try {
      const resposta = await fetch(`${config.pix.syncpay.baseUrl}${caminho}`, {
        ...init,
        signal: controlador.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      });
      const texto = await resposta.text();
      let body: any = null;
      try {
        body = texto ? JSON.parse(texto) : null;
      } catch {
        body = { raw: texto.slice(0, 500) };
      }
      if (resposta.status === 401 && tentativa === 0) {
        esquecerTokenSyncPay();
        continue;
      }
      return { status: resposta.status, body };
    } catch (erro) {
      if ((erro as Error).name === 'AbortError') {
        throw new PixGatewayError('A SyncPay não respondeu a tempo.', { status: 504, code: 'GATEWAY_TIMEOUT' });
      }
      throw new PixGatewayError(`Falha ao falar com a SyncPay: ${(erro as Error).message}`, {
        status: 502,
        code: 'GATEWAY_INDISPONIVEL',
      });
    } finally {
      clearTimeout(relogio);
    }
  }
  throw new PixGatewayError('A SyncPay recusou o token duas vezes seguidas.', { status: 502, code: 'SYNCPAY_AUTH' });
}

/**
 * O que o cliente lê quando a PixGo recusa.
 *
 * As mensagens deles vêm técnicas e às vezes em inglês — "CPF DOES NOT EXIST IN
 * RECEITA FEDERAL DATABASE" no meio de um checkout brasileiro derruba a
 * confiança e a venda junto. Aqui cada código conhecido vira uma frase que diz
 * o que fazer.
 */
const RECADO_POR_CODIGO: Record<string, string> = {
  PAYER_BLOCKED:
    'Confira o CPF digitado. A Receita Federal não reconheceu esse número, e o pagamento precisa do CPF de quem vai pagar.',
  VALIDATION_ERROR:
    'Confira os seus dados: algum campo não foi aceito. O CPF precisa ser o de quem vai pagar, com todos os dígitos.',
  LIMIT_EXCEEDED:
    'Não foi possível gerar o PIX deste valor agora. Tente novamente em instantes ou fale com a gente pelo WhatsApp.',
  UNAUTHORIZED: 'Não foi possível gerar o PIX agora. Tente novamente em instantes.',
  /*
   * A PixGo apaga a cobrança depois que ela expira, e passa a responder 404 na
   * consulta. Sem esta linha o cliente lia "não foi possível gerar o PIX agora,
   * tente em instantes" — conselho errado, porque esperar não traz de volta uma
   * cobrança que já venceu. O que ele precisa é gerar outra.
   */
  PAYMENT_NOT_FOUND:
    'Esta cobrança PIX expirou. Gere um novo código para concluir a compra — o valor e os produtos continuam os mesmos.',
};

/** Código que a PixGo devolve quando a cobrança não existe mais. */
export const CODIGO_COBRANCA_SUMIU = 'PAYMENT_NOT_FOUND';

/**
 * Nome do campo recusado, na língua do cliente.
 *
 * A PixGo devolve `errors: { receiver_phone: "..." }` quando reprova um campo
 * específico. Sem esta tradução, o cliente recebia a frase genérica de
 * VALIDATION_ERROR, que fala em CPF — e ia conferir o CPF, que estava certo,
 * enquanto o problema era o telefone. Apontar o campo errado é pior do que não
 * apontar nenhum: manda a pessoa consertar o que não está quebrado.
 */
const CAMPO_EM_PORTUGUES: Record<string, string> = {
  receiver_cpf: 'CPF',
  receiver_phone: 'telefone',
  receiver_email: 'e-mail',
  receiver_name: 'nome',
  amount: 'valor',
};

function recadoDeCampo(body: any): string | null {
  const erros = body?.errors;
  if (!erros || typeof erros !== 'object') return null;

  const [campo] = Object.keys(erros);
  if (!campo) return null;

  const rotulo = CAMPO_EM_PORTUGUES[campo];
  if (!rotulo) return null;

  return `Confira o seu ${rotulo}: o banco não aceitou esse dado. ` +
    (campo === 'receiver_phone'
      ? 'Use um celular com DDD e o 9 na frente (exemplo: 11 91234-5678).'
      : 'Corrija o campo e tente de novo.');
}

function falhaDe(status: number, body: any): PixGatewayError {
  const codigo = String(body?.error ?? 'GATEWAY_ERRO');
  const original = String(body?.message ?? codigo);
  // O campo específico ganha da mensagem por código: ele diz onde mexer.
  const amigavel = recadoDeCampo(body) ?? RECADO_POR_CODIGO[codigo];

  if (!amigavel) {
    // Código que ainda não conhecemos: registra o original para o dono
    // descobrir, sem despejar texto técnico na tela do cliente.
    logger.warn('PixGo recusou com um código ainda não mapeado', { codigo, mensagem: original, status });
  }

  return new PixGatewayError(amigavel ?? 'Não foi possível gerar o PIX agora. Tente novamente em instantes.', {
    status: status >= 500 ? 502 : 400,
    code: codigo,
    details: body,
  });
}

/**
 * Cria a cobrança PIX e devolve o copia e cola.
 *
 * Detalhes da PixGo embutidos aqui:
 *   • `amount` vai em REAIS decimais, não em centavos como circula no resto do
 *     sistema — mandar 4700 criaria uma cobrança de quarenta e sete mil reais;
 *   • `receiver_cpf` é obrigatório desde 25/06/2026 e trava quem pode pagar;
 *   • os opcionais só são enviados quando passam nas regras de tamanho da API,
 *     porque um telefone com formato errado derruba a cobrança inteira por um
 *     campo que nem era necessário.
 */
export async function createPayment(input: CreatePaymentInput): Promise<PixCharge> {
  if (config.mode === 'mock') return createMockPayment(input);
  if (config.pix.provider === 'syncpay') return createPaymentSyncPay(input);
  if (config.pix.provider === 'zuckpay') return createPaymentZuckPay(input);

  const documento = onlyDigits(input.customer.document);
  if (documento.length !== 11 && documento.length !== 14) {
    throw new PixGatewayError(
      'A PixGo exige o CPF (ou CNPJ) de quem vai pagar, e só esse documento consegue pagar o QR gerado.',
      { status: 400, code: 'CPF_OBRIGATORIO' },
    );
  }

  const telefone = onlyDigits(input.customer.phone);
  const nome = input.customer.name.trim().slice(0, 100);
  const email = input.customer.email.trim().slice(0, 255);

  /*
   * A documentação se contradiz: a seção "Parameters" e as "Validation Rules"
   * usam receiver_*, enquanto os exemplos de código usam customer_*. Seguimos a
   * especificação (receiver_*), que é onde está o aviso do CPF obrigatório.
   * Como não existe ambiente de teste, a primeira cobrança real confirma isso —
   * um 400 reclamando de campo ausente aponta que os exemplos é que valem.
   */
  const payload: Record<string, unknown> = {
    amount: Number(centsToAmount(input.amountCents).toFixed(2)),
    description: input.description.slice(0, 200),
    receiver_cpf: documento,
    external_id: input.externalId.slice(0, 50),
  };

  if (nome.length >= 2) payload.receiver_name = nome;
  if (email.includes('@')) payload.receiver_email = email;
  /*
   * O telefone só vai se for um celular que a PixGo aceita: 11 dígitos com 9
   * logo após o DDD.
   *
   * A regra antes era só de tamanho, e 10 ou 11 dígitos passavam. Em 08/08/2026
   * um cliente digitou "(89) 66452-2210" e a PixGo recusou a cobrança inteira
   * com "Celular deve começar com 9 após o DDD" — por um campo OPCIONAL, que
   * nem precisava ter sido enviado. Ele tentou quatro vezes e desistiu.
   *
   * Telefone fixo e celular antigo continuam sendo guardados no nosso banco,
   * que é onde eles servem para alguma coisa: falar com o cliente. O que não
   * pode é um dado acessório derrubar o pagamento.
   */
  if (telefone.length === 11 && telefone[2] === '9') payload.receiver_phone = telefone;
  if (input.webhookUrl) payload.webhook_url = input.webhookUrl;

  const { status, body } = await requisicao('/payment/create', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (status < 200 || status >= 300 || body?.success !== true) throw falhaDe(status, body);

  const dados = body?.data ?? {};
  const qrCode = String(dados.qr_code ?? '').trim();
  if (!qrCode) {
    // Sem copia e cola não há o que mostrar: melhor falhar agora do que pôr o
    // cliente diante de uma tela de pagamento vazia.
    throw new PixGatewayError('A PixGo não devolveu o código PIX da cobrança.', {
      status: 502,
      code: 'SEM_QRCODE',
      details: dados,
    });
  }

  return {
    paymentId: String(dados.payment_id ?? ''),
    status: mapStatus(dados.status),
    statusBruto: String(dados.status ?? ''),
    adquirente: acharAdquirente(dados as Record<string, unknown>),
    qrCode,
    qrImageUrl: dados.qr_image_url ? String(dados.qr_image_url) : null,
    // A validade varia por cobrança: a própria documentação manda usar o
    // expires_at devolvido em vez de supor um valor fixo.
    expiresAt: normalizeApiDate(dados.expires_at) ?? null,
  };
}

/**
 * A cobrança pela SyncPay: POST /api/partner/v1/cash-in.
 *
 * TRÊS DIFERENÇAS da PixGo que valem dinheiro:
 *
 * 1. NÃO DEVOLVE VALIDADE. A resposta traz só pix_code e identifier. Os 20
 *    minutos abaixo são o padrão do PIX dinâmico e batem com o resto do funil
 *    (contagem na tela, marca de expirado, recuperação) — o primeiro teste
 *    real confere se a cobrança de verdade vive isso tudo.
 * 2. NÃO ACEITA external_id. O vínculo pedido→cobrança fica só pelo identifier
 *    deles, que guardamos como paymentId — o webhook e a consulta usam ele.
 * 3. TELEFONE E E-MAIL DO CLIENTE SÃO OBRIGATÓRIOS. O nosso telefone é
 *    opcional na tela; quando o cliente não deixou, vai um número neutro no
 *    formato aceito, marcado como tal na descrição do problema: recusar a
 *    venda por um campo que o gateway exige e o cliente não deu seria pagar o
 *    atrito duas vezes. Se o teste real recusar o neutro, a alternativa é
 *    tornar o campo obrigatório no checkout — decisão do dono.
 */
const TELEFONE_NEUTRO = '11999999999';

async function createPaymentSyncPay(input: CreatePaymentInput): Promise<PixCharge> {
  const documento = onlyDigits(input.customer.document);
  if (documento.length !== 11 && documento.length !== 14) {
    throw new PixGatewayError(
      'A SyncPay exige o CPF (ou CNPJ) de quem vai pagar.',
      { status: 400, code: 'CPF_OBRIGATORIO' },
    );
  }

  const telefone = onlyDigits(input.customer.phone);
  const payload = {
    amount: Number(centsToAmount(input.amountCents).toFixed(2)),
    description: input.description.slice(0, 200),
    ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
    client: {
      name: input.customer.name.trim().slice(0, 100) || 'Cliente',
      cpf: documento,
      email: input.customer.email.trim().slice(0, 255),
      phone: telefone.length === 10 || telefone.length === 11 ? telefone : TELEFONE_NEUTRO,
    },
  };

  const { status, body } = await requisicao('/api/partner/v1/cash-in', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (status < 200 || status >= 300) throw falhaDe(status, body);

  const dados = body?.data ?? body ?? {};
  const qrCode = String(dados.pix_code ?? '').trim();
  const identifier = String(dados.identifier ?? '').trim();
  if (!qrCode || !identifier) {
    throw new PixGatewayError('A SyncPay não devolveu o código PIX da cobrança.', {
      status: 502,
      code: 'SEM_QRCODE',
      details: body,
    });
  }

  return {
    paymentId: identifier,
    status: 'pending',
    statusBruto: 'pending',
    qrCode,
    qrImageUrl: null,
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  };
}


/* -------------------------------------------------------------------------- */
/* ZuckPay: Basic auth em cada chamada                                        */
/* -------------------------------------------------------------------------- */

/**
 * A conversa com a ZuckPay.
 *
 * SEM TOKEN INTERMEDIARIO, de proposito: a doc aceita o par client_id/secret
 * tanto em Basic auth quanto no corpo, e escolher o header elimina a classe
 * inteira de falha que a SyncPay trouxe — instancia serverless que hiberna,
 * volta com um Bearer vencido e derruba a primeira cobranca do dia.
 *
 * O par vai SO no header. A doc permite manda-lo no corpo do JSON, e nao
 * fazemos isso: corpo de requisicao aparece em log de erro, em captura de rede
 * e no `details` que este arquivo anexa as falhas — e ai o segredo vazaria para
 * dentro do nosso proprio painel.
 */
function basicDaZuckPay(): string {
  const { clientId, clientSecret } = config.pix.zuckpay;
  if (!clientId || !clientSecret) {
    throw new PixGatewayError(
      'ZUCKPAY_CLIENT_ID/ZUCKPAY_CLIENT_SECRET nao configurados: sem eles nao ha como falar com a ZuckPay.',
      { status: 503, code: 'GATEWAY_SEM_CREDENCIAL' },
    );
  }
  return Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
}

async function requisicaoZuckPay(caminho: string, init: RequestInit = {}, timeoutMs?: number): Promise<RespostaCrua> {
  const basic = basicDaZuckPay();
  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), timeoutMs ?? config.pix.requestTimeoutMs);
  try {
    const resposta = await fetch(`${config.pix.zuckpay.baseUrl}${caminho}`, {
      ...init,
      signal: controlador.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const texto = await resposta.text();
    let body: any = null;
    try {
      body = texto ? JSON.parse(texto) : null;
    } catch {
      body = { raw: texto.slice(0, 500) };
    }
    return { status: resposta.status, body };
  } catch (erro) {
    if ((erro as Error).name === 'AbortError') {
      throw new PixGatewayError('A ZuckPay nao respondeu a tempo.', { status: 504, code: 'GATEWAY_TIMEOUT' });
    }
    throw new PixGatewayError(`Falha ao falar com a ZuckPay: ${(erro as Error).message}`, {
      status: 502,
      code: 'GATEWAY_INDISPONIVEL',
    });
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * O que o cliente le quando a ZuckPay recusa.
 *
 * Ela nao devolve codigos de erro nomeados como a PixGo — devolve o codigo HTTP
 * e uma mensagem livre. Por isso o mapa e por STATUS, e cada linha registra no
 * log a causa administrativa, que e sempre coisa que so o dono resolve:
 *
 *   401 -> o par client_id/secret esta errado ou foi regenerado no painel deles.
 *   403 -> IP fora da whitelist. A Vercel NAO tem IP fixo: se a lista "IPs
 *          Autorizados" tiver qualquer entrada, TODA cobranca de producao
 *          falha. Ela precisa ficar vazia.
 *   429 -> o teto de tentativas foi estourado (a doc fala em 5 por 30 min).
 *          NAO repetimos aqui: repetir e o que estoura o teto de novo e
 *          transforma um minuto ruim numa meia hora sem vender.
 *   503 -> cotacao de moeda indisponivel. So afeta cobranca fora do BRL, e a
 *          doc garante que nada foi criado — repetir e seguro.
 */
function falhaDaZuckPay(status: number, body: any): PixGatewayError {
  const original = String(body?.message ?? body?.error ?? body?.raw ?? `HTTP ${status}`).slice(0, 300);

  const administrativo: Record<number, string> = {
    401: 'ZuckPay recusou as credenciais (401). Confira ZUCKPAY_CLIENT_ID/ZUCKPAY_CLIENT_SECRET.',
    403: 'ZuckPay recusou o IP (403). A lista "IPs Autorizados" precisa estar VAZIA: a Vercel nao tem IP fixo.',
    429: 'ZuckPay aplicou limite de requisicoes (429). Nenhuma repeticao foi feita, para nao estourar o teto de novo.',
    503: 'ZuckPay sem cotacao de moeda (503). Nenhuma cobranca foi criada.',
  };
  if (administrativo[status]) {
    logger.error(administrativo[status], { mensagemDeles: original });
  } else if (status >= 500) {
    logger.error('ZuckPay respondeu erro de servidor', { status, mensagemDeles: original });
  } else {
    logger.warn('ZuckPay recusou a requisicao', { status, mensagemDeles: original });
  }

  /*
   * O cliente NUNCA le a causa administrativa: "IP nao autorizado" no meio de
   * um checkout nao diz nada para quem esta tentando comprar, e ainda expoe
   * como a nossa integracao e feita. Ele le o que da para fazer.
   */
  const paraOCliente = status === 400
    ? 'Confira os seus dados: algum campo nao foi aceito. O CPF precisa ser o de quem vai pagar, com todos os digitos.'
    : 'Nao foi possivel gerar o PIX agora. Tente novamente em instantes.';

  return new PixGatewayError(paraOCliente, {
    status: status >= 500 || status === 429 ? 502 : 400,
    code: `ZUCKPAY_${status}`,
    details: body,
  });
}

/**
 * A cobranca pela ZuckPay: POST /v3/pix/qrcode.
 *
 * O que difere dos outros dois e vale dinheiro:
 *
 * 1. ACEITA `external_id_client`. E o nosso id de pedido indo junto, e ele
 *    volta no postback — entao mesmo que o `transactionId` se perca, o webhook
 *    ainda encontra o pedido. Nem a SyncPay tinha isso.
 * 2. DEVOLVE A VALIDADE, em `calendar.expiration` (segundos). Usamos o valor
 *    deles em vez de supor 20 minutos: o relogio da tela e a marca de expirado
 *    passam a bater com a cobranca de verdade.
 * 3. TELEFONE E OBRIGATORIO na doc. Quando o cliente nao deixou o dele, vai um
 *    numero neutro — recusar a venda por um campo que o gateway exige e a nossa
 *    tela nao pede seria pagar o atrito duas vezes.
 */
async function createPaymentZuckPay(input: CreatePaymentInput): Promise<PixCharge> {
  const documento = onlyDigits(input.customer.document);
  if (documento.length !== 11 && documento.length !== 14) {
    throw new PixGatewayError('A ZuckPay exige o CPF (ou CNPJ) de quem vai pagar.', {
      status: 400,
      code: 'CPF_OBRIGATORIO',
    });
  }

  const telefone = onlyDigits(input.customer.phone);
  const payload = {
    nome: input.customer.name.trim().slice(0, 100) || 'Cliente',
    cpf: documento,
    valor: Number(centsToAmount(input.amountCents).toFixed(2)),
    email: input.customer.email.trim().slice(0, 255),
    telefone: telefone.length === 10 || telefone.length === 11 ? telefone : TELEFONE_NEUTRO,
    descricao: input.description.slice(0, 200),
    external_id_client: input.externalId.slice(0, 50),
    ...(input.webhookUrl ? { urlnoty: input.webhookUrl } : {}),
  };

  const { status, body } = await requisicao('/v3/pix/qrcode', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (status < 200 || status >= 300) throw falhaDaZuckPay(status, body);

  const dados = body?.data ?? body ?? {};
  /* A doc devolve o mesmo texto em dois campos. Preencher so um deles continua
   * funcionando aqui — e ficar sem copia e cola e a unica falha desta tela que
   * o cliente nao consegue contornar sozinho. */
  const qrCode = String(dados.pix_code ?? dados.qrcode ?? '').trim();
  const transacao = String(dados.transactionId ?? dados.transaction_id ?? '').trim();
  if (!qrCode || !transacao) {
    throw new PixGatewayError('A ZuckPay nao devolveu o codigo PIX da cobranca.', {
      status: 502,
      code: 'SEM_QRCODE',
      details: body,
    });
  }

  /*
   * O valor cobrado tem de ser o valor pedido.
   *
   * O QR e o que o cliente paga: se a ZuckPay criasse a cobranca por outro
   * numero, venderiamos pelo preco dela e descobririamos pelo extrato, no fim
   * do mes. A comparacao e em CENTAVOS INTEIROS porque a resposta as vezes traz
   * o valor como texto ("15.000000" aparece assim no postback deles) — comparar
   * float com float acusaria diferenca onde nao ha.
   */
  const cobrado = Number(dados.amount ?? dados.valor);
  if (Number.isFinite(cobrado) && Math.round(cobrado * 100) !== input.amountCents) {
    /*
     * O cliente le a frase generica, nao o motivo.
     *
     * `message` de PixGatewayError vai INTEIRA para a tela do checkout. "A
     * ZuckPay criou a cobranca com outro valor" faz quem esta comprando achar
     * que foi cobrado errado — e ligar para o banco em vez de tentar de novo.
     * O motivo de verdade fica no log e no `details`, que e onde o dono olha.
     */
    logger.error('ZuckPay criou a cobranca por outro valor; nada foi mostrado ao cliente', {
      pedimosCentavos: input.amountCents,
      cobradoCentavos: Math.round(cobrado * 100),
      externalId: input.externalId,
    });
    throw new PixGatewayError('Nao foi possivel gerar o PIX agora. Tente novamente em instantes.', {
      status: 502,
      code: 'VALOR_DIVERGENTE',
      details: { pedimosCentavos: input.amountCents, cobradoCentavos: Math.round(cobrado * 100) },
    });
  }

  /*
   * A validade vem deles, em segundos. O teto de 24 h barra um numero absurdo
   * (ou um campo em milissegundos vindo por engano) virando uma expiracao para
   * daqui a anos — o pedido nunca seria marcado como vencido e ficaria sendo
   * reconsultado ate o fim dos tempos.
   */
  const segundos = Number(dados.calendar?.expiration ?? dados.expiration);
  const validadeMs = Number.isFinite(segundos) && segundos > 0 && segundos <= 86_400
    ? segundos * 1000
    : 20 * 60_000;

  return {
    paymentId: transacao,
    status: mapStatus(dados.status ?? 'pending'),
    statusBruto: String(dados.status ?? 'PENDING'),
    qrCode,
    qrImageUrl: dados.qrcode_image ? String(dados.qrcode_image) : null,
    expiresAt: new Date(Date.now() + validadeMs).toISOString(),
    adquirente: acharAdquirente(dados as Record<string, unknown>),
  };
}

/** Consulta o status na ZuckPay: GET /v3/pix/status?transactionId=... */
async function fetchPaymentStatusZuckPay(paymentId: string, timeoutMs?: number): Promise<PixPaymentStatus> {
  const { status, body } = await requisicao(
    `/v3/pix/status?transactionId=${encodeURIComponent(paymentId)}`,
    { method: 'GET' },
    timeoutMs,
  );

  /*
   * A ZuckPay repete o codigo em `statusCode` DENTRO do corpo, e ja foi visto
   * gateway devolvendo 200 no HTTP com 404 no corpo. Olhar so o HTTP faria um
   * "nao existe" virar `mapStatus(undefined)` -> pendente eterno.
   */
  const codigo = Number(body?.statusCode);
  const efetivo = Number.isFinite(codigo) && codigo >= 400 ? codigo : status;

  if (efetivo === 404) {
    throw new PixGatewayError('A ZuckPay nao encontrou essa transacao.', {
      status: 404,
      code: CODIGO_COBRANCA_SUMIU,
      details: body,
    });
  }
  if (efetivo < 200 || efetivo >= 300) throw falhaDaZuckPay(efetivo, body);

  const dados = body?.data ?? body ?? {};
  return {
    paymentId,
    status: mapStatus(dados.status),
    statusBruto: String(dados.status ?? ''),
    /* `confirmed_date` so existe quando pagou; nos demais casos vale a criacao. */
    updatedAt: normalizeApiDate(dados.confirmed_date ?? dados.updated_at ?? dados.created_at) ?? null,
  };
}

/**
 * Consulta o status real da cobrança.
 *
 * É a fonte da verdade do sistema: o webhook não confia no corpo que recebe,
 * ele chama esta função. Em qualquer dúvida devolvemos 'pending', porque o erro
 * de responder 'completed' à toa entrega produto sem pagamento.
 */
export async function fetchPaymentStatus(
  paymentId: string,
  opcoes: { timeoutMs?: number } = {},
): Promise<PixPaymentStatus> {
  if (config.mode === 'mock') return fetchMockPaymentStatus(paymentId);

  if (config.pix.provider === 'zuckpay') return fetchPaymentStatusZuckPay(paymentId, opcoes.timeoutMs);

  if (config.pix.provider === 'syncpay') {
    const { status, body } = await requisicao(
      `/api/partner/v1/transaction/${encodeURIComponent(paymentId)}`,
      { method: 'GET' },
      opcoes.timeoutMs,
    );
    // 404 na SyncPay = transação desconhecida. O contrato de erro é o mesmo da
    // PixGo (CODIGO_COBRANCA_SUMIU) para o resto do sistema não saber a diferença.
    if (status === 404) {
      throw new PixGatewayError('A SyncPay não encontrou essa transação.', {
        status: 404,
        code: CODIGO_COBRANCA_SUMIU,
        details: body,
      });
    }
    if (status !== 200) throw falhaDe(status, body);
    const dados = body?.data ?? body ?? {};
    return {
      paymentId,
      status: mapStatus(dados.status),
      statusBruto: String(dados.status ?? ''),
      updatedAt: normalizeApiDate(dados.updated_at ?? dados.transaction_date) ?? null,
    };
  }

  /*
   * Usamos /payment/{id}, e não /payment/{id}/status, por causa do limite de
   * requisições: o de status é 1.000 por 24 h, dez vezes menor que os 10.000
   * deste. Estourar o teto significaria parar de confirmar pagamento de cliente
   * que já pagou — e os dois devolvem o mesmo campo `status`.
   */
  const { status, body } = await requisicao(
    `/payment/${encodeURIComponent(paymentId)}`,
    { method: 'GET' },
    opcoes.timeoutMs,
  );

  /*
   * 410 não é erro: a PixGo responde assim quando a cobrança chegou a um estado
   * final (expirada, cancelada, estornada), com o mesmo corpo do 200 e
   * "terminal": true. Tratar como falha faria o pedido ficar sendo reconsultado
   * para sempre, gastando o orçamento diário à toa.
   */
  if (status !== 200 && status !== 410) throw falhaDe(status, body);
  if (body?.success !== true) throw falhaDe(status, body);

  const dados = body?.data ?? {};

  return {
    paymentId,
    status: mapStatus(dados.status),
    statusBruto: String(dados.status ?? ''),
    updatedAt: normalizeApiDate(dados.updated_at) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Modo mock, para desenvolver o funil sem gerar cobrança real                 */
/* -------------------------------------------------------------------------- */

interface MockPayment {
  paymentId: string;
  confirmsAt: number;
  expiresAt: number;
}

const mockPayments = new Map<string, MockPayment>();
const MOCK_CONFIRM_DELAY_MS = Number.parseInt(process.env.MOCK_CONFIRM_DELAY_MS ?? '12000', 10);
/*
 * Os mesmos 20 minutos da PixGo, e configurável pelo mesmo motivo do atraso de
 * confirmação acima: a bateria da recuperação precisa de um código VENCIDO para
 * verificar que o lembrete troca o corpo da mensagem, e esperar vinte minutos
 * de relógio real em cada rodada de teste é o jeito mais garantido de o teste
 * deixar de ser rodado.
 */
const MOCK_EXPIRY_MS = Number.parseInt(process.env.MOCK_EXPIRY_MS ?? String(20 * 60_000), 10);

function createMockPayment(input: CreatePaymentInput): PixCharge {
  const paymentId = `mock_${newId(8)}`;
  const now = Date.now();
  mockPayments.set(paymentId, {
    paymentId,
    confirmsAt: now + MOCK_CONFIRM_DELAY_MS,
    expiresAt: now + MOCK_EXPIRY_MS,
  });

  logger.warn('MODO MOCK: cobrança simulada criada (nenhum PIX real foi gerado)', {
    paymentId,
    amount: centsToAmount(input.amountCents),
    confirmaEmSegundos: Math.round(MOCK_CONFIRM_DELAY_MS / 1000),
  });

  return {
    paymentId,
    status: 'pending',
    statusBruto: 'PENDING',
    qrCode: `00020126MOCK-NAO-PAGUE-${paymentId}-${centsToAmount(input.amountCents).toFixed(2)}`,
    qrImageUrl: null,
    expiresAt: new Date(now + MOCK_EXPIRY_MS).toISOString(),
  };
}

function fetchMockPaymentStatus(paymentId: string): PixPaymentStatus {
  const payment = mockPayments.get(paymentId);
  if (!payment) {
    return { paymentId, status: 'pending', statusBruto: 'PENDING', updatedAt: null };
  }
  const now = Date.now();
  const status: OrderStatus = now >= payment.confirmsAt ? 'completed' : now >= payment.expiresAt ? 'expired' : 'pending';
  return { paymentId, status, statusBruto: status.toUpperCase(), updatedAt: new Date().toISOString() };
}
