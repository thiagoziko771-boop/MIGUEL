import path from 'node:path';
import { config as loadEnvFile } from 'dotenv';

loadEnvFile({ path: path.resolve(process.cwd(), '.env') });
loadEnvFile({ path: path.resolve(process.cwd(), '.env.local'), override: true });

export type GatewayMode = 'live' | 'mock';

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'sim']);

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return TRUTHY.has(value.trim().toLowerCase());
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCents(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat((value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : fallback;
}

const fatalErrors: string[] = [];
const warnings: string[] = [];

/*
 * O padrão é "live" de propósito. O modo mock confirma pagamento sozinho, então
 * cair nele por variável ausente entregaria produto de graça — é o erro que a
 * configuração jamais pode cometer sozinha.
 */
const mode = ((process.env.PIX_MODE ?? 'live').trim().toLowerCase() || 'live') as GatewayMode;
if (mode !== 'live' && mode !== 'mock') {
  fatalErrors.push(`PIX_MODE deve ser "live" ou "mock" (valor recebido: "${mode}").`);
}

/*
 * Qual gateway processa o PIX. O padrão é a PixGo — trocar exige decisão
 * explícita por variável, nunca acontece por acidente de deploy.
 *
 * A SyncPay entrou em 14/08/2026 como candidata a substituta: a PixGo liquida
 * como "PRIME UNION TRADING FIN" e o banco do cliente marca a transação como
 * suspeita. A troca só se consuma depois de um teste real dizer qual nome a
 * SyncPay estampa no campo 59 — até lá, o código dorme atrás desta variável.
 */
const PROVEDORES_DE_PIX = ['pixgo', 'syncpay', 'zuckpay'] as const;
type ProvedorDePix = (typeof PROVEDORES_DE_PIX)[number];

const pixProvider = ((process.env.PIX_PROVIDER ?? 'pixgo').trim().toLowerCase() || 'pixgo') as ProvedorDePix;
if (!(PROVEDORES_DE_PIX as readonly string[]).includes(pixProvider)) {
  fatalErrors.push(
    `PIX_PROVIDER deve ser ${PROVEDORES_DE_PIX.map((p) => `"${p}"`).join(', ')} (valor recebido: "${pixProvider}").`,
  );
}

const pixApiKey = (process.env.PIXGO_API_KEY ?? '').trim();
const pixWebhookSecret = (process.env.PIXGO_WEBHOOK_SECRET ?? '').trim();
const syncpayClientId = (process.env.SYNCPAY_CLIENT_ID ?? '').trim();
const syncpayClientSecret = (process.env.SYNCPAY_CLIENT_SECRET ?? '').trim();
const zuckpayClientId = (process.env.ZUCKPAY_CLIENT_ID ?? '').trim();
const zuckpayClientSecret = (process.env.ZUCKPAY_CLIENT_SECRET ?? '').trim();
const zuckpayWebhookSecret = (process.env.ZUCKPAY_WEBHOOK_SECRET ?? '').trim();

if (mode === 'live' && pixProvider === 'pixgo' && !pixApiKey) {
  fatalErrors.push('PIXGO_API_KEY é obrigatória quando PIX_MODE=live. Pegue em pixgo.org, seção Checkouts.');
}
if (mode === 'live' && pixProvider === 'pixgo' && !pixWebhookSecret) {
  warnings.push(
    'PIXGO_WEBHOOK_SECRET não configurada: sem ela o callback da PixGo não pode ser verificado e será recusado. ' +
      'A confirmação passa a depender só da varredura de pendentes. Pegue o segredo (whsec_...) na seção Checkouts.',
  );
}
if (mode === 'live' && pixProvider === 'syncpay' && (!syncpayClientId || !syncpayClientSecret)) {
  fatalErrors.push('SYNCPAY_CLIENT_ID e SYNCPAY_CLIENT_SECRET são obrigatórios quando PIX_PROVIDER=syncpay.');
}
if (mode === 'live' && pixProvider === 'zuckpay' && (!zuckpayClientId || !zuckpayClientSecret)) {
  fatalErrors.push(
    'ZUCKPAY_CLIENT_ID e ZUCKPAY_CLIENT_SECRET são obrigatórios quando PIX_PROVIDER=zuckpay. ' +
      'Pegue o par em zuckpay.com.br → Credenciais API.',
  );
}
if (mode === 'live' && pixProvider === 'zuckpay' && !zuckpayWebhookSecret) {
  warnings.push(
    'ZUCKPAY_WEBHOOK_SECRET não configurada: o postback da ZuckPay chega SEM assinatura e não há como provar ' +
      'que veio deles. Continua seguro porque o status é sempre reconsultado na API, mas gere o segredo em ' +
      'zuckpay.com.br → /conta/keys.php e configure aqui.',
  );
}

/*
 * Boleto — a segunda forma de pagar, decidida pelo dono em 17/08/2026.
 *
 * O provedor de boleto NÃO é o mesmo do PIX: a PixGo só emite PIX e a rota do
 * boleto ainda estava em estudo quando este código foi escrito. Por isso ele
 * mora atrás de uma variável própria, e o padrão é NÃO EMITIR: um boleto
 * emitido por engano é um documento com valor, prazo e nome do cliente — não é
 * como um QR que expira em vinte minutos e ninguém mais vê.
 *
 * `boletoProvider` vazio significa "ainda não escolhido". Nesse estado a opção
 * simplesmente não aparece no checkout, e quem tentar forçar a escolha por API
 * leva um erro explicando o que falta. O único provedor implementado hoje é o
 * `mock`, que existe para o funil inteiro poder ser testado sem emitir nada.
 */
const boletoProvider = (process.env.BOLETO_PROVIDER ?? '').trim().toLowerCase();
const boletoHabilitadoPorConfig = readBool(process.env.BOLETO_HABILITADO, true);

if (boletoProvider && boletoProvider !== 'mock') {
  fatalErrors.push(
    `BOLETO_PROVIDER="${boletoProvider}" não tem implementação neste código. ` +
      'Hoje só existe "mock" (para testes). Ver o bloco "IMPLEMENTAR AQUI" em server/boleto.ts.',
  );
}
if (mode === 'live' && boletoProvider === 'mock') {
  fatalErrors.push(
    'BOLETO_PROVIDER=mock com PIX_MODE=live: o boleto simulado se confirma sozinho e liberaria o produto sem pagamento. ' +
      'Apague BOLETO_PROVIDER em produção até haver um provedor de verdade.',
  );
}
if (boletoHabilitadoPorConfig && !boletoProvider) {
  warnings.push(
    'Boleto indisponível: BOLETO_PROVIDER não está definido. O checkout segue só com PIX, ' +
      'que é o comportamento correto até a rota de emissão ser escolhida.',
  );
}

/*
 * O WhatsApp de atendimento — o boleto ENQUANTO não há quem o emita.
 *
 * Decisão do dono em 17/08/2026: em vez de esperar a rota de emissão, a opção
 * "boleto e outras formas" abre uma conversa com ele. Quem não quer PIX deixa de
 * ser uma venda perdida em silêncio e passa a ser uma conversa — que ele resolve
 * à mão, como já faz com quem some no meio do checkout.
 *
 * Número vazio esconde a opção, e é o padrão: um botão que abre o WhatsApp de
 * ninguém manda o cliente para o vazio no exato momento em que ele quis pagar.
 */
const whatsappSuporte = (process.env.WHATSAPP_SUPORTE ?? '').replace(/\D/g, '');
if (whatsappSuporte && (whatsappSuporte.length < 12 || whatsappSuporte.length > 13)) {
  warnings.push(
    `WHATSAPP_SUPORTE="${whatsappSuporte}" não parece um número com país e DDD (esperado 12 ou 13 dígitos, ` +
      'como 5569992128827). A opção de falar no WhatsApp fica escondida até o número estar certo.',
  );
}

const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
if (mode === 'live' && !publicBaseUrl.startsWith('https://')) {
  warnings.push(
    'PUBLIC_BASE_URL não é uma URL https pública: sem ela não há endereço de callback para informar ao gateway, ' +
      'e a confirmação do pagamento passa a depender só da varredura de pendentes.',
  );
}

// Painel do dono. Sem ADMIN_SENHA o /admin recusa qualquer login: é melhor o
// painel não abrir do que abrir sem senha com os dados dos clientes dentro.
const adminSenha = (process.env.ADMIN_SENHA ?? '').trim();
const leadsSenha = (process.env.LEADS_SENHA ?? '').trim();
const painelChaveMestra = (process.env.PAINEL_CHAVE_MESTRA ?? '').trim();

if (!adminSenha) {
  warnings.push('ADMIN_SENHA não configurada: o painel /admin ficará inacessível.');
} else if (adminSenha.length < 10) {
  warnings.push('ADMIN_SENHA tem menos de 10 caracteres: use uma senha longa, ela protege CPF e contato dos clientes.');
}
if (adminSenha && !painelChaveMestra) {
  warnings.push(
    'PAINEL_CHAVE_MESTRA não configurada: gere com "openssl rand -hex 32". ' +
      'Sem ela o painel não consegue assinar sessões nem links de entrega.',
  );
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// Postgres é obrigatório em serverless (Vercel): lá o disco é efêmero e cada
// requisição pode cair em outra instância. Sem a variável, caímos no arquivo
// local, que só serve para desenvolvimento.
const databaseUrl = (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '').trim();

/*
 * Meta (Facebook/Instagram). O rastreamento é uma camada paralela: se ele
 * estiver desligado ou falhar, a venda continua acontecendo igual.
 *
 * O padrão é DESLIGADO quando falta credencial — o contrário do PIX_MODE, e
 * pelo mesmo raciocínio: aqui o erro caro é mandar evento para o lugar errado
 * ou tentar falar com o Meta sem token a cada pagamento, não deixar de mandar.
 */
const metaPixelId = (process.env.META_PIXEL_ID ?? '').trim();
const metaCapiToken = (process.env.META_CAPI_TOKEN ?? '').trim();
const metaLigadoPorConfig = readBool(process.env.META_TRACKING_ENABLED, true);
const metaTestEventCode = (process.env.META_TEST_EVENT_CODE ?? '').trim();

if (metaLigadoPorConfig && metaPixelId && !metaCapiToken) {
  warnings.push(
    'META_PIXEL_ID configurado sem META_CAPI_TOKEN: os eventos do servidor não serão enviados. ' +
      'Sem eles, a compra por PIX se perde — quem paga no app do banco costuma não voltar ao site. ' +
      'Dá para preencher pelo painel, em Anúncios → Credenciais do Meta.',
  );
}
if (metaTestEventCode) {
  warnings.push(
    `META_TEST_EVENT_CODE preenchido (${metaTestEventCode}): os eventos vão para a aba "Testar eventos" ` +
      'e NÃO contam como conversão real. Apague a variável em produção.',
  );
}

export const config = {
  mode,
  port: readInt(process.env.PORT, 3333),
  host: (process.env.HOST ?? '0.0.0.0').trim(),
  publicBaseUrl,
  allowedOrigins,
  databaseUrl,

  /** Gateway de PIX. Qual deles fala é decidido por `provider`. */
  pix: {
    /** `pixgo` (padrão), `syncpay` ou `zuckpay`. Ver o comentário na validação acima. */
    provider: pixProvider,
    /**
     * Credenciais da ZuckPay (zuckpay.com.br). Diferente da SyncPay, aqui NÃO
     * existe token de uma hora: o par vai em Basic auth a cada requisição, o
     * que elimina a classe inteira de falha "instância hibernou com o Bearer
     * vencido".
     */
    zuckpay: {
      clientId: zuckpayClientId,
      clientSecret: zuckpayClientSecret,
      /**
       * Segredo do postback, gerado em /conta/keys.php. Com ele, cada aviso
       * chega assinado no header `X-ZuckPay-Signature: t=<ts>,v1=<hmac>` e o
       * que não bate é recusado na porta. Sem ele, o aviso chega sem header
       * nenhum — e o que protege é a reconsulta, que nunca acredita no corpo.
       */
      webhookSecret: zuckpayWebhookSecret,
      /*
       * O caminho `/conta` faz parte da base: os endpoints da doc são
       * `/conta/v3/pix/qrcode` e `/conta/v3/pix/status`. Deixar a base sem ele
       * gera 404 em tudo — e 404 na criação de cobrança é venda perdida em
       * silêncio, porque a tela só diz "não foi possível gerar o PIX agora".
       */
      baseUrl: (process.env.ZUCKPAY_BASE_URL ?? 'https://www.zuckpay.com.br/conta').trim().replace(/\/+$/, ''),
    },
    /**
     * Credenciais da SyncPay (api.syncpay.pro). O par gera um Bearer de 1 h no
     * /auth-token; quem gerencia validade e renovação é server/pix.ts.
     */
    syncpay: {
      clientId: syncpayClientId,
      clientSecret: syncpayClientSecret,
      /**
       * O Bearer que a SyncPay manda em cada webhook — devolvido UMA vez, na
       * criação do webhook pela API (id 12603, 14/08/2026). Com ele, aviso com
       * Authorization errado é recusado na porta; sem header nenhum, o aviso
       * ainda passa e cai na reconsulta (o cash-in "padrão OLD" avisa sem
       * token, e perder um aviso legítimo custa mais que processar um falso —
       * que a reconsulta neutraliza de todo jeito).
       */
      webhookToken: (process.env.SYNCPAY_WEBHOOK_TOKEN ?? '').trim(),
      // Do painel deles (app.syncpayments.com.br → API → "BASE URL"), visto em
      // print do dono em 14/08/2026 — a busca na web apontava api.syncpay.pro,
      // que é o domínio antigo.
      baseUrl: (process.env.SYNCPAY_BASE_URL ?? 'https://api.syncpayments.com.br').trim().replace(/\/+$/, ''),
    },
    /** Chave da PixGo (pk_...), do menu Checkouts do painel deles. */
    apiKey: pixApiKey,
    /** Segredo do webhook (whsec_...), logo abaixo da chave no mesmo painel. */
    webhookSecret: pixWebhookSecret,
    baseUrl: (process.env.PIXGO_BASE_URL ?? 'https://pixgo.org/api/v1').trim().replace(/\/+$/, ''),
    requestTimeoutMs: readInt(process.env.PIX_TIMEOUT_MS, 15_000),
    /**
     * Mínimo da PixGo: R$ 10,00 por cobrança. Barrar aqui devolve uma mensagem
     * nossa ao cliente em vez de um 400 do gateway no meio do checkout.
     */
    minAmountCents: readCents(process.env.PIX_MIN_AMOUNT_BRL, 1000),
    /**
     * Teto absoluto por QR Code na PixGo: R$ 6.000,00. O teto que vale de
     * verdade é o do nível da conta, que começa em R$ 300 e sobe conforme o
     * total confirmado — acima dele quem recusa é a API, com LIMIT_EXCEEDED.
     */
    maxAmountCents: readCents(process.env.PIX_MAX_AMOUNT_BRL, 600_000),
    /**
     * Janela aceita entre o carimbo do webhook e a chegada dele. A PixGo assina
     * `timestamp + "." + corpo`, e recusar carimbo velho é o que impede reenviar
     * um aviso legítimo capturado antes.
     */
    webhookToleranciaSegundos: readInt(process.env.PIX_WEBHOOK_TOLERANCIA_S, 300),
  },

  /**
   * Boleto bancário. Ver o comentário longo na validação, acima.
   *
   * `disponivel` é a resposta para "o checkout pode oferecer boleto?" — e é a
   * ÚNICA que o resto do sistema deve consultar. Ela já embute a regra de que
   * sem provedor escolhido não há emissão, para ninguém precisar repetir esse
   * cuidado em cada tela.
   */
  boleto: {
    provider: boletoProvider,
    disponivel: boletoHabilitadoPorConfig && boletoProvider !== '',
    /**
     * Dias corridos até o vencimento. Três é o intervalo usual do mercado:
     * curto o bastante para a venda não esfriar, longo o bastante para caber um
     * fim de semana — boleto emitido na sexta e vencendo no sábado é boleto que
     * ninguém paga.
     */
    diasParaVencer: readInt(process.env.BOLETO_DIAS_VENCIMENTO, 3),
    /**
     * Piso próprio, mais alto que o do PIX de propósito.
     *
     * A tarifa de emissão é fixa (uns R$ 2 a R$ 4 por documento, conforme o
     * provedor) e não cai com o valor: num pedido de R$ 10 ela come um terço da
     * venda. O piso alto é o que impede o boleto de aparecer justamente onde
     * ele dá prejuízo.
     */
    minAmountCents: readCents(process.env.BOLETO_MIN_AMOUNT_BRL, 2000),
  },

  /**
   * Contato humano do funil. Ver o comentário em `whatsappSuporte`.
   *
   * `boletoPeloWhatsapp` responde à pergunta que a tela faz: "a opção de boleto
   * deve abrir uma conversa?". Só quando há número E não há emissão automática —
   * havendo as duas, o boleto de verdade ganha, porque resolve sozinho e não
   * ocupa o dono.
   */
  contato: {
    whatsapp: whatsappSuporte.length >= 12 && whatsappSuporte.length <= 13 ? whatsappSuporte : '',
    get boletoPeloWhatsapp(): boolean {
      return this.whatsapp !== '' && !(boletoHabilitadoPorConfig && boletoProvider !== '');
    },
  },

  painel: {
    adminSenha,
    leadsSenha,
    chaveMestra: painelChaveMestra,
    /** Validade da sessão do painel, em horas. */
    horasSessao: readInt(process.env.PAINEL_HORAS_SESSAO, 12),
    /** Senhas erradas do mesmo IP antes do bloqueio temporário. */
    maxErrosSenha: readInt(process.env.PAINEL_MAX_ERROS_SENHA, 5),
    /** Duração do bloqueio por senha errada, em minutos. */
    minutosBloqueio: readInt(process.env.PAINEL_MINUTOS_BLOQUEIO, 15),
    /** Fuso fixo do fechamento diário. O Brasil não usa mais horário de verão. */
    fusoOffsetMinutos: readInt(process.env.PAINEL_FUSO_OFFSET_MINUTOS, -180),
  },

  /**
   * Rastreamento do Meta (Facebook/Instagram). Ver server/meta.ts.
   *
   * O que está aqui é o PISO, não a palavra final: o painel pode sobrepor pixel,
   * token e código de teste, e quem resolve a mistura é server/metaCredenciais.ts.
   * Nada no sistema deve ler `pixelId` ou `token` daqui direto — sem passar pelo
   * resolvedor, o que o dono digitou no painel é ignorado em silêncio.
   */
  meta: {
    pixelId: metaPixelId,
    token: metaCapiToken,
    /** Interruptor por ambiente. O painel tem o seu, e ele vence quando existe. */
    ligadoPorConfig: metaLigadoPorConfig,
    apiVersion: (process.env.META_API_VERSION ?? 'v25.0').trim(),
    /**
     * Base da Graph API. Só muda em teste, para apontar ao Meta falso que sobe
     * local — não existe ambiente de homologação de verdade aqui, igual à PixGo.
     */
    baseUrl: (process.env.META_BASE_URL ?? 'https://graph.facebook.com').trim().replace(/\/+$/, ''),
    /** Código da aba "Testar eventos". Preenchido, os eventos NÃO contam como conversão. */
    testEventCode: metaTestEventCode,
    /**
     * Teto de tempo do envio feito DENTRO do caminho do pagamento.
     *
     * A PixGo desiste do webhook em ~10 s e reenvia, e a consulta de status já
     * pode levar 6 s desses. O envio ao Meta não pode empurrar a resposta além
     * disso: o que falhar aqui fica registrado como pendente e é reenviado
     * depois pelo painel, sem segurar o cliente nem provocar reentrega.
     */
    orcamentoNoPagamentoMs: readInt(process.env.META_TIMEOUT_PAGAMENTO_MS, 2_500),
    /** Teto por tentativa nos envios fora do caminho do pagamento. */
    timeoutMs: readInt(process.env.META_TIMEOUT_MS, 8_000),
  },

  /**
   * Envio do e-mail com os acessos, depois do pagamento confirmado.
   *
   * A tela e a /obg prometem esse e-mail desde sempre, e até aqui NADA era
   * enviado: quem fechava a aba antes de anotar o link perdia o que comprou e
   * virava chamado no WhatsApp — ou reembolso.
   *
   * Fica desligado enquanto não houver chave, e desligado significa desligado:
   * sem chave, o pedido é pago e liberado exatamente como antes. Rastreamento e
   * entrega nunca podem custar a venda, e e-mail é a mesma classe de coisa.
   */
  email: {
    apiKey: (process.env.EMAIL_API_KEY ?? '').trim(),
    /**
     * Remetente. Precisa ser de um domínio verificado no provedor — endereço de
     * domínio não verificado é recusado no envio ou vai direto para spam, que é
     * pior: parece entregue e não é.
     */
    remetente: (process.env.EMAIL_REMETENTE ?? 'Rezas Sagradas <contato@rezassagradas.site>').trim(),
    /** Para onde as respostas do cliente vão. Vazio usa o próprio remetente. */
    responderPara: (process.env.EMAIL_RESPONDER_PARA ?? '').trim(),
    /**
     * Base da API do provedor. Só muda em teste, para apontar ao servidor falso
     * que a bateria sobe — mesmo motivo da PixGo e do Meta.
     */
    baseUrl: (process.env.EMAIL_BASE_URL ?? 'https://api.resend.com').trim().replace(/\/+$/, ''),
    /*
     * Teto de tempo DENTRO do caminho do pagamento, pelo mesmo motivo do Meta:
     * a PixGo desiste do webhook em ~10 s e reenvia. O que estourar aqui não se
     * perde — fica registrado e o painel reenvia.
     */
    timeoutMs: readInt(process.env.EMAIL_TIMEOUT_MS, 3_000),
  },

  polling: {
    /** Intervalo mínimo entre duas consultas de status do MESMO pedido. */
    minIntervalMs: readInt(process.env.STATUS_POLL_MIN_INTERVAL_MS, 25_000),
    /*
     * Teto diário de consultas ao gateway, com folga sob o limite real.
     *
     * A PixGo permite 10.000 requisições por 24 h em /payment/{id}, que é o
     * endpoint que usamos. O teto local fica bem abaixo por higiene: serve para
     * um defeito nosso não virar milhares de chamadas, não para chegar perto do
     * limite deles. Estourar significaria parar de confirmar pagamento de quem
     * já pagou.
     */
    dailyBudget: readInt(process.env.STATUS_POLL_DAILY_BUDGET, 5_000),
  },

  /** Janela em que um pedido pendente idêntico é reaproveitado em vez de gerar outra cobrança. */
  reuseWindowMs: readInt(process.env.ORDER_REUSE_WINDOW_MS, 10 * 60_000),

  rateLimit: {
    windowMs: readInt(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60_000),
    maxOrdersPerWindow: readInt(process.env.RATE_LIMIT_MAX_ORDERS, 12),
  },

  dataDir: path.resolve(process.cwd(), (process.env.DATA_DIR ?? '.data').trim()),
  serveStatic: readBool(process.env.SERVE_STATIC, process.env.NODE_ENV === 'production'),
  trustProxy: readBool(process.env.TRUST_PROXY, false),
} as const;

export function getConfigIssues(): { fatalErrors: string[]; warnings: string[] } {
  return { fatalErrors: [...fatalErrors], warnings: [...warnings] };
}
