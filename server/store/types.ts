import type { Atribuicao } from '../atribuicao.js';
import type { OfferId } from '../catalog.js';

export type OrderStatus = 'pending' | 'completed' | 'expired' | 'cancelled' | 'refunded' | 'failed';

/**
 * Como o cliente escolheu pagar.
 *
 * Pedido sem o campo é PIX: até 17/08/2026 não havia escolha, e toda leitura
 * precisa tratar ausência como "pix" em vez de erro — a base tem centenas de
 * pedidos gravados antes deste campo existir.
 */
export type MetodoPagamento = 'pix' | 'boleto';

/**
 * O boleto emitido, do jeito que o cliente precisa dele.
 *
 * A linha digitável é o que importa: é o que a pessoa mais velha digita no app
 * do banco, e é o único campo que funciona sem imprimir nada. O PDF é
 * conveniência de quem vai pagar no caixa.
 */
export interface BoletoEmitido {
  /** Os 47 dígitos que o cliente digita no banco, já formatados com pontos e espaços. */
  linhaDigitavel: string;
  /** O mesmo dado sem formatação, para o botão de copiar. */
  linhaDigitavelCrua: string;
  /** Link do PDF no provedor, quando existir. Nem todo provedor devolve um. */
  urlPdf: string | null;
  /** Data de vencimento em ISO. Depois dela o banco recusa o pagamento. */
  vencimento: string;
}

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'completed',
  'expired',
  'cancelled',
  'refunded',
  'failed',
]);

export interface OrderCustomer {
  name: string;
  email: string;
  phone: string;
  /** CPF/CNPJ completo — necessário para gerar as cobranças seguintes (upsell/downsell). Nunca é exposto pela API. */
  document: string;
}

export interface Order {
  id: string;
  createdAt: string;
  updatedAt: string;
  offer: OfferId;
  itemIds: string[];
  amountCents: number;
  status: OrderStatus;
  customer: OrderCustomer;
  parentOrderId: string | null;
  paymentId: string | null;
  qrCode: string | null;
  qrImageUrl: string | null;
  expiresAt: string | null;
  /**
   * Forma de pagamento escolhida. Ausente = `pix`, pelo motivo explicado no
   * tipo: a base tem pedidos anteriores à existência da escolha.
   */
  metodo?: MetodoPagamento;
  /** Preenchido só quando `metodo === 'boleto'`. */
  boleto?: BoletoEmitido | null;
  paidAt: string | null;
  /** Última vez que consultamos o status no gateway (controle de rate limit). */
  lastStatusCheckAt: number | null;
  /** Eventos de webhook já processados, para descartar reentregas. */
  processedWebhooks: string[];
  clientIp: string | null;
  /**
   * Quando o e-mail com os acessos foi aceito pelo provedor.
   *
   * Preenchido, o envio não se repete — é o que impede a reentrega do webhook
   * de mandar a mesma mensagem várias vezes. Opcional porque pedido antigo não
   * tem o campo, e ausência tem de significar "ainda não foi", nunca erro.
   */
  accessEmailSentAt?: string | null;

  /**
   * Quando o lembrete de PIX não pago foi aceito pelo provedor.
   *
   * Mesma função do `accessEmailSentAt`: preenchido, não se repete. Aqui a
   * repetição é ainda mais cara — o lembrete chega a quem NÃO comprou, e
   * insistir com quem desistiu deixa de ser lembrete e vira perseguição.
   *
   * Opcional porque todo pedido anterior a este campo não o tem, e ausência
   * precisa significar "ainda não mandei", nunca erro.
   */
  recoveryEmailSentAt?: string | null;

  /*
   * Campos do painel. São opcionais porque pedido antigo não os tem: toda
   * leitura precisa tolerar a ausência.
   */
  /** Identificadores de clique do Google Ads, capturados na entrada do site. */
  rastreio?: { gclid: string | null; gbraid: string | null; wbraid: string | null } | null;
  utm?: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null } | null;
  /** User-Agent reduzido. O texto cru nunca é guardado. */
  aparelho?: { tipo: string; so: string; nav: string } | null;
  /** sid anônimo da sessão do funil, para ligar o pedido aos eventos. */
  trackId?: string | null;
  /**
   * Carimbo completo do anúncio que trouxe este cliente, capturado na entrada
   * do site (ver server/atribuicao.ts).
   *
   * Fica GRUDADO no pedido, e não na sessão, porque o PIX é assíncrono: a
   * confirmação chega quando o cliente paga no app do banco, às vezes horas
   * depois e sem navegador nenhum aberto. Sem isso, a venda confirmada não
   * saberia de qual anúncio veio — que é a única pergunta que decide onde
   * colocar dinheiro.
   */
  atribuicao?: Atribuicao | null;
  /**
   * User-Agent cru de quem criou o pedido.
   *
   * O `aparelho` acima guarda só a versão reduzida, que é o suficiente para o
   * painel. O texto completo existe porque a API de Conversões do Meta o exige
   * para casar o evento com a pessoa — sem ele a nota de correspondência cai e
   * a compra deixa de ser atribuída ao anúncio.
   */
  clientUserAgent?: string | null;
  /**
   * Identificador do evento de compra enviado ao Meta. Determinístico
   * (`purchase_<pedido>_<produto>`) para que uma reentrega do webhook não vire
   * duas conversões, e devolvido ao navegador para a /obg deduplicar o disparo
   * do Pixel contra o do servidor.
   */
  purchaseEventId?: string | null;
  /**
   * Último status cru do gateway (PAID, MED, EXPIRED...). O nosso status
   * normalizado perde MED, que vira "pendente" para não revogar acesso; é este
   * campo que permite ao painel mostrar a análise de devolução.
   */
  statusGateway?: string | null;
  /**
   * Qual empresa liquidou de fato o PIX, quando o gateway informa.
   *
   * PixGo e SyncPay são intermediários: por trás delas há um adquirente/PSP que
   * é quem fala com o Banco Central. Nem sempre esse nome vem na resposta, e é
   * por isso que o campo é opcional e a tela só mostra quando existe — inventar
   * "adquirente: PixGo" seria repetir o gateway com outro nome e dar a impressão
   * de que se sabe algo que não se sabe.
   */
  adquirente?: string | null;
  /** Quantas vezes o link de entrega foi aberto. */
  entregas?: { total: number; ultimoEm: string | null; ultimoIp: string | null };

  /**
   * O funil da campanha de recuperação, dentro do próprio pedido.
   *
   * Três marcos, na ordem em que acontecem: o e-mail saiu, ela abriu a página,
   * ela pediu o PIX. Sem isso a campanha é fé — não dá para dizer se o problema
   * foi o assunto do e-mail (ninguém clicou), a página (clicaram e saíram) ou o
   * preço (pediram o PIX e não pagaram). Cada um desses tem conserto diferente.
   *
   * Mora no pedido, e não em tabela nova, pelo mesmo motivo de `entregas`:
   * funciona igual no arquivo e no Postgres, e acompanha o pedido para onde
   * ele for. `cliques` conta as aberturas, porque quem volta três vezes na
   * página está decidindo, e isso é sinal diferente de quem abriu e sumiu.
   */
  campanha?: {
    /**
     * Quando a MENSAGEM da promoção saiu de verdade — e-mail disparado ou
     * conversa de WhatsApp aberta com o texto pronto.
     *
     * Até 14/08/2026 este campo era gravado no momento de GERAR O LINK, antes
     * de mensagem nenhuma existir. O painel então mostrava "Promoção enviada"
     * para gente que nunca recebeu nada — e o dono, lendo isso, deixava de
     * abordar quem parecia já abordado. Datas antigas carregam essa ambiguidade;
     * daqui em diante, gerar link grava `linkGeradoEm` e só o envio real grava
     * aqui.
     */
    enviadoEm: string | null;
    /** Quando o link da promoção foi gerado no painel. Gerar não é enviar. */
    linkGeradoEm?: string | null;
    /**
     * A mensagem enviada tinha o desconto de R$ 27,99?
     *
     * Sem este campo o painel rotulava QUALQUER abordagem como "Promoção
     * R$ 27,99" — inclusive a cobrança de preço cheio do WhatsApp, que é o
     * oposto. O dono viu um pedido de 12 minutos "recebendo promoção" e achou,
     * com razão, que a regra das 48 horas tinha sido furada (14/08/2026). Nulo
     * em pedidos antigos, onde não dá mais para saber qual das duas foi.
     */
    comDesconto?: boolean | null;
    visitadoEm: string | null;
    cliques: number;
    cobrancaEm: string | null;
    /** Id do pedido novo gerado pela campanha, quando ela pede o PIX. */
    pedidoGerado: string | null;
  };

  /**
   * O que aconteceu com cada e-mail que este pedido recebeu.
   *
   * `recoveryEmailSentAt` e `accessEmailSentAt` já diziam que a mensagem foi
   * ACEITA pelo provedor — o que não é a mesma coisa que ter chegado, e está a
   * um oceano de ter sido lida. Quando o dono pergunta "a pessoa viu?", só uma
   * das três respostas existia, e era a menos útil.
   *
   * A chave é o rótulo do e-mail (`recuperacao`, `acesso`), porque o mesmo
   * pedido recebe mensagens diferentes e cada uma tem seu próprio destino.
   */
  emails?: Record<string, MarcaDeEmail>;
}

/**
 * O rastro de um e-mail, do envio à leitura.
 *
 * A abertura é medida por uma imagem de 1 pixel no rodapé da mensagem: o
 * cliente de e-mail busca a imagem quando a pessoa abre, e essa busca é o
 * registro. Vale conhecer os dois defeitos do método antes de tomar decisão com
 * o número:
 *
 *  - QUEM BLOQUEIA IMAGEM NÃO É CONTADO. Aparece como "não abriu" mesmo tendo
 *    lido. A abertura, portanto, é piso e nunca teto — abertura de verdade é
 *    sempre igual ou maior que a medida.
 *  - O PROVEDOR CARREGA SOZINHO. Medido nesta operação: o Gmail busca a imagem
 *    de 3 a 7 segundos depois do envio, sem ninguém ter aberto nada. Foi o que
 *    transformou 2 leituras reais em "43% de abertura" no primeiro dia. Por
 *    isso a carga automática é separada da humana (`entregueEm` × `abertoEm`),
 *    e o clique continua sendo o único sinal forte.
 */
export interface MarcaDeEmail {
  /** Quando o provedor aceitou a mensagem. */
  enviadoEm: string;
  /** Id no provedor, para achar a mensagem no painel dele quando algo der errado. */
  provedorId: string | null;
  /**
   * Primeira vez que a imagem foi carregada por QUALQUER um — inclusive pelo
   * servidor de e-mail do destinatário. Vale como prova de entrega: a mensagem
   * chegou a uma caixa que existe, não voltou.
   */
  entregueEm: string | null;
  /**
   * Primeira carga que parece leitura HUMANA. Ver `LEITURA_HUMANA_APOS_MS` em
   * routes/aberturaDeEmail.ts para o critério e a medição que o definiu.
   */
  abertoEm: string | null;
  ultimaAberturaEm: string | null;
  /** Cargas que parecem humanas. Reabrir três vezes é sinal diferente de abrir e sair. */
  aberturas: number;
  /** Todas as cargas, humanas ou não. A diferença para `aberturas` é o robô. */
  cargas: number;
  /** Quem carregou primeiro, em versão curta. Serve para auditar a classificação depois. */
  agente: string | null;
}

export interface ReusableOrderQuery {
  offer: OfferId;
  amountCents: number;
  document: string;
  itemIds: string[];
  /**
   * O método entra na chave de reaproveitamento porque cobrança pendente de PIX
   * NÃO serve para quem acabou de pedir boleto: a pessoa receberia de volta o
   * QR que ela já tinha recusado, e o botão não faria nada visível.
   */
  metodo: MetodoPagamento;
}

export interface StatusPollUsage {
  day: string;
  count: number;
  budget: number;
}

/**
 * Contrato de persistência dos pedidos. Duas implementações:
 * arquivo JSON (desenvolvimento local) e Postgres (produção/serverless).
 */
export interface OrderStore {
  readonly kind: 'file' | 'postgres';
  init(): Promise<void>;
  getOrder(orderId: string): Promise<Order | undefined>;
  getOrderByPaymentId(paymentId: string): Promise<Order | undefined>;
  listChildOrders(parentOrderId: string): Promise<Order[]>;
  /**
   * Pedidos criados a partir de `desde`, do mais novo para o mais antigo.
   * É o que alimenta o painel; o limite existe para uma base grande não
   * estourar a memória da função serverless.
   */
  listOrders(options: { desde?: string; limite: number }): Promise<Order[]>;
  saveOrder(order: Order): Promise<void>;
  findReusableOrder(query: ReusableOrderQuery): Promise<Order | undefined>;
  /** Consome uma unidade do orçamento diário de consultas ao gateway. */
  tryConsumeStatusPoll(): Promise<boolean>;
  getStatusPollUsage(): Promise<StatusPollUsage>;
  /**
   * Registra um evento de webhook. Retorna false quando a chave já existia —
   * é o que garante idempotência mesmo com entregas simultâneas.
   */
  markWebhookProcessed(dedupeKey: string, orderId: string): Promise<boolean>;
}
