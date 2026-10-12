/**
 * Auditoria do painel e histórico de acessos (aba Acessos, 15/08/2026).
 *
 * Duas coisas que só existiam no log da Vercel — que some em poucos dias e
 * ninguém lê — passam a ficar no banco:
 *
 *  1. QUEM ENTROU no painel (login certo, senha errada, IP bloqueado) e o que
 *     fez depois: toda rota de ESCRITA (POST) do /admin é gravada ao terminar,
 *     com o papel da sessão, o IP, a rota, o alvo (id do pedido, item, etc.) e
 *     o status HTTP. Um middleware só, em vez de uma linha em cada rota — assim
 *     rota nova nasce auditada.
 *
 *  2. QUEM ABRIU a página de entrega ou o link de escolha (o cliente). Isso
 *     responde "ela recebeu?" sem depender do e-mail: se abriu, recebeu.
 *
 * Nada aqui pode derrubar a rota original: gravar auditoria falhando vira log
 * de erro, nunca 500 para quem está usando o painel.
 */

import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.js';
import { repositorioDoPainel } from './painel/repositorio.js';
import { ipDoCliente } from './utils.js';

export type PapelDeAuditoria = 'dono' | 'equipe' | 'anonimo' | 'cliente';

export interface EntradaDeAuditoria {
  papel: PapelDeAuditoria;
  ip: string | null;
  acao: string;
  alvo?: string | null;
  detalhe?: string | null;
  status?: number | null;
}

export async function auditar(entrada: EntradaDeAuditoria): Promise<void> {
  try {
    await repositorioDoPainel().registrarAuditoria({
      papel: entrada.papel,
      ip: entrada.ip,
      acao: entrada.acao,
      alvo: entrada.alvo ?? null,
      detalhe: entrada.detalhe ?? null,
      status: entrada.status ?? null,
    });
  } catch (erro) {
    logger.error('Auditoria: falha ao gravar', { acao: entrada.acao, erro: (erro as Error).message });
  }
}

/**
 * Nome humano de cada rota de escrita do painel. O que não estiver aqui
 * aparece com o caminho cru — feio, mas nunca invisível.
 */
const ROTULO_DA_ROTA: Record<string, string> = {
  'login.ok': 'Entrou no painel',
  'login.senha-errada': 'Senha errada',
  'login.bloqueado': 'Bloqueado por senhas erradas',
  'entrega.aberta': 'Abriu a página de entrega',
  'escolha.aberta': 'Abriu o link de escolha',
  'escolha.pix': 'Gerou PIX pelo link de escolha',
  'POST /admin/pedidos/:id/marcar-pago': 'Marcou pedido como pago',
  'POST /admin/pedidos/:id/cancelar': 'Desfez/cancelou pedido',
  'POST /admin/pedidos/:id/link': 'Gerou link de entrega',
  'POST /admin/pedidos/:id/link-recuperacao': 'Gerou link de recuperação (R$ 27,99)',
  'POST /admin/pedidos/:id/link-escolha': 'Gerou link de escolha (preço cheio)',
  'POST /admin/pedidos/:id/reenviar-entrega': 'Reenviou e-mail de entrega',
  'POST /admin/pedidos/:id/whatsapp': 'Preparou WhatsApp de cobrança',
  'POST /admin/pedidos/:id/whatsapp-entrega': 'Preparou WhatsApp de entrega',
  'POST /admin/pedidos/:id/campanha-enviada': 'Marcou campanha como enviada',
  'POST /admin/verificar-pendentes': 'Reconsultou PIX pendentes',
  'POST /admin/campanha/disparar': 'Disparou campanha de e-mail',
  'POST /admin/entregas/:itemId': 'Alterou link de entrega de produto',
  'POST /admin/entregas/:itemId/testar': 'Testou link de entrega',
  'POST /admin/grupo': 'Alterou convite do grupo',
  'POST /admin/investimento': 'Anotou investimento',
  'POST /admin/investimento/importar': 'Importou investimento da planilha',
  'POST /admin/investimento/planilha': 'Configurou planilha de investimento',
  'POST /admin/anuncios/meta-roas': 'Alterou meta de ROAS',
  'POST /admin/meta/anuncios': 'Salvou credenciais de anúncios do Meta',
  'POST /admin/meta/anuncios/testar': 'Testou credenciais de anúncios',
  'POST /admin/meta/anuncios/importar': 'Importou gasto do Meta',
  'POST /admin/meta/credenciais': 'Alterou credenciais do Pixel/CAPI',
  'POST /admin/meta/testar': 'Testou credencial do Meta',
  'POST /admin/meta/reenviar': 'Reenviou eventos ao Meta',
  'POST /admin/crm/lead/:sessionId/nota': 'Escreveu nota no CRM',
  'POST /admin/crm/lead/:sessionId/marcar': 'Marcou lead no CRM',
};

export function rotuloDaAcao(acao: string): string {
  return ROTULO_DA_ROTA[acao] ?? acao;
}

/**
 * Middleware do adminRouter: grava toda escrita ao terminar a resposta.
 *
 * Só POST: as leituras (GET) são o dono olhando a tela, dezenas por minuto,
 * e gravar cada uma enterraria as ações que importam. O login tem tratamento
 * próprio em autenticar() — chega aqui sem sessão e é ignorado.
 */
export function auditarEscritasDoPainel(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }
  res.on('finish', () => {
    const rota = req.route?.path as string | undefined;
    if (!rota || rota === '/admin/login' || rota === '/leads/login') return;
    const papel = (req.papelSessao as PapelDeAuditoria | undefined) ?? 'anonimo';
    // Sem sessão a rota já foi recusada (401): registrar seria só ruído.
    if (papel === 'anonimo') return;
    const alvo = req.params.id ?? req.params.itemId ?? req.params.sessionId ?? null;
    void auditar({
      papel,
      ip: ipDoCliente(req),
      acao: `POST ${rota}`,
      alvo,
      status: res.statusCode,
    });
  });
  next();
}
