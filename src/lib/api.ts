import type { Attribution } from './attribution';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

export type OfferId = 'main' | 'upsell' | 'downsell';
export type OrderStatus = 'pending' | 'completed' | 'expired' | 'cancelled' | 'refunded' | 'failed';
export type MetodoPagamento = 'pix' | 'boleto';

/** O boleto emitido, como a tela precisa dele. Ver server/boleto.ts. */
export interface BoletoDoPedido {
  /** Já com pontos e espaços, para conferir em pedaços. */
  linhaDigitavel: string;
  /** Só dígitos — é isto que o botão copia, porque é isto que o banco aceita colado. */
  linhaDigitavelCrua: string;
  urlPdf: string | null;
  vencimento: string;
}

export interface OrderItem {
  id: string;
  title: string;
  amount: number;
  amountFormatted: string;
}

export interface Order {
  id: string;
  offer: OfferId;
  status: OrderStatus;
  amount: number;
  amountFormatted: string;
  items: OrderItem[];
  /** Decide qual painel a tela mostra: o do QR ou o da linha digitável. */
  metodo: MetodoPagamento;
  pix: { code: string; imageUrl: string | null; expiresAt: string | null; recebedor?: string | null } | null;
  boleto: BoletoDoPedido | null;
  paidAt: string | null;
  parentOrderId: string | null;
  customer: { name: string; email: string; documentMasked: string };
  createdAt: string;
  /**
   * Identificador do evento de compra que o servidor já enviou ao Meta. Só vem
   * preenchido depois do pagamento confirmado.
   *
   * A /obg dispara o Purchase do Pixel com este mesmo identificador — é assim
   * que o Meta entende que os dois eventos são a mesma venda. Sem ele a página
   * não dispara nada.
   */
  purchaseEventId: string | null;
  /** O pedido cifrado pelo servidor. Só vem quando o site roda sem banco. */
  selo?: string;
}

export interface DeliverableContent {
  itemId: string;
  title: string;
  description: string;
  url: string | null;
}

export interface AccessBundle {
  released: boolean;
  orderId: string;
  contents: DeliverableContent[];
  pendingOrders: { id: string; offer: OfferId; status: OrderStatus; amountFormatted: string }[];
}

export interface CustomerInput {
  name: string;
  email: string;
  phone: string;
  document: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; field?: string; status?: number } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? 'UNKNOWN_ERROR';
    this.field = options.field;
    this.status = options.status ?? 0;
  }
}

/*
 * OS PEDIDOS SELADOS.
 *
 * Quando o site roda sem banco, o servidor devolve cada pedido também cifrado
 * (`selo`). Guardamos aqui e mandamos de volta em toda chamada: é o que deixa
 * a instância seguinte do servidor reconhecer o PIX que outra gerou. Com banco
 * o campo nunca vem, e nada disto é enviado. Ver server/selo.ts.
 *
 * A mesma chave é lida pela /obg (public/obg.html).
 */
const CHAVE_DOS_SELOS = 'rezas_sagradas.selos';
const MAXIMO_DE_SELOS = 4;

function lerSelos(): [string, string][] {
  try {
    const salvos = JSON.parse(window.localStorage.getItem(CHAVE_DOS_SELOS) ?? '[]');
    return Array.isArray(salvos) ? salvos.filter((par) => Array.isArray(par) && par.length === 2) : [];
  } catch {
    return [];
  }
}

function guardarSelo(id: string, selo: string): void {
  try {
    const outros = lerSelos().filter(([existente]) => existente !== id);
    const selos = [...outros, [id, selo]].slice(-MAXIMO_DE_SELOS);
    window.localStorage.setItem(CHAVE_DOS_SELOS, JSON.stringify(selos));
  } catch {
    // Sem storage o selo vale só para esta carga da página.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const selos = lerSelos().map(([, selo]) => selo).join(',');
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(selos ? { 'X-Pedido-Selos': selos } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.', {
      code: 'NETWORK_ERROR',
    });
  }

  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError('O servidor devolveu uma resposta inesperada.', {
        code: 'INVALID_RESPONSE',
        status: response.status,
      });
    }
  }

  if (!response.ok || body?.success !== true) {
    throw new ApiError(body?.message ?? 'Não foi possível concluir a operação.', {
      code: body?.error,
      field: body?.field,
      status: response.status,
    });
  }

  if (typeof body.data?.selo === 'string' && typeof body.data?.id === 'string') {
    guardarSelo(body.data.id, body.data.selo);
  }

  return body.data as T;
}

/** O que o checkout pode oferecer hoje. Vem do servidor: ver GET /api/pagamento/opcoes. */
export interface OpcoesDePagamento {
  pix: { disponivel: boolean };
  boleto: {
    /** Há emissão automática de boleto? */
    disponivel: boolean;
    minimo: number;
    diasParaVencer: number;
    /** Não havendo emissão, a opção abre uma conversa no WhatsApp. */
    peloWhatsapp: boolean;
  };
  /** Número de atendimento (país + DDD, só dígitos). Vazio quando não configurado. */
  whatsapp: string;
}

export const api = {
  /**
   * Formas de pagamento disponíveis.
   *
   * Perguntado ao servidor a cada visita porque a resposta depende de variável
   * de ambiente: embutir no build faria ligar o boleto exigir recompilação, e
   * um botão adiantado apontaria para uma emissão que ainda não existe.
   */
  opcoesDePagamento(): Promise<OpcoesDePagamento> {
    return request<OpcoesDePagamento>('/pagamento/opcoes');
  },

  createOrder(payload: {
    offer: OfferId;
    bumps?: string[];
    /** Ausente = PIX. O servidor recusa boleto quando não há provedor de emissão. */
    metodo?: MetodoPagamento;
    /**
     * Id do acréscimo voluntário (`semente_10`, `semente_25`, `semente_50`).
     *
     * Vai o ID, nunca o valor: o preço de cada um está no catálogo do servidor,
     * que é o único lugar onde ele pode estar sem virar campo editável pelo
     * navegador.
     */
    contribuicao?: string | null;
    customer?: CustomerInput;
    parentOrderId?: string | null;
    /** Carimbo do anúncio. O servidor limpa e guarda junto do pedido. */
    attrib?: Attribution;
    session_id?: string;
  }): Promise<Order> {
    return request<Order>('/orders', { method: 'POST', body: JSON.stringify(payload) });
  },

  /**
   * Registra o pedido de boleto que vai ser emitido à mão.
   *
   * Chamado no mesmo clique que abre o WhatsApp. Nenhuma cobrança nasce daqui —
   * o que nasce é a linha na aba Boletos do painel, com contato, CPF, valor e o
   * anúncio de onde a pessoa veio. Sem ela, quem não tocar em enviar na
   * conversa some sem deixar rastro.
   *
   * O valor NÃO viaja: vão os itens, e o servidor soma pelo catálogo.
   */
  pedirBoleto(payload: {
    customer: CustomerInput;
    bumps?: string[];
    contribuicao?: string | null;
    attrib?: Attribution;
    session_id?: string;
  }): Promise<{ id: string; valorCentavos: number }> {
    return request<{ id: string; valorCentavos: number }>('/boletos/pedido', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getOrder(orderId: string): Promise<Order> {
    return request<Order>(`/orders/${orderId}`);
  },

  getAccess(orderId: string): Promise<AccessBundle> {
    return request<AccessBundle>(`/orders/${orderId}/access`);
  },
};
