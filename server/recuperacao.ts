import { enviarEmailDeRecuperacao } from './email.js';
import { logger } from './logger.js';
import { reconcileOrder } from './orders.js';
import { listOrders, saveOrder } from './store/index.js';
import type { Order } from './store/types.js';

/**
 * Chamar de volta quem gerou o PIX e não pagou.
 *
 * O buraco que isto tapa é o maior da operação: de 31 pedidos, 27 ficaram sem
 * pagamento — R$ 1.684,60 — e ninguém falava com essas pessoas. A tela já tinha
 * o convite de retomada (src/components/ConviteDeRetomada.tsx), mas ele só
 * aparece para quem VOLTA sozinho ao site. Quem foi para o aplicativo do banco
 * e se perdeu no caminho não recebia nada de ninguém.
 *
 * TRÊS DECISÕES QUE VIERAM DOS DADOS, não de opinião:
 *
 * 1. QUINZE MINUTOS. Os quatro pagamentos que existem saíram em 4, 4, 14 e 17
 *    minutos depois de o PIX ser gerado. Ninguém pagou depois disso sozinho.
 *    Lembrar antes dos 15 é atropelar quem ainda está com o banco aberto;
 *    lembrar muito depois é falar com uma cobrança que já expirou.
 *
 * 2. O CÓDIGO VENCIDO NÃO IMPEDE O LEMBRETE — mas muda a mensagem. A PixGo dá
 *    20 minutos e apaga a cobrança depois disso. Durante um tempo esta regra
 *    era "só manda enquanto o código vale", e o efeito medido foi o motor rodar
 *    o dia inteiro sem encontrar ninguém: entre os 15 minutos de espera e os 20
 *    de validade sobravam cinco, e nenhum agendador externo é pontual assim.
 *    Hoje quem perdeu o prazo recebe a mesma mensagem com o botão que gera
 *    outro código na hora (ver `montarCorpoDeRecuperacao`), e o que era uma
 *    janela de cinco minutos virou uma de horas.
 *
 * 3. CONFERIR NO GATEWAY ANTES DE MANDAR. O pior erro possível aqui é dizer
 *    "não recebemos seu pagamento" a quem pagou. O webhook da PixGo se perde,
 *    e por isso cada candidato é reconciliado contra o gateway no instante do
 *    envio, e não confiado ao status que estava guardado.
 */

/** Idade mínima do pedido. Ver a decisão 1 no cabeçalho. */
export const MINUTOS_PADRAO = 15;

/**
 * O endereço parece um endereço?
 *
 * `.includes('@')` deixava passar coisas como
 * `mdapazborgescs@gmail.com98988869780` — o telefone colado no fim do e-mail,
 * erro comum de quem digita tudo em um campo só no celular. O provedor aceita a
 * tarefa, o servidor do outro lado devolve "não existe", e cada devolução
 * dessas conta contra a reputação do domínio: bounce demais e as mensagens de
 * quem PAGOU passam a cair na caixa de spam.
 *
 * Deliberadamente frouxa no meio e rígida na ponta: o que interessa é recusar
 * lixo evidente, não decidir quais domínios existem no mundo.
 */
export function emailPlausivel(email: string | null | undefined): boolean {
  const limpo = (email ?? '').trim();
  if (limpo.length < 6 || limpo.length > 254) return false;
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(limpo) && /\.[a-z]{2,}$/i.test(limpo);
}

/**
 * Teto de idade, para o primeiro disparo não virar um blast.
 *
 * Sem ele, a primeira execução em produção varreria todo o histórico e mandaria
 * e-mail de uma vez para dezenas de pessoas que compraram — ou desistiram —
 * semanas atrás. Isso queima domínio em filtro de spam e assusta o cliente.
 */
const TETO_DE_IDADE_MS = 24 * 3_600_000;

/** Envios por execução. A função da Vercel tem 20 s e cada envio fala com duas APIs. */
const MAXIMO_POR_RODADA = 20;

/** Silêncio mínimo entre duas mensagens nossas para a mesma pessoa. */
const DESCANSO_ENTRE_LEMBRETES_MS = 24 * 3_600_000;

export interface ResultadoDaRecuperacao {
  /** Pedidos que passaram por todos os filtros e chegaram ao envio. */
  candidatos: number;
  enviados: number;
  /** Já estavam pagos, descobertos na conferência com o gateway. */
  jaPagos: number;
  falhas: number;
}

/**
 * O pedido merece lembrete? Se não, POR QUÊ?
 *
 * Devolve `null` quando merece, ou o motivo da recusa por extenso. O motivo
 * existe porque este motor já falhou mudo duas vezes: ele responde
 * `candidatos: 0` tanto quando está tudo certo quanto quando um filtro está
 * comendo gente que devia receber — e por fora as duas coisas são idênticas.
 * Em agosto/2026 isso custou dias (a janela dos cinco minutos) e depois uma
 * tarde inteira (um pedido elegível a olho nu, recusado sem explicação). A
 * rota /admin/recuperacao/diagnostico pergunta ao próprio código de produção,
 * que é o único que sabe.
 *
 * `recoveryEmailSentAt` preenchido encerra o assunto para sempre: um lembrete é
 * um favor, dois é insistência, e ninguém compra oração por pressão.
 */
export function motivoDaRecusa(order: Order, agoraMs: number, minutos: number): string | null {
  /*
   * `expired` entra junto com `pending`, e é onde está quase todo o dinheiro.
   *
   * A cobrança da PixGo vive 20 minutos; passado isso o pedido é marcado
   * expirado por aqui mesmo. Recusar esses seria recusar justamente quem o
   * lembrete existe para buscar — a pessoa que gerou o código, foi cuidar da
   * vida e voltou tarde demais.
   *
   * Os outros status ficam de fora e por bons motivos: `completed` já pagou,
   * `refunded` pediu o dinheiro de volta, `cancelled` desistiu de propósito e
   * `failed` nem chegou a ter cobrança.
   */
  if (order.status !== 'pending' && order.status !== 'expired') return 'status ' + order.status;
  if (order.recoveryEmailSentAt) return 'ja recebeu lembrete em ' + order.recoveryEmailSentAt;
  if (!order.qrCode) return 'pedido sem codigo PIX';
  if (!emailPlausivel(order.customer.email)) return 'e-mail implausivel';

  /*
   * Quem já está numa campanha não recebe o lembrete.
   *
   * O lembrete cobra o preço cheio; a campanha de recuperação oferece o preço
   * com desconto. As duas mensagens na mesma caixa de entrada ensinam à pessoa
   * que o preço deste site é negociável — e quem aprende isso espera o desconto
   * na próxima em vez de pagar.
   */
  if (order.campanha?.enviadoEm) return 'ja abordado pela campanha em ' + order.campanha.enviadoEm;

  /*
   * Upsell e downsell abandonados ficam de fora deste lembrete.
   *
   * A mensagem inteira — e a página para onde ela leva — fala da Oração
   * principal: "a sua Oração continua separada no seu nome". Quem abandonou o
   * upsell JÁ TEM a Oração, comprou minutos antes, e receber isso lê como
   * "você não pagou" logo depois de ter pago. Aconteceu com uma cliente que
   * comprou R$ 74 às 23h11 e recebeu às 23h49 a cobrança do upsell de R$ 97
   * como se fosse a compra dela ter falhado.
   *
   * Recuperar upsell abandonado vale dinheiro e é trabalho à parte: precisa de
   * texto próprio, que reconheça a compra que já houve.
   */
  if (order.parentOrderId) return 'upsell/downsell (pedido filho)';

  const idadeMs = agoraMs - Date.parse(order.createdAt);
  if (!Number.isFinite(idadeMs)) return 'createdAt ilegivel: ' + String(order.createdAt);
  if (idadeMs < minutos * 60_000) return 'novo demais: ' + Math.round(idadeMs / 60_000) + ' min (espera ' + minutos + ')';
  if (idadeMs > TETO_DE_IDADE_MS) return 'velho demais: ' + Math.round(idadeMs / 3_600_000) + ' h (teto 24 h)';

  /*
   * O CÓDIGO PODE ESTAR VENCIDO, e mesmo assim o lembrete sai.
   *
   * Esta linha já foi o contrário — só mandava enquanto a cobrança estivesse
   * viva —, e a regra parecia prudente até os números aparecerem: a PixGo dá 20
   * minutos, o lembrete espera 15, e o agendador externo atrasa. A janela real
   * era de cinco minutos, e o motor passou o dia inteiro devolvendo
   * "candidatos: 0" enquanto R$ 1.600 em pedidos abandonados não recebiam
   * mensagem nenhuma.
   *
   * O medo original — mandar código morto e a pessoa levar um "não" do banco —
   * continua válido, e está resolvido no lugar certo: `enviarEmailDeRecuperacao`
   * troca o corpo da mensagem quando o código venceu, oferecendo o botão que
   * gera outro na hora em vez do código que não funciona mais.
   */
  return null;
}

const candidato = (order: Order, agoraMs: number, minutos: number): boolean =>
  motivoDaRecusa(order, agoraMs, minutos) === null;

export async function enviarLembretesDePix(opcoes: { minutos?: number } = {}): Promise<ResultadoDaRecuperacao> {
  const minutos = Number.isFinite(opcoes.minutos) && (opcoes.minutos ?? -1) >= 0
    ? Math.floor(opcoes.minutos as number)
    : MINUTOS_PADRAO;

  const agoraMs = Date.now();
  const desde = new Date(agoraMs - TETO_DE_IDADE_MS).toISOString();
  const pedidos = await listOrders({ desde, limite: 500 });

  /*
   * Uma pessoa, um lembrete — mesmo com vários pedidos abandonados.
   *
   * Quem tenta comprar duas vezes em cinco minutos (troca de adicional,
   * desistência do valor, aplicativo do banco que travou) deixa dois pedidos
   * pendentes para trás. Sem esta passada, os dois viram e-mail: duas mensagens
   * quase iguais na mesma caixa de entrada, com códigos diferentes e valores
   * diferentes, e a pessoa fica sem saber qual é o certo. Fica o mais recente,
   * que é o que reflete a última decisão dela.
   */
  /*
   * Quem já ouviu de nós hoje não ouve de novo — mesmo por outro pedido.
   *
   * A deduplicação abaixo só enxerga uma rodada. Uma pessoa que tenta comprar
   * às 17h, desiste, e tenta de novo às 19h vira dois candidatos em execuções
   * diferentes, e cada uma manda um lembrete: duas mensagens quase iguais, com
   * valores diferentes, para a mesma caixa de entrada. Aconteceu de verdade —
   * uma cliente com três pedidos recebeu duas cobranças em duas horas, e a
   * segunda já é insistência.
   *
   * Vinte e quatro horas contadas do último lembrete, não do último pedido: o
   * que incomoda é a frequência da nossa voz, não a dela.
   */
  const ultimoLembrete = new Map<string, number>();
  for (const order of pedidos) {
    if (!order.recoveryEmailSentAt) continue;
    const chave = (order.customer.email ?? '').trim().toLowerCase();
    const quando = Date.parse(order.recoveryEmailSentAt);
    if (!Number.isFinite(quando)) continue;
    ultimoLembrete.set(chave, Math.max(ultimoLembrete.get(chave) ?? 0, quando));
  }

  const porPessoa = new Map<string, Order[]>();
  for (const order of pedidos) {
    if (!candidato(order, agoraMs, minutos)) continue;
    const chave = order.customer.email.trim().toLowerCase();
    const falouRecentemente = agoraMs - (ultimoLembrete.get(chave) ?? 0) < DESCANSO_ENTRE_LEMBRETES_MS;
    if (falouRecentemente) continue;
    porPessoa.set(chave, [...(porPessoa.get(chave) ?? []), order]);
  }

  for (const lista of porPessoa.values()) {
    lista.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  const fila = [...porPessoa.values()].map((lista) => lista[0] as Order).slice(0, MAXIMO_POR_RODADA);
  const resultado: ResultadoDaRecuperacao = { candidatos: fila.length, enviados: 0, jaPagos: 0, falhas: 0 };

  for (const order of fila) {
    try {
      /*
       * Ver a decisão 3: o status guardado não basta para afirmar que não pagou.
       *
       * A conferência é contra PAGAMENTO, não contra prazo. `expired` volta a
       * ser aceito aqui de propósito — é o estado normal de quem passou dos 20
       * minutos, e foi exatamente esta linha que, quando dizia
       * `!== 'pending'`, engolia em silêncio quase todos os candidatos: eles
       * entravam na fila, a reconciliação carimbava "expirado" e o lembrete
       * morria aqui sem aparecer em nenhum contador.
       */
      const atual = await reconcileOrder(order, { ignorarIntervalo: true });
      if (atual.status !== 'pending' && atual.status !== 'expired') {
        resultado.jaPagos += 1;
        continue;
      }

      const envio = await enviarEmailDeRecuperacao(atual);
      if (!envio.enviado) {
        resultado.falhas += 1;
        logger.warn('Lembrete de PIX não saiu', { orderId: atual.id, motivo: envio.motivo });
        continue;
      }

      /*
       * A marca é gravada DEPOIS do aceite do provedor, e o pedido é relido do
       * `reconcileOrder` para não escrever por cima do que ele atualizou.
       */
      atual.recoveryEmailSentAt = new Date().toISOString();
      atual.updatedAt = new Date().toISOString();
      await saveOrder(atual);
      resultado.enviados += 1;

      /*
       * Os outros pedidos abandonados da MESMA pessoa saem de cena junto.
       *
       * Sem isto a deduplicação acima só adiaria o problema: o pedido preterido
       * continuaria sem carimbo e viraria um segundo e-mail na rodada seguinte,
       * dez minutos depois — que é justamente a insistência que este arquivo
       * inteiro se esforça para evitar.
       */
      const irmaos = (porPessoa.get(atual.customer.email.trim().toLowerCase()) ?? [])
        .filter((outro) => outro.id !== atual.id);
      for (const irmao of irmaos) {
        irmao.recoveryEmailSentAt = atual.recoveryEmailSentAt;
        irmao.updatedAt = atual.updatedAt;
        await saveOrder(irmao);
      }
    } catch (erro) {
      /*
       * Um pedido problemático não pode parar a fila: o próximo da lista pode
       * ser justamente o que ainda dava para salvar.
       */
      resultado.falhas += 1;
      logger.error('Falha ao processar lembrete de PIX', { orderId: order.id, erro: (erro as Error).message });
    }
  }

  return resultado;
}
