import { config } from './config.js';
import { logger } from './logger.js';
import { PixGatewayError, mapStatus } from './pix.js';
import { centsToAmount, newId } from './utils.js';
import type { BoletoEmitido, OrderStatus } from './store/index.js';

/**
 * Emissão de boleto bancário.
 *
 * ESTE ARQUIVO É O ÚNICO PONTO que sabe quem emite o boleto. O resto do sistema
 * conhece duas funções — `criarBoleto` e `consultarStatusBoleto` — exatamente
 * como acontece com o PIX em server/pix.ts. Trocar de provedor, ou escolher o
 * primeiro, é mexer só aqui.
 *
 * Três diferenças em relação ao PIX que mudam o comportamento do funil inteiro,
 * e que não dá para descobrir lendo o código:
 *
 * 1. O BOLETO NÃO CONFIRMA NA HORA. A compensação bancária leva de 1 a 3 dias
 *    úteis, e o cliente que pagou hoje só é liberado depois disso. Todo o
 *    caminho de entrega já depende de `status === 'completed'`, então nada é
 *    liberado antes da hora — mas a tela precisa DIZER isso, ou a pessoa acha
 *    que o site quebrou. Ver src/components/BoletoPanel.tsx.
 * 2. O DOCUMENTO SOBREVIVE À PÁGINA. Um QR expira em minutos e some; um boleto
 *    fica no e-mail e no aplicativo do banco, com o nome do cliente e uma data.
 *    Emitir por engano tem custo (a tarifa é cobrada na emissão, não no
 *    pagamento) e emitir dois para a mesma pessoa é confusão garantida — daí o
 *    reaproveitamento de cobrança pendente levar o método em conta.
 * 3. QUEM EMITE NÃO É A PIXGO. Ela só faz PIX. Em 17/08/2026 a rota de emissão
 *    ainda estava sendo escolhida pelo dono, e é por isso que a implementação
 *    real está marcada abaixo como IMPLEMENTAR AQUI, com a assinatura pronta.
 */

/** Erro de emissão. Estende o do PIX para o tratador do app.ts já saber respondê-lo. */
export class BoletoGatewayError extends PixGatewayError {
  constructor(message: string, options: { status?: number; code?: string; details?: unknown } = {}) {
    super(message, options);
    this.name = 'BoletoGatewayError';
  }
}

export interface CriarBoletoInput {
  amountCents: number;
  description: string;
  /** Nosso id do pedido, para o callback do provedor dizer de quem é o pagamento. */
  externalId: string;
  customer: { name: string; email: string; phone: string; document: string };
  /** Data de vencimento em ISO (só a parte da data importa para o provedor). */
  vencimento: string;
  webhookUrl?: string;
}

export interface BoletoCharge {
  paymentId: string;
  status: OrderStatus;
  statusBruto: string;
  boleto: BoletoEmitido;
}

export interface BoletoPaymentStatus {
  paymentId: string;
  status: OrderStatus;
  statusBruto: string;
  updatedAt: string | null;
}

/**
 * A data de vencimento, a partir de hoje.
 *
 * Conta em dias corridos e não pula fim de semana de propósito: o cliente PAGA
 * no fim de semana pelo aplicativo do banco (a compensação é que só anda no dia
 * útil seguinte). Empurrar a data para a segunda-feira só encurtaria o prazo
 * real de quem decidiu no sábado.
 */
export function calcularVencimento(diasCorridos: number, agora = new Date()): string {
  const data = new Date(agora);
  data.setDate(data.getDate() + Math.max(1, diasCorridos));
  return data.toISOString();
}

/**
 * Formata os 47 dígitos no desenho que o aplicativo do banco mostra.
 *
 * O agrupamento não é enfeite: é ele que permite conferir o número em pedaços,
 * que é como uma pessoa de 60 anos digita boleto no celular. Uma tira de 47
 * dígitos corridos é praticamente impossível de acompanhar sem perder o lugar.
 */
export function formatarLinhaDigitavel(digitos: string): string {
  const d = digitos.replace(/\D/g, '');
  if (d.length !== 47) return digitos;
  return `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d.slice(32, 33)} ${d.slice(33)}`;
}

export async function criarBoleto(input: CriarBoletoInput): Promise<BoletoCharge> {
  if (!config.boleto.disponivel) {
    throw new BoletoGatewayError(
      'O pagamento por boleto ainda não está disponível. Use o PIX — a liberação é imediata.',
      { status: 503, code: 'BOLETO_INDISPONIVEL' },
    );
  }

  if (config.boleto.provider === 'mock') return criarBoletoMock(input);

  /*
   * IMPLEMENTAR AQUI — o provedor de boleto de verdade.
   *
   * Quando a rota estiver escolhida, este é o lugar: uma chamada HTTP que
   * recebe `input` e devolve um `BoletoCharge`. O que o provedor precisa
   * receber, em qualquer API de boleto do mercado:
   *
   *   - valor em centavos ......... input.amountCents
   *   - vencimento ................ input.vencimento (ISO; alguns querem AAAA-MM-DD)
   *   - pagador ................... input.customer (nome, CPF, e-mail; alguns exigem endereço)
   *   - referência externa ........ input.externalId  (volta no webhook, é como achamos o pedido)
   *   - URL de callback ........... input.webhookUrl
   *
   * E o que precisa sair daqui, sob pena de a tela ficar sem o que mostrar:
   *
   *   - paymentId ................. id da cobrança no provedor, para consultar depois
   *   - boleto.linhaDigitavelCrua . 47 dígitos, só números
   *   - boleto.linhaDigitavel ..... use formatarLinhaDigitavel() acima
   *   - boleto.urlPdf ............. quando o provedor devolver; null é aceito
   *   - boleto.vencimento ......... o que o provedor confirmou, não o que pedimos
   *
   * Dois cuidados que o PIX ensinou nesta operação, e que valem em dobro aqui:
   * o status cru do provedor vai para `statusBruto` sem tradução (o painel
   * mostra o original quando o nosso mapeamento perde informação), e o webhook
   * precisa de verificação de assinatura antes de mudar pedido — ver
   * server/routes/webhook.ts.
   */
  throw new BoletoGatewayError(
    `BOLETO_PROVIDER="${config.boleto.provider}" não tem implementação. Ver o bloco IMPLEMENTAR AQUI em server/boleto.ts.`,
    { status: 503, code: 'BOLETO_SEM_PROVEDOR' },
  );
}

export async function consultarStatusBoleto(paymentId: string): Promise<BoletoPaymentStatus> {
  if (config.boleto.provider === 'mock') return consultarStatusBoletoMock(paymentId);

  /*
   * IMPLEMENTAR AQUI — a consulta de status no provedor escolhido.
   *
   * Devolva o status cru do provedor em `statusBruto` e passe-o por `mapStatus`
   * (server/pix.ts) para o nosso. A lista de status de boleto costuma trazer
   * nomes que o mapa ainda não conhece — "registrado", "baixado", "liquidado".
   * O que não estiver mapeado cai em "pendente", que é o lado seguro: não
   * libera produto. Acrescente os que faltarem no STATUS_MAP de lá.
   */
  throw new BoletoGatewayError(
    `BOLETO_PROVIDER="${config.boleto.provider}" não tem implementação de consulta de status.`,
    { status: 503, code: 'BOLETO_SEM_PROVEDOR' },
  );
}

/* -------------------------------------------------------------------------- */
/* Modo mock: emitir e compensar sem banco nenhum                             */
/* -------------------------------------------------------------------------- */

/*
 * O boleto simulado existe pelo mesmo motivo do PIX simulado: é o único jeito
 * de percorrer o funil inteiro sem gerar cobrança. A diferença é que aqui ele
 * também simula o TEMPO — o valor de fábrica confirma em 25 segundos, para dar
 * para ver a tela de espera fazer o seu trabalho antes de virar a de acesso.
 *
 * A linha digitável falsa começa em 000 (código de banco que não existe), então
 * nenhum aplicativo de banco aceita digitá-la. Isso é proposital: um número que
 * FUNCIONASSE poderia acabar pago por engano durante um teste.
 */
const MOCK_CONFIRMA_EM_MS = Number.parseInt(process.env.MOCK_BOLETO_CONFIRM_DELAY_MS ?? '25000', 10);

interface BoletoMock {
  confirmaEm: number;
  venceEm: number;
}

const boletosMock = new Map<string, BoletoMock>();

function criarBoletoMock(input: CriarBoletoInput): BoletoCharge {
  const paymentId = `boleto_mock_${newId(8)}`;
  const agora = Date.now();
  boletosMock.set(paymentId, {
    confirmaEm: agora + MOCK_CONFIRMA_EM_MS,
    venceEm: Date.parse(input.vencimento),
  });

  /*
   * 47 dígitos determinísticos a partir do valor, para o mesmo pedido gerar
   * sempre a mesma linha durante um teste — número que muda a cada renderização
   * atrapalha justamente a conferência que a tela pede ao cliente.
   */
  const centavos = String(input.amountCents).padStart(10, '0');
  const digitos = `00000${'0'.repeat(22)}${centavos}`.slice(0, 33).padEnd(33, '0') + centavos.slice(-14).padStart(14, '0');
  const linhaCrua = digitos.slice(0, 47).padEnd(47, '0');

  logger.warn('MODO MOCK: boleto simulado emitido (NENHUM boleto real foi gerado)', {
    paymentId,
    valor: centsToAmount(input.amountCents),
    confirmaEmSegundos: Math.round(MOCK_CONFIRMA_EM_MS / 1000),
  });

  return {
    paymentId,
    status: 'pending',
    statusBruto: 'mock_registrado',
    boleto: {
      linhaDigitavel: formatarLinhaDigitavel(linhaCrua),
      linhaDigitavelCrua: linhaCrua,
      urlPdf: null,
      vencimento: input.vencimento,
    },
  };
}

function consultarStatusBoletoMock(paymentId: string): BoletoPaymentStatus {
  const registro = boletosMock.get(paymentId);

  /*
   * Boleto que o processo não conhece — reinício do servidor no meio de um
   * teste — continua pendente, e não vira pago. O mock pode ser generoso com o
   * tempo, nunca com a liberação: um mock que confirma o que não conhece
   * ensinaria o sistema a entregar produto por falta de informação.
   */
  if (!registro) {
    return { paymentId, status: 'pending', statusBruto: 'mock_desconhecido', updatedAt: null };
  }

  const agora = Date.now();
  if (agora >= registro.confirmaEm) {
    return { paymentId, status: mapStatus('paid'), statusBruto: 'mock_liquidado', updatedAt: new Date().toISOString() };
  }
  if (agora > registro.venceEm) {
    return { paymentId, status: mapStatus('expired'), statusBruto: 'mock_vencido', updatedAt: new Date().toISOString() };
  }
  return { paymentId, status: 'pending', statusBruto: 'mock_registrado', updatedAt: null };
}
