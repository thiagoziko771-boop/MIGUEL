import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { logger } from './../logger.js';
import { aberturaAssinaturaConfere } from './../painel/sessao.js';
import { getOrder, saveOrder } from './../store/index.js';

/**
 * A imagem que diz que o e-mail foi aberto.
 *
 * O dono perguntava "a pessoa viu a mensagem?" e o sistema só sabia responder
 * "o provedor aceitou mandar" — que é o começo da história, não o fim. Entre
 * aceitar e ser lido cabem caixa cheia, filtro de spam, endereço digitado
 * errado e simples desinteresse, e cada um desses pede uma reação diferente:
 * reenviar, ligar no WhatsApp, trocar o assunto ou desistir.
 *
 * COMO FUNCIONA: o rodapé de cada e-mail carrega uma imagem de 1 pixel deste
 * endereço. Quando o cliente de e-mail busca a imagem, a busca é a abertura.
 *
 * TRÊS CUIDADOS QUE ESTÃO NO CÓDIGO ABAIXO:
 *
 *  1. RESPONDE A IMAGEM SEMPRE, aconteça o que acontecer com a contagem. Um
 *     pixel que devolve erro vira um quadradinho quebrado no meio do e-mail de
 *     alguém que está com o pagamento aberto na tela.
 *  2. NUNCA CONFIRMA NEM NEGA que o pedido existe. Mesma imagem, mesmo status,
 *     para assinatura boa e ruim — senão o endereço vira um jeito de descobrir
 *     ids de pedido válidos, um por vez.
 *  3. NÃO É CACHEADO. Sem os cabeçalhos de recusa, o Gmail busca a imagem uma
 *     vez, guarda no proxy dele, e a segunda leitura nunca chega até aqui.
 */
export const aberturaRouter: Router = Router();

/** GIF transparente de 1×1, o menor arquivo de imagem que existe. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Rótulos aceitos. Lista fechada para não deixar o e-mail escrever chave arbitrária no pedido. */
const MARCAS = new Set(['recuperacao', 'acesso', 'campanha']);

/**
 * A partir de quanto tempo uma carga da imagem vira "alguém leu".
 *
 * O NÚMERO SAIU DE MEDIÇÃO, não de palpite. No primeiro dia com o pixel no ar,
 * as cargas se dividiram em dois grupos sem nada no meio:
 *
 *     3s, 7s, 7s, 7s, 16s, 17s   ← todos gmail.com
 *     1213s (20 min), 3257s (54 min)
 *
 * Ninguém abre um e-mail em três segundos. O primeiro grupo é o provedor
 * buscando a imagem para o cache dele no momento da entrega — o Gmail faz isso
 * e é o motivo de a taxa de abertura de qualquer ferramenta de e-mail ser
 * inflada. O segundo grupo é gente.
 *
 * Dois minutos deixa folga larga em cima do maior automático medido (17s) e
 * ainda assim descarta qualquer leitura humana que tenha acontecido nesse
 * intervalo. É de propósito: para decidir se vale mandar mensagem, um número
 * que subestima é útil e um que engana é pior que nenhum.
 *
 * A carga automática não é jogada fora — ela vira `entregueEm`, que responde
 * outra pergunta e é a única prova que temos de que a mensagem chegou a uma
 * caixa viva.
 */
export const LEITURA_HUMANA_APOS_MS = (() => {
  // Configurável só para a bateria não precisar de dois minutos de relógio real
  // por verificação — teste que demora é teste que ninguém roda.
  const pedido = Number.parseInt(process.env.EMAIL_LEITURA_APOS_MS ?? '', 10);
  return Number.isFinite(pedido) && pedido >= 0 ? pedido : 120_000;
})();

/**
 * Varredores que abrem e-mail por segurança, não por interesse.
 *
 * Fora desta lista, de propósito: `GoogleImageProxy`. É por ele que passa toda
 * carga de imagem do Gmail, humana ou não — tratá-lo como robô apagaria a
 * medição inteira, já que praticamente todo cliente desta operação é Gmail.
 * Quem separa o joio ali é o relógio acima.
 */
const VARREDORES = /Barracuda|Proofpoint|Mimecast|Symantec|IronPort|Fortinet|MessageLabs|Bitdefender|SkypeUriPreview|Slackbot|TelegramBot|WhatsApp|bingbot|crawler|spider/i;

function pareceRobo(agente: string, desdeOEnvioMs: number): boolean {
  if (VARREDORES.test(agente)) return true;
  return desdeOEnvioMs < LEITURA_HUMANA_APOS_MS;
}

function responderComPixel(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', String(PIXEL.length));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.end(PIXEL);
}

aberturaRouter.get(
  '/e/:id/:marca/:assinatura',
  asyncHandler(async (req: Request, res: Response) => {
    // A extensão .gif existe só para o cliente de e-mail confiar no endereço.
    const assinatura = String(req.params.assinatura ?? '').replace(/\.gif$/i, '');
    const pedidoId = String(req.params.id ?? '');
    const marca = String(req.params.marca ?? '');

    // A imagem sai primeiro; a contagem é o que pode falhar, e falha calada.
    responderComPixel(res);

    try {
      if (!MARCAS.has(marca)) return;
      if (!aberturaAssinaturaConfere(pedidoId, marca, assinatura)) return;

      const pedido = await getOrder(pedidoId);
      if (!pedido) return;

      const anterior = pedido.emails?.[marca];
      // Sem envio registrado não há o que marcar: seria contar a leitura de uma
      // mensagem que o sistema não sabe ter mandado.
      if (!anterior) return;

      const agora = new Date().toISOString();
      const agente = (req.header('user-agent') ?? '').slice(0, 120);
      const desdeOEnvio = Date.parse(agora) - Date.parse(anterior.enviadoEm);
      const robo = pareceRobo(agente, Number.isFinite(desdeOEnvio) ? desdeOEnvio : 0);

      pedido.emails = {
        ...pedido.emails,
        [marca]: {
          ...anterior,
          // A entrega é a mesma para robô e humano: a imagem foi buscada, logo a
          // mensagem chegou a uma caixa que existe.
          entregueEm: anterior.entregueEm ?? agora,
          cargas: (anterior.cargas ?? 0) + 1,
          agente: anterior.agente ?? agente,
          abertoEm: robo ? (anterior.abertoEm ?? null) : (anterior.abertoEm ?? agora),
          ultimaAberturaEm: robo ? (anterior.ultimaAberturaEm ?? null) : agora,
          aberturas: robo ? (anterior.aberturas ?? 0) : (anterior.aberturas ?? 0) + 1,
        },
      };
      pedido.updatedAt = agora;
      await saveOrder(pedido);

      if (!robo && !anterior.abertoEm) {
        logger.info('E-mail lido', { orderId: pedidoId, marca, segundos: Math.round(desdeOEnvio / 1000) });
      }
    } catch (erro) {
      logger.warn('Falha ao contar a abertura de e-mail', { orderId: pedidoId, marca, erro: (erro as Error).message });
    }
  }),
);
