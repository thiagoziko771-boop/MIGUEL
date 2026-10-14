/**
 * Ponto de entrada da Vercel: expõe o mesmo app Express como função serverless.
 *
 * Diferenças em relação ao server/index.ts:
 *   • não há listen — a Vercel invoca o handler por requisição;
 *   • não há disco: os pedidos precisam do Postgres (DATABASE_URL).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';
import { config, getConfigIssues } from '../server/config.js';
import { logger } from '../server/logger.js';
import { initStore } from '../server/store/index.js';

const { fatalErrors } = getConfigIssues();
for (const message of fatalErrors) logger.error(`Configuração inválida: ${message}`);

/**
 * Sem Postgres, o armazenamento cairia no arquivo local — que aqui é efêmero e
 * não é compartilhado entre invocações. O pedido criado numa instância sumiria
 * antes do webhook chegar em outra: o cliente pagaria e nunca receberia o
 * produto. Preferimos recusar de forma visível a aceitar dinheiro e perder o
 * pedido.
 */
/*
 * Até 14/10/2026 a falta de banco fechava a API inteira com 503. O dono pediu
 * o PIX funcionando sem banco, e o risco descrito acima passou a ser coberto
 * pelo selo: o pedido viaja cifrado no navegador e qualquer instância o
 * reconstrói (config.selarPedidos, server/selo.ts). O que continua sem banco:
 * painel /admin sem histórico, e quem paga depois de fechar a página não tem
 * a tela de volta sozinha.
 */
if (!config.databaseUrl) {
  logger.warn('DATABASE_URL ausente: pedidos em arquivo temporário, mantidos entre instâncias pelo selo.');
}

const app = createApp();

/**
 * "fetch failed" do driver da Neon não diz nada sozinho: a razão real (DNS,
 * TLS, recusa de conexão) fica na cadeia de `cause`. Sem desdobrar, todo
 * problema de banco vira a mesma mensagem opaca no log.
 */
function detalharErro(error: unknown): string {
  const partes: string[] = [];
  let atual: unknown = error;
  for (let nivel = 0; nivel < 4 && atual; nivel += 1) {
    const erro = atual as Error & { code?: string };
    partes.push(`${erro.name ?? 'Error'}: ${erro.message ?? erro}${erro.code ? ` (${erro.code})` : ''}`);
    atual = (erro as { cause?: unknown }).cause;
  }
  return partes.join(' <- ');
}

/** Identidade do banco sem expor credencial, só para conferir a variável. */
function bancoResumido(): string {
  try {
    const url = new URL(config.databaseUrl);
    return `${url.protocol}//${url.hostname}${url.pathname} pooled=${url.hostname.includes('-pooler')}`;
  } catch {
    return `valor nao e uma URL valida (tamanho ${config.databaseUrl.length})`;
  }
}

/** Espera entre tentativas de conexão, em ms. O Neon hiberna e leva um instante para acordar. */
const ESPERAS_DE_RETENTATIVA = [300, 900];

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

/**
 * A preparação NÃO pode ser um valor fixo do módulo. O banco hiberna quando
 * fica ocioso, então a primeira conexão de uma instância nova pode falhar
 * enquanto ele acorda. Guardar essa falha para sempre envenenaria a instância:
 * ela responderia 503 a todo mundo até a Vercel recicla-la, e cada cliente que
 * caísse nela perderia a compra.
 *
 * Aqui a promessa é descartada quando falha, então a requisição seguinte tenta
 * de novo. E dentro da mesma requisição ainda insistimos algumas vezes, que é
 * o que cobre a janela de despertar do banco sem o cliente ver erro nenhum.
 */
let preparacao: Promise<void> | null = null;

function prepararArmazenamento(): Promise<void> {
  if (preparacao) return preparacao;

  preparacao = (async () => {
    for (let tentativa = 0; ; tentativa += 1) {
      try {
        await initStore();
        return;
      } catch (error) {
        if (tentativa >= ESPERAS_DE_RETENTATIVA.length) {
          logger.error('Falha ao preparar o armazenamento', {
            error: (error as Error)?.message ?? 'erro desconhecido',
            cadeia: detalharErro(error),
            banco: bancoResumido(),
            tentativas: tentativa + 1,
          });
          throw error;
        }
        logger.warn('Banco não respondeu; tentando de novo', { tentativa: tentativa + 1 });
        await esperar(ESPERAS_DE_RETENTATIVA[tentativa]);
      }
    }
  })().catch((error: unknown) => {
    // Descarta a tentativa falha para a próxima requisição começar do zero.
    preparacao = null;
    throw error;
  });

  return preparacao;
}

function refuse(res: ServerResponse, status: number, error: string, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: false, error, message }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await prepararArmazenamento();
  } catch {
    refuse(res, 503, 'STORAGE_UNAVAILABLE', 'Serviço indisponível no momento. Tente novamente em instantes.');
    return;
  }

  app(req as never, res as never);
}
