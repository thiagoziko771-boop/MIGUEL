import { resolveOffer } from './catalog.js';
import { logger } from './logger.js';
import {
  repositorioDoPainel,
  type PedidoDeBoletoRegistrado,
  type SituacaoDoBoleto,
} from './painel/repositorio.js';
import type { Atribuicao } from './atribuicao.js';
import { ValidationError } from './validation.js';

/**
 * O boleto que ninguém emite por API.
 *
 * Enquanto não há provedor, a opção de boleto do checkout leva a pessoa para o
 * WhatsApp com os dados prontos e ALGUÉM emite à mão, em outro gateway. Todo
 * esse trecho acontece fora do sistema — e é justamente por isso que ele
 * precisa deixar registro aqui: sem isto, a única prova de que houve uma venda
 * é uma conversa no celular do dono.
 *
 * Este arquivo é o dono do ciclo de vida desse pedido: nasce no clique do
 * checkout, e o desfecho é digitado à mão na aba Boletos. Ver
 * `PedidoDeBoletoRegistrado` para por que ele não é um `Order`.
 */

/** Prazo que o Meta aceita para um evento passado. Ver `carimboEmSegundos` em meta.ts. */
const DIAS_QUE_O_META_ACEITA = 7;

export interface EntradaDePedidoDeBoleto {
  nome: string;
  email: string;
  telefone: string | null;
  /** CPF, só dígitos. Já validado por quem chama. */
  documento: string;
  /** Order bumps escolhidos. O preço sai do catálogo, nunca do navegador. */
  bumpIds: string[];
  contribuicaoId: string | null;
  sessao: string | null;
  atribuicao: Atribuicao;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Registra o pedido de boleto.
 *
 * O VALOR É CALCULADO AQUI, pelo catálogo, exatamente como na criação de um
 * PIX. O navegador manda quais itens, nunca quanto custam — senão bastaria
 * abrir o console para pedir um boleto de um real, e o número que o dono usa
 * para decidir orçamento sairia do visitante.
 */
export async function registrarPedidoDeBoleto(
  entrada: EntradaDePedidoDeBoleto,
): Promise<{ pedido: PedidoDeBoletoRegistrado; jaExistia: boolean }> {
  const oferta = resolveOffer('main', entrada.bumpIds, entrada.contribuicaoId);

  return repositorioDoPainel().registrarPedidoDeBoleto({
    sessao: entrada.sessao,
    nome: entrada.nome,
    email: entrada.email,
    telefone: entrada.telefone,
    documento: entrada.documento,
    valorCentavos: oferta.amountCents,
    itemIds: oferta.itemIds,
    atribuicao: entrada.atribuicao,
    ip: entrada.ip,
    userAgent: entrada.userAgent,
  });
}

/**
 * O que cada situação carimba no tempo.
 *
 * As datas são independentes de propósito: um boleto que foi gerado e depois
 * pago guarda as duas, e é a distância entre elas que responde "quanto tempo
 * essa gente demora para pagar" — a pergunta que decide se vale a pena insistir
 * no terceiro dia ou desistir no segundo.
 *
 * Voltar para `pedido` limpa os três carimbos: é o desfazer de quem clicou
 * errado, e deixar a data de pagamento em um pedido que voltou a ser pendente
 * seria pior do que não ter data nenhuma.
 */
function carimbosDaSituacao(
  situacao: SituacaoDoBoleto,
  atual: PedidoDeBoletoRegistrado,
): Pick<PedidoDeBoletoRegistrado, 'geradoEm' | 'pagoEm' | 'naoPagoEm'> {
  const agora = new Date().toISOString();
  if (situacao === 'pedido') return { geradoEm: null, pagoEm: null, naoPagoEm: null };
  if (situacao === 'gerado') return { geradoEm: atual.geradoEm ?? agora, pagoEm: null, naoPagoEm: null };
  if (situacao === 'pago') {
    // Pagou sem ter passado por "gerado"? Passou sim — alguém emitiu o boleto,
    // só não veio marcar. Sem isso o relatório mostraria pagamento sem emissão.
    return { geradoEm: atual.geradoEm ?? agora, pagoEm: atual.pagoEm ?? agora, naoPagoEm: null };
  }
  return { geradoEm: atual.geradoEm, pagoEm: null, naoPagoEm: atual.naoPagoEm ?? agora };
}

export interface ResultadoDaMudanca {
  pedido: PedidoDeBoletoRegistrado;
  /** O que aconteceu com o Meta nesta chamada. `null` quando não havia o que fazer. */
  meta: { enviado: boolean; detalhe: string } | null;
}

/**
 * Move o pedido de boleto para outra situação. É o botão da aba Boletos.
 *
 * Marcar como PAGO registra a conversão no nosso banco. Até 21/08/2026 isso
 * também mandava a compra ao Meta; não manda mais — ver o comentário em
 * `enviarCompraDeBoletoAoMeta`, que virou um no-op explícito.
 */
export async function mudarSituacaoDoBoleto(entrada: {
  id: string;
  situacao: SituacaoDoBoleto;
  observacao?: string | null;
}): Promise<ResultadoDaMudanca | null> {
  const atual = await repositorioDoPainel().obterPedidoDeBoleto(entrada.id);
  if (!atual) return null;

  const atualizado = await repositorioDoPainel().atualizarPedidoDeBoleto(entrada.id, {
    situacao: entrada.situacao,
    ...carimbosDaSituacao(entrada.situacao, atual),
    ...(entrada.observacao === undefined ? {} : { observacao: entrada.observacao }),
  });
  if (!atualizado) return null;

  /*
   * O envio ao Meta acontece só na virada para pago, e só na primeira vez.
   *
   * Remarcar como pago um pedido que já foi enviado não manda de novo: a trava
   * está em `reservarEnvioMeta`, pelo `eventId`, que é determinístico. Sem ela,
   * um duplo clique no painel viraria duas vendas no Gerenciador e o robô
   * passaria a mirar num público que converte metade do que ele acha.
   */
  if (entrada.situacao !== 'pago' || atualizado.metaEnviadoEm) {
    return { pedido: atualizado, meta: null };
  }

  const meta = await enviarCompraDeBoletoAoMeta(atualizado);
  const comMeta = meta.enviado
    ? await repositorioDoPainel().atualizarPedidoDeBoleto(entrada.id, {
        metaEventId: idDoEventoDeBoleto(atualizado),
        metaEnviadoEm: new Date().toISOString(),
      })
    : atualizado;

  return { pedido: comMeta ?? atualizado, meta };
}

/** Determinístico, pelo mesmo motivo do `purchase_<pedido>`: reenviar não pode virar venda nova. */
export function idDoEventoDeBoleto(pedido: PedidoDeBoletoRegistrado): string {
  return `purchase_boleto_${pedido.id}`;
}

/**
 * Manda ao Meta a compra que aconteceu no boleto.
 *
 * É o ponto todo desta tela. Uma venda paga por boleto acontece inteira fora do
 * site: sem este envio, o anúncio que trouxe a pessoa aparece no Gerenciador
 * como se não tivesse vendido nada — e a decisão que se toma olhando um anúncio
 * que "não vende" é desligar o anúncio que estava vendendo.
 *
 * O evento sai com o carimbo do clique (`fbc`), o navegador (`fbp`, IP,
 * User-Agent) e o contato da pessoa, tudo hasheado por server/meta.ts. É o
 * mesmo pacote que uma compra por PIX manda.
 *
 * UM LIMITE QUE NÃO DÁ PARA CONTORNAR: o Meta recusa evento com mais de 7 dias,
 * e server/meta.ts prende o carimbo nessa janela em vez de deixar a recusa
 * acontecer. Boleto marcado como pago DEPOIS de uma semana chega ao Meta com a
 * data do limite, não com a data real — a venda conta, a data não. Marcar no
 * dia em que compensa é o que mantém a atribuição honesta.
 *
 * Nunca lança: um erro aqui não pode impedir o dono de marcar o boleto como
 * pago. O que ficou de fora aparece na tela com o botão de reenviar.
 */
export async function enviarCompraDeBoletoAoMeta(
  _pedido: PedidoDeBoletoRegistrado,
  _opcoes: { reservar?: boolean } = {},
): Promise<{ enviado: boolean; detalhe: string }> {
  /*
   * NO-OP DESDE 21/08/2026. O envio ao Meta saiu do projeto inteiro.
   *
   * A função continua existindo, e devolvendo `enviado: false`, porque a aba
   * Boletos e as duas funções acima leem este resultado para decidir o que
   * escrever na tela. Apagá-la exigiria mexer no fluxo do boleto — que o dono
   * pediu para NÃO alterar — por causa de uma remoção de rastreamento.
   *
   * O `detalhe` fala com o dono, não com o programador: ele vai ver esta frase
   * no painel ao marcar um boleto como pago, e precisa entender que não é erro.
   */
  return {
    enviado: false,
    detalhe: 'O envio automático para o Meta foi removido. A venda está registrada no painel.',
  };
}

/**
 * Reenvia o Purchase de um boleto que já está pago.
 *
 * Existe porque o envio pode falhar por rede, por token vencido ou porque o
 * Meta estava fora do ar, e nesse caso a venda ficaria invisível para sempre —
 * o dono não tem outro caminho para consertar isso sozinho.
 *
 * A reserva de envio é IGNORADA aqui, e o comentário dentro de
 * `enviarCompraDeBoletoAoMeta` explica por quê.
 */
export async function reenviarCompraDeBoleto(id: string): Promise<ResultadoDaMudanca | null> {
  const pedido = await repositorioDoPainel().obterPedidoDeBoleto(id);
  if (!pedido) return null;
  if (pedido.situacao !== 'pago') {
    throw new ValidationError('Só um boleto marcado como pago pode ser enviado ao Meta.', { field: 'situacao' });
  }
  if (pedido.metaEnviadoEm) {
    return { pedido, meta: { enviado: false, detalhe: 'Esta compra já foi enviada ao Meta.' } };
  }

  const meta = await enviarCompraDeBoletoAoMeta(pedido, { reservar: false });
  const atualizado = meta.enviado
    ? await repositorioDoPainel().atualizarPedidoDeBoleto(id, {
        metaEventId: idDoEventoDeBoleto(pedido),
        metaEnviadoEm: new Date().toISOString(),
      })
    : pedido;

  return { pedido: atualizado ?? pedido, meta };
}
