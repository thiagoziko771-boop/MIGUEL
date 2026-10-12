/**
 * Avisos de venda no Discord.
 *
 * Único arquivo que conhece o Discord — mesma regra do server/pix.ts com o
 * gateway e do server/meta.ts com o Meta. O resto do sistema chama
 * `avisarVendaAprovada` / `avisarVendaPendente` e não sabe de webhook nenhum.
 *
 * **NADA AQUI PODE DERRUBAR UMA VENDA.** É a mesma disciplina do rastreamento e
 * do e-mail (regra 11 do CLAUDE.md): orçamento de tempo curto, erro engolido, e
 * a cobrança segue igual se o Discord estiver fora do ar. Um aviso perdido é um
 * aviso perdido; um cliente que pagou e não recebeu é outra categoria de
 * problema.
 *
 * O QUE NÃO VAI NA MENSAGEM: o CPF, nunca. Ele existe no pedido porque o
 * gateway exige, não porque seja útil num canal de avisos — e canal de Discord
 * é lido por gente, encaminhado, e fica no histórico para sempre. O telefone vai
 * porque é por ele que se atende quem não pagou.
 */
import { nomeDoRecebedorPix, pspDoPix } from './brcode.js';
import { CATALOG } from './catalog.js';
import { config } from './config.js';
import { lerCustos, repartir } from './custos.js';
import { logger } from './logger.js';
import { repositorioDoPainel } from './painel/repositorio.js';
import type { Order } from './store/index.js';

export const CHAVE_WEBHOOK_APROVADA = 'discord.webhook_aprovada';
export const CHAVE_WEBHOOK_PENDENTE = 'discord.webhook_pendente';

/**
 * Orçamento curto, e menor que o do Meta.
 *
 * O aviso é disparado de dentro do webhook do gateway, que espera resposta em
 * ~10 s e já gastou parte disso confirmando o pagamento. Segurar o callback
 * fazendo o gateway reentregar o mesmo aviso em looping custaria mais do que
 * qualquer notificação vale.
 */
const ORCAMENTO_MS = 2500;

/** Verde para pago, âmbar para esperando. Cor é o que se lê antes do texto. */
const COR_APROVADA = 0x2ecc71;
const COR_PENDENTE = 0xf1c40f;

export interface EnderecosDoDiscord {
  aprovada: string;
  pendente: string;
}

/**
 * Guardado em texto puro em `configuracoes`, e não cifrado.
 *
 * Diferente de um token da API de Conversões: quem tiver esta URL consegue
 * escrever no canal do dono, e nada além disso — não lê venda, não move verba,
 * não gasta dinheiro. Cifrar traria de volta o modo de falha que já custou caro
 * aqui: chave mestra trocada, segredo ilegível, e o recurso desligado em
 * silêncio. Para um aviso, "parou de funcionar sem avisar" é pior que o risco
 * que a cifra evitaria. A URL nunca volta inteira ao navegador, só mascarada.
 */
export async function enderecosDoDiscord(): Promise<EnderecosDoDiscord> {
  try {
    const [aprovada, pendente] = await Promise.all([
      repositorioDoPainel().lerConfiguracao(CHAVE_WEBHOOK_APROVADA),
      repositorioDoPainel().lerConfiguracao(CHAVE_WEBHOOK_PENDENTE),
    ]);
    return {
      aprovada: (aprovada ?? process.env.DISCORD_WEBHOOK_APROVADA ?? '').trim(),
      pendente: (pendente ?? process.env.DISCORD_WEBHOOK_PENDENTE ?? '').trim(),
    };
  } catch (erro) {
    logger.warn('Não consegui ler os endereços do Discord', { erro: (erro as Error).message });
    return { aprovada: '', pendente: '' };
  }
}

/**
 * Só aceita webhook do Discord, e só por HTTPS.
 *
 * Sem isto, um endereço digitado errado no painel viraria uma requisição do
 * nosso servidor para onde quer que aquele texto apontasse — de dentro do fluxo
 * de pagamento, com os dados do cliente no corpo. O campo é preenchido por gente
 * copiando e colando, e colar a coisa errada é o erro mais comum que existe.
 */
export function enderecoValido(url: string): boolean {
  if (url.trim() === '') return true; // vazio = desligado, não é erro
  try {
    const alvo = new URL(url.trim());
    return alvo.protocol === 'https:'
      && (alvo.hostname === 'discord.com' || alvo.hostname === 'discordapp.com')
      && alvo.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

/** A máscara que volta ao navegador: dá para reconhecer, não dá para usar. */
export function mascararEndereco(url: string): string {
  if (!url) return '';
  const partes = url.split('/');
  const id = partes[partes.length - 2] ?? '';
  return id ? `discord.com/api/webhooks/${id}/••••••••` : 'configurado';
}

export async function salvarEnderecos(entrada: { aprovada?: string; pendente?: string }): Promise<void> {
  const gravar = async (chave: string, valor: string | undefined): Promise<void> => {
    if (valor === undefined) return;
    const limpo = valor.trim();
    if (!enderecoValido(limpo)) {
      throw new Error('O endereço precisa ser um webhook do Discord (https://discord.com/api/webhooks/...).');
    }
    await repositorioDoPainel().salvarConfiguracao(chave, limpo);
  };
  await gravar(CHAVE_WEBHOOK_APROVADA, entrada.aprovada);
  await gravar(CHAVE_WEBHOOK_PENDENTE, entrada.pendente);
}

/* ------------------------------------------------------------- a mensagem -- */

function brl(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Nome do produto pelo catálogo. Cai no id quando o item não é de lá. */
function produtoDoPedido(order: Order): string {
  const titulos = order.itemIds.map((id) => CATALOG[id]?.title ?? id);
  return titulos.length > 0 ? titulos.join(' + ') : order.offer;
}

/**
 * De onde veio, do jeito que se lê numa notificação.
 *
 * A BM primeiro, porque com três contas rodando é a primeira pergunta: qual
 * delas trouxe esta venda. Sem carimbo escreve "sem carimbo" em vez de omitir —
 * a ausência é informação, e é ela que denuncia anúncio publicado sem o `bm=`.
 */
function origemDoPedido(order: Order): string {
  const a = order.atribuicao ?? {};
  const bm = (a.bm ?? '').trim();
  const campanha = (a.utm_campaign ?? '').trim();
  const anuncio = (a.utm_content ?? '').trim();

  const linhas = [bm ? `**BM:** ${bm}` : '**BM:** _sem carimbo_'];
  if (campanha) linhas.push(`**Campanha:** ${campanha}`);
  if (anuncio) linhas.push(`**Anúncio:** ${anuncio}`);
  if (!campanha && !anuncio) linhas.push(`**Origem:** ${(a.utm_source ?? '').trim() || 'direto'}`);
  return linhas.join('\n');
}

/** Telefone em formato de clique: é por ele que se atende quem não pagou. */
function whatsapp(telefone: string): string {
  const digitos = (telefone ?? '').replace(/\D/g, '');
  if (digitos.length < 10) return telefone || '—';
  const comPais = digitos.startsWith('55') ? digitos : `55${digitos}`;
  return `[${telefone}](https://wa.me/${comPais})`;
}

/** O nome do gateway como gente escreve, não como a variável guarda. */
const NOME_DO_GATEWAY: Record<string, string> = { pixgo: 'PixGo', syncpay: 'SyncPay', zuckpay: 'ZuckPay' };

/**
 * Quanto sobra desta venda depois da taxa do gateway e do imposto.
 *
 * Passa pelo MESMO `repartir` da aba Resumo, com uma venda só. Recalcular a
 * conta aqui seria a forma mais fácil de o Discord dizer um número e o painel
 * dizer outro — e aí não se acredita em nenhum dos dois.
 */
function linhaDoValor(order: Order, custos: Awaited<ReturnType<typeof lerCustos>>): string {
  const nominal = brl(order.amountCents);
  if (!custos.configurado) return `## ${nominal}`;

  const conta = repartir(
    {
      receitaBrutaCentavos: order.amountCents,
      vendas: 1,
      devolvidoCentavos: 0,
      devolucoes: 0,
      investimentoCentavos: 0,
      despesasCentavos: 0,
    },
    custos,
  );
  const custo = conta.taxasCentavos + conta.impostoSobreVendasCentavos + conta.custosProdutoCentavos;
  return `## ${nominal}\nlíquido ${brl(conta.receitaLiquidaCentavos)} · −${brl(custo)} de taxa e imposto`;
}

function corpoDaMensagem(order: Order, aprovada: boolean, custos: Awaited<ReturnType<typeof lerCustos>>) {
  const tipo = order.parentOrderId === null ? 'Principal' : 'Upsell/Downsell';

  /*
   * Adquirente só aparece quando o gateway informou. A maioria não informa, e um
   * campo fixo dizendo "não informado" em toda venda vira ruído que se aprende a
   * ignorar — e aí deixa de ser lido no dia em que ele importa.
   */
  /*
   * Nominal e adquirente final saem do PRÓPRIO código PIX, não da resposta do
   * gateway.
   *
   * São as duas coisas que o gateway não conta sobre si mesmo, e as duas que
   * decidem se a venda entra: a NOMINAL é o nome que aparece na tela do banco
   * do comprador na hora de confirmar — em 14/08/2026 um cliente desistiu duas
   * vezes porque o banco marcou "PRIME UNION TRADING FIN" como suspeito. O
   * ADQUIRENTE FINAL é quem realmente fala com o Banco Central, e é quem
   * responde num MED ou num chargeback.
   *
   * Lidos a cada aviso, e não guardados: em 20/08/2026 o mesmo funil emitia por
   * `pix.onlyup.com.br` pela SyncPay e passou a emitir por `qrcode.fyhub.com.br`
   * pela ZuckPay. Trocas assim acontecem sem o gateway avisar, e descobrir pelo
   * extrato semanas depois é o jeito caro de aprender.
   */
  const codigoPix = order.qrCode ?? '';
  const nominal = codigoPix ? nomeDoRecebedorPix(codigoPix) : null;
  const psp = codigoPix ? pspDoPix(codigoPix) : null;

  const liquidacao = [
    `**Gateway:** ${NOME_DO_GATEWAY[config.pix.provider] ?? config.pix.provider}`,
    /*
     * As duas linhas abaixo só somem quando o pedido não tem código PIX —
     * boleto, ou pedido antigo. Em PIX elas aparecem SEMPRE, inclusive quando
     * o nome é feio: um nome feio na tela do banco é exatamente a informação
     * que o dono precisa ver, e escondê-lo por ser incômodo seria esconder a
     * causa da venda que não fecha.
     */
    nominal ? `**Nominal no PIX:** \`${nominal}\`` : null,
    psp ? `**Adquirente final:** ${psp.nome} (\`${psp.dominio}\`)` : null,
    order.adquirente ? `**Adquirente informado:** ${order.adquirente}` : null,
    `**Forma:** ${(order.metodo ?? 'pix').toUpperCase()}`,
    order.statusGateway ? `**Status no gateway:** \`${order.statusGateway}\`` : null,
  ].filter(Boolean).join('\n');

  return {
    // `username` e não o nome do webhook: o dono nomeia o canal, não cada aviso.
    embeds: [{
      title: aprovada ? '💰 VENDA APROVADA' : '⏳ PIX GERADO — aguardando pagamento',
      color: aprovada ? COR_APROVADA : COR_PENDENTE,
      description: `${linhaDoValor(order, custos)}\n${produtoDoPedido(order)}`,
      fields: [
        { name: 'Cliente', value: order.customer.name || '—', inline: true },
        { name: 'WhatsApp', value: whatsapp(order.customer.phone), inline: true },
        { name: 'Tipo', value: tipo, inline: true },
        { name: 'De onde veio', value: origemDoPedido(order), inline: false },
        { name: 'Liquidação', value: liquidacao, inline: false },
        { name: 'Pedido', value: `\`${order.id}\``, inline: false },
      ],
      // O Discord mostra a hora no fuso de quem lê, sem a gente converter nada.
      timestamp: new Date().toISOString(),
      footer: { text: aprovada ? 'Pagamento confirmado pelo servidor' : 'Ainda não pagou' },
    }],
  };
}

/* --------------------------------------------------------------- o envio --- */

/**
 * Manda e engole o próprio erro. NUNCA lança.
 *
 * `AbortController` e não só um timeout do fetch: sem abortar de verdade, a
 * requisição continuaria pendurada depois do orçamento e, na Vercel, seguraria
 * a função além do necessário — que é o que a regra 8 do CLAUDE.md existe para
 * evitar.
 */
async function mandar(url: string, corpo: unknown, rotulo: string): Promise<boolean> {
  if (url === '') return false;

  const freio = new AbortController();
  const relogio = setTimeout(() => freio.abort(), ORCAMENTO_MS);
  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: freio.signal,
    });
    if (!resposta.ok) {
      /*
       * 404 aqui quase sempre é webhook apagado no Discord, e não falha de rede.
       * Dizer o status no log é o que separa "o dono apagou o canal" de "o
       * Discord caiu" sem ninguém precisar reproduzir.
       */
      logger.warn('Discord recusou o aviso', { rotulo, status: resposta.status });
      return false;
    }
    return true;
  } catch (erro) {
    logger.warn('Falha ao avisar no Discord', { rotulo, erro: (erro as Error).message });
    return false;
  } finally {
    clearTimeout(relogio);
  }
}

/** Venda confirmada pelo servidor. Chamada do ponto único de mudança de status. */
export async function avisarVendaAprovada(order: Order): Promise<void> {
  try {
    const [{ aprovada }, custos] = await Promise.all([enderecosDoDiscord(), lerCustos()]);
    await mandar(aprovada, corpoDaMensagem(order, true, custos), 'aprovada');
  } catch (erro) {
    logger.warn('Aviso de venda aprovada falhou', { erro: (erro as Error).message });
  }
}

/**
 * PIX gerado, ainda não pago.
 *
 * Só o pedido PRINCIPAL. Upsell e downsell só existem para quem já pagou, e
 * avisar deles encheria o canal de "pendente" que na prática são a mesma
 * pessoa — o canal deixaria de ser lido, que é o único jeito de um aviso falhar
 * de verdade.
 */
export async function avisarVendaPendente(order: Order): Promise<void> {
  if (order.parentOrderId !== null) return;
  if (config.mode === 'mock') return; // cobrança falsa não vira aviso real
  try {
    const [{ pendente }, custos] = await Promise.all([enderecosDoDiscord(), lerCustos()]);
    await mandar(pendente, corpoDaMensagem(order, false, custos), 'pendente');
  } catch (erro) {
    logger.warn('Aviso de PIX pendente falhou', { erro: (erro as Error).message });
  }
}
