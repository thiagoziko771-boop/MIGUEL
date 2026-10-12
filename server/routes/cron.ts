import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { logger } from './../logger.js';
import { importarInvestimentoDoMeta, MetaAdsError } from './../metaAnuncios.js';
import { diaLocal } from './../periodo.js';
import { enviarLembretesDePix } from './../recuperacao.js';

export const cronRouter: Router = Router();

/**
 * Tarefas que rodam sozinhas, chamadas pelo agendador da Vercel.
 *
 * Hoje há uma só: trazer do Meta quanto foi gasto em anúncio. Ela existe porque
 * o número que decide onde colocar dinheiro não pode depender de alguém lembrar
 * de digitar — e dependia. Sem gasto anotado, a aba Anúncios mostra faturamento
 * e nunca retorno, o que faz um anúncio no prejuízo parecer um anúncio bom.
 *
 * O horário está no vercel.json: 06:10 UTC, ou seja, 03:10 em Brasília. É depois
 * de o dia fechar no fuso da conta e antes de o dono acordar para olhar o
 * painel.
 */

/**
 * Só o agendador entra.
 *
 * A Vercel manda `Authorization: Bearer <CRON_SECRET>` nas chamadas agendadas.
 * A comparação é em tempo constante porque a alternativa vaza o segredo aos
 * poucos: comparar strings com `===` para no primeiro caractere diferente, e a
 * diferença de tempo entre "errou na primeira letra" e "errou na última" é
 * medível pela rede.
 *
 * SEM `CRON_SECRET` CONFIGURADO A ROTA FICA FECHADA, e não aberta. Um endereço
 * público que dispara chamadas à API do Meta é um jeito barato de alguém
 * queimar o limite de requisições da conta de anúncio do dono.
 */
function autorizado(req: Request): boolean {
  const esperado = (process.env.CRON_SECRET ?? '').trim();
  if (esperado === '') return false;

  const cabecalho = (req.header('Authorization') ?? '').trim();
  const recebido = cabecalho.toLowerCase().startsWith('bearer ') ? cabecalho.slice(7).trim() : '';
  if (recebido === '') return false;

  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  // `timingSafeEqual` exige o mesmo tamanho; o hash iguala os dois lados sem
  // revelar o comprimento do segredo.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

cronRouter.get(
  '/cron/investimento',
  asyncHandler(async (req: Request, res: Response) => {
    if (!autorizado(req)) {
      // 404 e não 401: para quem não tem a chave, esta rota não existe.
      res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Rota não encontrada.' });
      return;
    }

    try {
      /*
       * Sete dias, não um. O Meta revisa números já fechados por até 72 h
       * (clique invalidado, cobrança corrigida), e reimportar a semana faz o
       * painel acompanhar a correção sozinho.
       */
      const resultado = await importarInvestimentoDoMeta({ dias: 7, hoje: diaLocal() });
      logger.info('Cron: investimento do Meta importado', {
        linhas: resultado.linhas.length,
        totalCentavos: resultado.totalCentavos,
      });
      res.json({ success: true, data: { linhas: resultado.linhas.length, totalCentavos: resultado.totalCentavos } });
    } catch (erro) {
      /*
       * Falha aqui é registrada e devolvida como 200.
       *
       * O agendador da Vercel repete o que falha e desativa o que falha sempre.
       * Enquanto o dono não tiver colado o token — que é o estado normal no
       * primeiro dia —, esta rota falharia todo dia por um motivo que não é
       * defeito, e o agendador acabaria desligado justamente antes de ser útil.
       */
      const motivo = erro instanceof MetaAdsError ? erro.codigo : 'ERRO_INESPERADO';
      const mensagem = (erro as Error)?.message ?? 'falha desconhecida';
      logger.warn('Cron: não consegui importar o investimento do Meta', { motivo, mensagem });
      res.json({ success: true, data: { importado: false, motivo, mensagem } });
    }
  }),
);

/**
 * Lembrete de PIX gerado e não pago.
 *
 * A FREQUÊNCIA DO AGENDADOR É PARTE DA FUNCIONALIDADE, e não um detalhe de
 * configuração: a cobrança da PixGo vive poucas dezenas de minutos, então uma
 * chamada por dia encontraria todo mundo já expirado e não recuperaria ninguém.
 *
 * POR ISSO ESTA ROTA NÃO ESTÁ NO `vercel.json`. A conta é do plano Hobby, onde
 * o agendador da Vercel aceita no máximo uma execução diária — e o deploy é
 * recusado com "Hobby accounts are limited to daily cron jobs" se a expressão
 * pedir mais. Quem chama é um agendador externo, a cada 5 ou 10 minutos,
 * mandando `Authorization: Bearer <CRON_SECRET>`. Se um dia a conta virar Pro,
 * basta acrescentar aqui:
 *
 *     { "path": "/api/cron/recuperacao", "schedule": "*\/10 * * * *" }
 *
 * Chamar demais é inofensivo: quem já recebeu fica marcado e não é reconsiderado.
 */
cronRouter.get(
  '/cron/recuperacao',
  asyncHandler(async (req: Request, res: Response) => {
    if (!autorizado(req)) {
      res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Rota não encontrada.' });
      return;
    }

    /*
     * `minutos=0` é aceito de propósito: significa "não espere idade nenhuma".
     * É o que a bateria usa para não precisar de quinze minutos de relógio real,
     * e fica atrás do CRON_SECRET como todo o resto desta rota.
     */
    const pedido = Number.parseInt(String(req.query.minutos ?? ''), 10);
    const minutos = Number.isFinite(pedido) && pedido >= 0 && pedido <= 720 ? pedido : undefined;

    try {
      const resultado = await enviarLembretesDePix({ minutos });
      if (resultado.enviados > 0 || resultado.falhas > 0) {
        logger.info('Cron: lembretes de PIX processados', { ...resultado });
      }
      res.json({ success: true, data: resultado });
    } catch (erro) {
      /*
       * 200 mesmo na falha, pelo mesmo motivo do cron de investimento: o
       * agendador da Vercel desativa o que falha sempre, e uma indisponibilidade
       * do provedor de e-mail derrubaria a recuperação inteira em vez de só
       * atrasá-la em alguns minutos.
       */
      const mensagem = (erro as Error)?.message ?? 'falha desconhecida';
      logger.error('Cron: falha ao enviar lembretes de PIX', { mensagem });
      res.json({ success: true, data: { enviados: 0, erro: mensagem } });
    }
  }),
);
