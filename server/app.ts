import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { credenciaisDoMeta } from './metaCredenciais.js';
import { PixGatewayError } from './pix.js';
import { aberturaRouter } from './routes/aberturaDeEmail.js';
import { adminRouter } from './routes/admin.js';
import { cronRouter } from './routes/cron.js';
import { ordersRouter } from './routes/orders.js';
import { recuperacaoRouter } from './routes/recuperacaoOferta.js';
import { escolherRouter } from './routes/escolherOferta.js';
import { trackRouter } from './routes/track.js';
import { CAMINHOS_DO_CALLBACK, webhookRouter } from './routes/webhook.js';
import { reidratarPedidos } from './selo.js';
import { getStatusPollUsage, storeKind } from './store/index.js';
import { ValidationError } from './validation.js';

/**
 * Monta o app Express. Fica separado do listen porque o mesmo app roda de dois
 * jeitos: processo próprio no desenvolvimento (server/index.ts) e função
 * serverless na Vercel (api/index.ts), onde não existe listen.
 */
export function createApp(): Express {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  if (config.allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.header('Origin');
      if (origin && config.allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        if (req.method === 'OPTIONS') {
          res.sendStatus(204);
          return;
        }
      }
      next();
    });
  }

  // O corpo cru é capturado antes do JSON parser para que uma futura validação
  // de assinatura tenha os bytes originais. Vale para todas as grafias do
  // callback aceitas em routes/webhook.ts.
  app.use(
    CAMINHOS_DO_CALLBACK.map((caminho) => `/api${caminho}`),
    express.raw({ type: '*/*', limit: '256kb' }),
  );
  app.use(express.json({ limit: '64kb' }));

  // Sem banco na Vercel: devolve a esta instância os pedidos que o navegador
  // trouxe selados. Falhar aqui nunca derruba a requisição. Ver server/selo.ts.
  if (config.selarPedidos) {
    app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
      reidratarPedidos(req.header('X-Pedido-Selos'))
        .catch((erro: unknown) => logger.warn('Selo de pedido ignorado', { erro: (erro as Error)?.message }))
        .finally(() => next());
    });
  }

  app.get('/api/health', async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        mode: config.mode,
        storage: storeKind(),
        webhookConfigured: config.publicBaseUrl.startsWith('https://'),
        /*
         * Qual gateway está atendendo AGORA.
         *
         * Existe por causa da troca de 20/08/2026: as credenciais vivem em
         * variável de ambiente, e variável de ambiente só vale a partir do
         * deploy seguinte. Sem este campo, "a chave virou?" era pergunta que só
         * a primeira cobrança real respondia — e a primeira cobrança real é
         * dinheiro de um cliente. O nome do gateway não é segredo: ele aparece
         * no extrato de quem paga.
         */
        gateway: config.pix.provider,
        statusPolls: await getStatusPollUsage(),
        /*
         * O ID do Pixel é público — ele vai no HTML do funil de qualquer jeito.
         * Aparece aqui porque a /obg é um arquivo estático, fora do build do
         * Vite, e precisa descobrir o número em tempo de execução. O token da
         * API de Conversões, esse sim segredo, nunca sai do servidor.
         */
        meta: await (async () => {
          const credenciais = await credenciaisDoMeta();
          return { pixelId: credenciais.pixelId, capiAtiva: credenciais.ligado };
        })(),
        /*
         * O e-mail está de pé?
         *
         * Existe por causa de dois dias perdidos em agosto de 2026. A
         * recuperação de PIX rodava de hora em hora e respondia `enviados: 0`,
         * sem erro nenhum — porque sem `EMAIL_API_KEY` o envio devolve um
         * motivo e segue em frente, de propósito: e-mail não pode custar uma
         * venda. O efeito colateral é que a falha fica MUDA, e um motor parado
         * parece um motor saudável num dia sem PIX abandonado.
         *
         * Só o booleano e o remetente, nunca a chave. O remetente é de domínio
         * próprio e já viaja em todo e-mail enviado; junto do booleano, responde
         * "por que ninguém recebeu nada" — quase sempre é chave ausente ou
         * remetente de domínio não verificado, que o Resend aceita e manda
         * direto para spam. O `EMAIL_RESPONDER_PARA` fica de fora de propósito:
         * é o endereço pessoal do dono, e esta rota é pública — bot de spam
         * colhe /api/health como colhe qualquer coisa.
         */
        email: {
          configurado: config.email.apiKey !== '',
          remetente: config.email.remetente,
        },
      },
    });
  });

  app.use('/api', webhookRouter);
  app.use('/api', ordersRouter);
  app.use('/api', trackRouter);
  app.use('/api', adminRouter);
  app.use('/api', cronRouter);
  app.use('/api', recuperacaoRouter);
  app.use('/api', escolherRouter);
  app.use('/api', aberturaRouter);

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Rota não encontrada.' });
  });

  if (config.serveStatic) {
    const distPath = path.resolve(process.cwd(), 'dist');
    /*
     * `extensions: ['html']` reproduz localmente os rewrites do vercel.json:
     * /obg serve obg.html, /admin serve admin.html.
     *
     * Sem isso, /obg caía no catch-all abaixo e devolvia o FUNIL — a página
     * errada, com status 200. Em produção nunca aconteceu, porque lá quem
     * resolve é o rewrite da Vercel; o estrago era outro e mais silencioso:
     * a bateria scripts/testar-pagina-obrigado.mjs não tinha como passar
     * localmente, e é ela que garante que o cliente recebe os acessos depois
     * de pagar. Divergência entre local e produção não custa um defeito: custa
     * o teste que pegaria o defeito.
     */
    app.use(express.static(distPath, { index: false, extensions: ['html'] }));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      res.status(error.status).json({
        success: false,
        error: error.code,
        message: error.message,
        field: error.field,
      });
      return;
    }

    if (error instanceof PixGatewayError) {
      // Serve aos dois gateways: BoletoGatewayError estende este.
      logger.error('Erro do gateway de pagamento', { code: error.code, message: error.message, details: error.details });
      res.status(error.status).json({
        success: false,
        error: error.code,
        message: error.message,
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ success: false, error: 'INVALID_JSON', message: 'Corpo da requisição inválido.' });
      return;
    }

    logger.error('Erro não tratado', {
      method: req.method,
      path: req.path,
      error: (error as Error)?.message,
      stack: (error as Error)?.stack,
    });
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor. Tente novamente em instantes.',
    });
  });

  return app;
}
