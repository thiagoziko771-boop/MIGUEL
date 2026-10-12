/**
 * O lembrete de WhatsApp para PIX que não foi pago.
 *
 * NÃO COBRA NADA. Não cria pagamento, não gera link de recuperação, não toca no
 * status do pedido e não aplica desconto. A única coisa que sai daqui é um
 * endereço `wa.me` com uma mensagem pronta — quem envia é o dono, pelo aplicativo
 * dele, e quem decide pagar continua sendo o cliente.
 *
 * POR QUE ISTO EXISTE SEPARADO de `POST /admin/pedidos/:id/whatsapp`, que já
 * abria conversa: aquele gera um link de recuperação ASSINADO, com preço menor
 * (R$ 27,99 depois de algumas horas) e prazo. É outra coisa — é uma oferta nova.
 * Misturar os dois no mesmo botão faria o dono dar desconto sem querer, todo dia,
 * para gente que ainda pagaria o preço cheio.
 *
 * Medido em 19/08/2026: 20 dos 125 pedidos (16%) não têm telefone, e 18 desses
 * nunca pagaram. Para eles não há lembrete possível — e é por isso que a rota
 * responde com o motivo em vez de abrir uma janela vazia.
 */
import type { Order } from './store/index.js';

/** Quantos lembretes já foram para este pedido, contados dos eventos gravados. */
export const EVENTO_LEMBRETE = 'whatsapp_reminder_sent';

/**
 * O primeiro nome, como gente cumprimenta.
 *
 * "Olá, Maria Anunciata Rosa de Souza 🙏" soa com cadastro; "Olá, Maria 🙏" soa
 * com pessoa. E é uma mensagem que pede resposta — o tom decide se ela vem.
 */
export function primeiroNome(nomeCompleto: string): string {
  const limpo = (nomeCompleto ?? '').trim().replace(/\s+/g, ' ');
  if (limpo === '') return '';
  const primeiro = limpo.split(' ')[0];
  // ALEXSANDRO vira Alexsandro: nome gritado numa saudação afasta.
  if (primeiro === primeiro.toUpperCase() && primeiro.length > 2) {
    return primeiro.charAt(0) + primeiro.slice(1).toLowerCase();
  }
  return primeiro;
}

/**
 * O número como o WhatsApp entende: só dígitos, com o 55 na frente.
 *
 * Devolve `null` quando não dá para chamar, em vez de montar um endereço que
 * abriria uma janela vazia no celular do dono — que é pior do que não ter botão,
 * porque parece que funcionou.
 */
export function numeroParaWhatsapp(telefone: string | null | undefined): string | null {
  const digitos = (telefone ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (digitos.length < 10 || digitos.length > 11) return null;
  return `55${digitos}`;
}

/**
 * A mensagem do lembrete.
 *
 * O texto é o que o dono escreveu, com o nome trocado. Não é gerado nem variado
 * pelo código: quem escolhe as palavras que falam com este público é ele, e
 * "melhorar" a copy por conta própria aqui seria trocar um texto testado por um
 * palpite. A única costura é a saudação — sem nome, ela vira "Olá 🙏❤️" em vez
 * de "Olá, 🙏❤️" com a vírgula solta.
 */
export function mensagemDeLembrete(order: Order): string {
  const nome = primeiroNome(order.customer.name);
  const saudacao = nome ? `Olá, ${nome} 🙏❤️` : 'Olá 🙏❤️';

  return [
    saudacao,
    '',
    'Passando com muito carinho para te avisar que a sua oração foi registrada e guardada em seu nome, junto com a sua intenção. Ela está aqui reservada, esperando apenas a confirmação da sua contribuição para que possamos concluir tudo.',
    '',
    'Vi que você chegou a gerar o Pix, mas a contribuição ainda não foi concluída. Às vezes acontece de o pagamento dar algum erro, expirar ou simplesmente não finalizar — por isso estou te chamando pessoalmente para que, se aconteceu qualquer dificuldade, eu possa te ajudar a resolver. 🙏',
    '',
    'Você já deu o passo de confiar e colocar seu pedido em oração. Agora falta apenas concluir essa última etapa para que possamos finalizar sua solicitação e manter tudo certinho em seu nome.',
    '',
    'Quando puder, me responda por aqui. Estou acompanhando pessoalmente para te ajudar. ❤️🙏',
    '',
    'Que essa oração leve paz ao seu coração e que Deus e o Anjo estejam cuidando da sua caminhada.',
  ].join('\n');
}

/**
 * O endereço do WhatsApp, com a mensagem codificada.
 *
 * `encodeURIComponent` e não `URLSearchParams`: o segundo troca espaço por `+`,
 * e o WhatsApp mostra os `+` literais no meio do texto. Com acento, emoji e
 * quebra de linha na mensagem, é a diferença entre uma conversa que abre pronta
 * e uma que o dono tem de reescrever à mão.
 */
export function linkDoLembrete(order: Order): { url: string; numero: string } | { erro: string } {
  const numero = numeroParaWhatsapp(order.customer.phone);
  if (!numero) {
    return {
      erro: `Este pedido não tem telefone válido para chamar${order.customer.phone ? `: "${order.customer.phone}"` : '.'}`,
    };
  }
  return {
    numero,
    url: `https://wa.me/${numero}?text=${encodeURIComponent(mensagemDeLembrete(order))}`,
  };
}

/**
 * Se cabe lembrete neste pedido.
 *
 * Só para quem gerou PIX e não pagou. Pago não se cobra; e sem cobrança gerada
 * não há "você chegou a gerar o Pix" para dizer — a mensagem inteira parte
 * dessa premissa, e mandá-la para quem nunca gerou seria mentira na primeira
 * linha.
 */
export function cabeLembrete(order: Order): boolean {
  if (order.status === 'completed' || order.status === 'refunded') return false;
  return Boolean(order.qrCode || order.paymentId);
}
