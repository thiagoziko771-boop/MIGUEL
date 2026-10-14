import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { config } from './config.js';
import { logger } from './logger.js';
import { getOrder, saveOrder, type Order } from './store/index.js';

/**
 * O pedido selado: o pedido inteiro, comprimido e cifrado, guardado no
 * navegador de quem comprou. Só entra em uso quando `config.selarPedidos` está
 * ligado — na Vercel sem banco.
 *
 * Por que existe: sem banco, cada instância da função só conhece os pedidos que
 * ela mesma gravou na pasta temporária. O cliente gera o PIX numa instância e a
 * consulta de status seguinte cai em outra, que nunca ouviu falar do pedido. O
 * selo devolve o pedido para essa instância.
 *
 * AES-256-GCM e não só uma assinatura: o pedido leva nome, e-mail, telefone e
 * CPF, e o selo fica no localStorage. O GCM também autentica — um selo alterado
 * no navegador não abre.
 *
 * O status que vem no selo é o que a nossa própria instância gravou depois de
 * consultar o gateway; o navegador não tem como fabricá-lo sem a chave. Ainda
 * assim, um pedido pendente reconstruído aqui volta a ser conferido na ZuckPay
 * pelo `reconcileOrder` de sempre.
 */

const CHAVE = createHash('sha256').update(`selo-do-pedido:${config.seloChave}`).digest();

/** Quantos selos uma requisição pode trazer: pedido principal, upsell, downsell e folga. */
const MAXIMO_DE_SELOS = 6;

export function selarPedido(order: Order): string {
  const iv = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', CHAVE, iv);
  const conteudo = Buffer.concat([cifra.update(deflateRawSync(Buffer.from(JSON.stringify(order), 'utf8'))), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), conteudo]).toString('base64url');
}

export function abrirSelo(selo: string): Order | null {
  try {
    const bruto = Buffer.from(selo, 'base64url');
    if (bruto.length < 29) return null;
    const decifra = createDecipheriv('aes-256-gcm', CHAVE, bruto.subarray(0, 12));
    decifra.setAuthTag(bruto.subarray(12, 28));
    const texto = inflateRawSync(Buffer.concat([decifra.update(bruto.subarray(28)), decifra.final()])).toString('utf8');
    const pedido = JSON.parse(texto) as Order;
    return typeof pedido?.id === 'string' && typeof pedido?.updatedAt === 'string' ? pedido : null;
  } catch {
    return null;
  }
}

/**
 * Recoloca nesta instância os pedidos que o navegador trouxe selados.
 *
 * Só grava quando a instância não conhece o pedido ou conhece uma versão mais
 * velha — a instância que confirmou o pagamento selou o pedido já pago, e uma
 * que ficou com ele pendente precisa aprender isso sem consultar o gateway de
 * novo.
 */
export async function reidratarPedidos(cabecalho: string | undefined): Promise<void> {
  if (!config.selarPedidos || !cabecalho) return;

  const selos = cabecalho.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAXIMO_DE_SELOS);
  for (const selo of selos) {
    const pedido = abrirSelo(selo);
    if (!pedido) continue;
    const local = await getOrder(pedido.id);
    const seloSabeQuePagou = pedido.status === 'completed' && local?.status !== 'completed';
    if (!local || seloSabeQuePagou || Date.parse(pedido.updatedAt) > Date.parse(local.updatedAt)) {
      await saveOrder(pedido);
      if (!local) logger.info('Pedido reconstruído a partir do selo', { orderId: pedido.id, status: pedido.status });
    }
  }
}
