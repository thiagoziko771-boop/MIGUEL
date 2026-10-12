/**
 * Manda UM aviso de teste para cada canal do Discord — pelo caminho real.
 *
 *   DISCORD_WEBHOOK_APROVADA=... DISCORD_WEBHOOK_PENDENTE=... \
 *     npx tsx scripts/avisar-discord-de-teste.mjs
 *
 * Diferente de `testar-discord.mjs`, que sobe um Discord falso e checa 34 casos
 * de lógica, este aqui fala com o Discord DE VERDADE. Ele existe para responder
 * a única pergunta que nenhum dublê responde: a URL cadastrada funciona, o canal
 * existe e a mensagem chega bonita no telefone do dono?
 *
 * NÃO cria pedido, NÃO toca no banco e NÃO gera cobrança. Monta um `Order` na
 * memória e chama `avisarVendaAprovada` / `avisarVendaPendente` — as MESMAS
 * funções que o webhook do gateway chama. É isso que faz o teste valer: se a
 * mensagem sair errada aqui, ela sairia errada na venda.
 *
 * O pedido de teste se identifica como tal em três lugares (nome, id e rodapé
 * do produto). Um aviso verde escrito "VENDA APROVADA" que ninguém consegue
 * distinguir de dinheiro real é pior que aviso nenhum: o dono comemora, procura
 * a venda no painel e não acha.
 */
import { avisarVendaAprovada, avisarVendaPendente, enderecosDoDiscord } from '../server/discord.js';

const agora = new Date().toISOString();
const carimbo = agora.replace(/[-:T]/g, '').slice(0, 14);

/**
 * Um pedido que parece com os de verdade em tudo que a mensagem lê.
 *
 * Os valores não são redondos de propósito (R$ 47,00 + R$ 27,00): um total de
 * R$ 74,00 é o que uma venda com order bump realmente dá, e é assim que se vê
 * se a linha do valor e a lista de produtos estão certas.
 */
const pedidoDeTeste = {
  id: `TESTE-ZUCKPAY-${carimbo}`,
  createdAt: agora,
  updatedAt: agora,
  offer: 'main',
  itemIds: ['main', 'salmos_150'],
  amountCents: 7400,
  status: 'completed',
  customer: {
    name: '⚠️ TESTE — não é venda real',
    email: 'teste@migueltechama.local',
    phone: '11999999999',
    document: '',
  },
  parentOrderId: null,
  paymentId: `zuck_teste_${carimbo}`,
  /*
   * Um BR Code com a MESMA forma do que a ZuckPay devolve hoje, montado campo a
   * campo para os tamanhos baterem. E dele que saem a nominal (campo 59) e o
   * adquirente final (dominio dentro do campo 26) -- sem ele, as duas linhas
   * sumiriam do aviso e o teste nao mostraria justamente o que veio testar.
   */
  qrCode: (() => {
    const campo = (id, valor) => id + String(valor.length).padStart(2, '0') + valor;
    const conta = campo('00', 'br.gov.bcb.pix')
      + campo('25', 'qrcode.fyhub.com.br/qr/v3/at/00000000-0000-4000-8000-000000000000');
    return campo('00', '01') + campo('26', conta) + campo('52', '0000') + campo('53', '986')
      + campo('58', 'BR') + campo('59', 'AXIA_TECNOLOGIA_LTDA') + campo('60', 'SAO_PAULO')
      + campo('62', campo('05', '***')) + '63041234';
  })(),
  qrImageUrl: null,
  expiresAt: null,
  metodo: 'pix',
  paidAt: agora,
  lastStatusCheckAt: null,
  processedWebhooks: [],
  clientIp: null,
  statusGateway: 'PAID',
  /* A ZuckPay não informou adquirente nenhum; o campo só aparece quando vem. */
  adquirente: null,
  atribuicao: {
    bm: 'teste',
    utm_source: 'teste',
    utm_campaign: 'teste-de-webhook',
    utm_content: 'disparo-manual',
  },
};

const enderecos = await enderecosDoDiscord();
console.log('Canais encontrados:');
console.log(`  aprovada: ${enderecos.aprovada ? 'configurada' : 'VAZIA'}`);
console.log(`  pendente: ${enderecos.pendente ? 'configurada' : 'VAZIA'}`);

if (!enderecos.aprovada && !enderecos.pendente) {
  console.error('\nNenhum canal configurado. Passe DISCORD_WEBHOOK_APROVADA e/ou');
  console.error('DISCORD_WEBHOOK_PENDENTE no ambiente, ou cadastre no painel.\n');
  process.exit(1);
}

console.log(`\nPedido de teste: ${pedidoDeTeste.id}\n`);

/*
 * O canal "aprovada" primeiro, e o "pendente" depois com o status trocado — a
 * mesma ordem em que os dois acontecem numa venda de verdade (o PIX nasce
 * pendente e vira pago), para o dono ver os dois cartões um do lado do outro.
 */
await avisarVendaAprovada(pedidoDeTeste);
console.log('  enviado -> canal VENDA APROVADA');

await avisarVendaPendente({
  ...pedidoDeTeste,
  id: `${pedidoDeTeste.id}-P`,
  status: 'pending',
  paidAt: null,
  statusGateway: 'PENDING',
  qrCode: '00020126MOCK-TESTE-NAO-PAGUE',
});
console.log('  enviado -> canal PIX GERADO (pendente)');

/*
 * "Enviado" quer dizer que a função rodou, não que o Discord aceitou: elas
 * engolem o próprio erro de propósito (regra 11 — aviso não derruba venda).
 * Quem confirma de verdade é o canal.
 */
console.log('\nConfira os dois canais. Se algo não chegou, o motivo saiu no log acima.');
