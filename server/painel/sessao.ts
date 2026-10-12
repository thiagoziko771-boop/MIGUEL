import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export type Papel = 'dono' | 'equipe';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      papelSessao?: Papel;
    }
  }
}

/**
 * Sessão sem estado: o token carrega a própria validade e a assinatura.
 * É o que funciona em serverless, onde não há memória compartilhada entre
 * invocações e uma tabela de sessão custaria uma ida ao banco por requisição.
 *
 * token = "<expiraEmMs>.<HMAC-SHA256(expiraEmMs, segredoDoPapel)>"
 *
 * O segredo de cada papel deriva da senha daquele papel, então trocar a
 * ADMIN_SENHA derruba só as sessões do dono, e um token de equipe nunca
 * valida como dono.
 */
function segredoDoPapel(papel: Papel): string | null {
  const senha = papel === 'dono' ? config.painel.adminSenha : config.painel.leadsSenha;
  if (!senha || !config.painel.chaveMestra) return null;
  const rotulo = papel === 'dono' ? 'sessao-admin:' : 'sessao-leads:';
  return crypto.createHmac('sha256', config.painel.chaveMestra).update(`${rotulo}${senha}`).digest('hex');
}

/**
 * Compara em tempo constante, sem vazar o tamanho: o SHA-256 dos dois lados
 * tem sempre 32 bytes, então timingSafeEqual nunca estoura por comprimento.
 */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export function criarToken(papel: Papel): string {
  const segredo = segredoDoPapel(papel);
  if (!segredo) throw new Error(`Painel sem senha ou sem chave mestra para o papel "${papel}".`);

  const expiraEm = Date.now() + config.painel.horasSessao * 3_600_000;
  const assinatura = crypto.createHmac('sha256', segredo).update(String(expiraEm)).digest('hex');
  return `${expiraEm}.${assinatura}`;
}

export function tokenValido(token: string, papel: Papel): boolean {
  const segredo = segredoDoPapel(papel);
  if (!segredo) return false;

  const separador = token.indexOf('.');
  if (separador <= 0) return false;

  const expiraEm = Number.parseInt(token.slice(0, separador), 10);
  if (!Number.isFinite(expiraEm) || expiraEm <= Date.now()) return false;

  const esperada = crypto.createHmac('sha256', segredo).update(String(expiraEm)).digest('hex');
  return iguaisEmTempoConstante(esperada, token.slice(separador + 1));
}

/** Papel do token apresentado, ou null. Dono primeiro: ele abre as duas telas. */
export function papelDoToken(token: string | undefined): Papel | null {
  if (!token) return null;
  if (tokenValido(token, 'dono')) return 'dono';
  if (tokenValido(token, 'equipe')) return 'equipe';
  return null;
}

export function senhaConfere(senhaEnviada: string, papel: Papel): boolean {
  const esperada = papel === 'dono' ? config.painel.adminSenha : config.painel.leadsSenha;
  if (!esperada) return false;
  return iguaisEmTempoConstante(esperada, senhaEnviada);
}

/* -------------------------------------------------------------------------- */
/* IP real do cliente                                                          */
/* -------------------------------------------------------------------------- */

/*
 * `ipDoCliente` mudou de casa para server/utils.ts.
 *
 * Ela nasceu aqui porque o primeiro uso foi o bloqueio de senha do painel, mas
 * quem mais precisa dela são as rotas PÚBLICAS: o IP é metade da identificação
 * que o Meta usa para casar o evento com a pessoa. Deixá-la dentro do módulo de
 * sessão do painel foi o que fez /api/track e /api/orders usarem `req.ip` cru
 * durante meses, mandando ao Facebook o IP do proxy da Vercel.
 */
export { ipDoCliente } from './../utils.js';

/** Aparelho por extenso, a partir do User-Agent. O UA cru nunca é gravado. */
export function aparelhoDoPedido(userAgent: string | undefined): { tipo: string; so: string; nav: string } {
  const ua = userAgent ?? '';
  const tipo = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'Celular' : 'Computador';

  let so = 'Outro';
  if (/Android/i.test(ua)) so = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) so = 'iOS';
  else if (/Windows/i.test(ua)) so = 'Windows';
  else if (/Mac OS X/i.test(ua)) so = 'macOS';
  else if (/Linux/i.test(ua)) so = 'Linux';

  let nav = 'Outro';
  if (/Edg\//i.test(ua)) nav = 'Edge';
  else if (/OPR\//i.test(ua)) nav = 'Opera';
  else if (/Chrome\//i.test(ua)) nav = 'Chrome';
  else if (/Firefox\//i.test(ua)) nav = 'Firefox';
  else if (/Safari\//i.test(ua)) nav = 'Safari';

  return { tipo, so, nav };
}

/* -------------------------------------------------------------------------- */
/* Freio de força bruta                                                        */
/* -------------------------------------------------------------------------- */

interface Tentativas {
  erros: number;
  bloqueadoAte: number;
}

/**
 * Em produção (Postgres) o contador é compartilhado entre instâncias. No
 * desenvolvimento com arquivo, um mapa em memória basta, porque só existe um
 * processo. O mapa NÃO é suficiente na Vercel: lá o Postgres é obrigatório.
 */
const tentativasLocais = new Map<string, Tentativas>();

export interface EstadoBloqueio {
  bloqueado: boolean;
  minutosRestantes: number;
}

export function conferirBloqueio(ip: string): EstadoBloqueio {
  const registro = tentativasLocais.get(ip);
  if (!registro || registro.bloqueadoAte <= Date.now()) return { bloqueado: false, minutosRestantes: 0 };
  return {
    bloqueado: true,
    minutosRestantes: Math.max(1, Math.ceil((registro.bloqueadoAte - Date.now()) / 60_000)),
  };
}

export function registrarErroDeSenha(ip: string): EstadoBloqueio {
  const registro = tentativasLocais.get(ip) ?? { erros: 0, bloqueadoAte: 0 };
  registro.erros += 1;

  if (registro.erros >= config.painel.maxErrosSenha) {
    registro.bloqueadoAte = Date.now() + config.painel.minutosBloqueio * 60_000;
    registro.erros = 0;
  }

  tentativasLocais.set(ip, registro);
  if (tentativasLocais.size > 5_000) {
    for (const [chave, valor] of tentativasLocais) {
      if (valor.bloqueadoAte <= Date.now() && valor.erros === 0) tentativasLocais.delete(chave);
    }
  }
  return conferirBloqueio(ip);
}

export function limparErrosDeSenha(ip: string): void {
  tentativasLocais.delete(ip);
}

/* -------------------------------------------------------------------------- */
/* Middlewares                                                                 */
/* -------------------------------------------------------------------------- */

function recusar(res: Response): void {
  res.status(401).json({ success: false, error: 'NAO_AUTORIZADO', message: 'Sessão expirada. Entre de novo.' });
}

/** Rotas do dono. Token de equipe é recusado aqui. */
export function exigirAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('X-Admin-Sessao') ?? '';
  if (!tokenValido(token, 'dono')) {
    recusar(res);
    return;
  }
  req.papelSessao = 'dono';
  next();
}

/** Rotas que a equipe também usa. Marca o papel para o handler decidir o resto. */
export function exigirLeads(req: Request, res: Response, next: NextFunction): void {
  const papel = papelDoToken(req.header('X-Admin-Sessao') ?? '');
  if (!papel) {
    recusar(res);
    return;
  }
  req.papelSessao = papel;
  next();
}

/* -------------------------------------------------------------------------- */
/* Links de entrega assinados                                                  */
/* -------------------------------------------------------------------------- */

export function assinarEntrega(pedidoId: string, expiraEm: number): string {
  if (!config.painel.chaveMestra) throw new Error('PAINEL_CHAVE_MESTRA não configurada.');
  return crypto
    .createHmac('sha256', config.painel.chaveMestra)
    .update(`${pedidoId}.${expiraEm}`)
    .digest('hex')
    .slice(0, 40);
}

export function entregaAssinaturaConfere(pedidoId: string, expiraEm: number, assinatura: string): boolean {
  if (!config.painel.chaveMestra) return false;
  return iguaisEmTempoConstante(assinarEntrega(pedidoId, expiraEm), assinatura);
}

/**
 * Assinatura do link da campanha de recuperação.
 *
 * Rótulo próprio ("recuperacao:") e não o mesmo HMAC da entrega: são duas
 * autorizações diferentes — uma dá acesso ao produto comprado, a outra libera
 * um preço que não existe no site. Com o mesmo segredo e a mesma fórmula, um
 * link de entrega vazado viraria um link de compra com desconto, e vice-versa.
 * O rótulo separa os dois domínios sem precisar de uma segunda chave.
 */
export function assinarRecuperacao(pedidoId: string, expiraEm: number): string {
  if (!config.painel.chaveMestra) throw new Error('PAINEL_CHAVE_MESTRA não configurada.');
  return crypto
    .createHmac('sha256', config.painel.chaveMestra)
    .update(`recuperacao:${pedidoId}.${expiraEm}`)
    .digest('hex')
    .slice(0, 40);
}

export function recuperacaoAssinaturaConfere(pedidoId: string, expiraEm: number, assinatura: string): boolean {
  if (!config.painel.chaveMestra) return false;
  return iguaisEmTempoConstante(assinarRecuperacao(pedidoId, expiraEm), assinatura);
}

/**
 * Assinatura da imagem que mede a abertura do e-mail.
 *
 * SEM PRAZO, ao contrário das outras duas. Um e-mail fica na caixa de entrada
 * para sempre, e quem abre a mensagem de terça no domingo seguinte precisa ser
 * contado — o número existe justamente para saber quando as pessoas leem.
 *
 * A assinatura existe para que o endereço não possa ser adivinhado: sem ela,
 * qualquer um que descobrisse o formato poderia varrer ids de pedido e sujar a
 * medição, ou pior, confirmar quais ids existem. Rótulo próprio ("abertura:")
 * pelo mesmo motivo dos outros: esta permissão não abre produto nem preço, só
 * escreve um contador, e não pode virar moeda de troca para as outras duas.
 */
export function assinarAbertura(pedidoId: string, rotulo: string): string {
  if (!config.painel.chaveMestra) throw new Error('PAINEL_CHAVE_MESTRA não configurada.');
  return crypto
    .createHmac('sha256', config.painel.chaveMestra)
    .update(`abertura:${pedidoId}.${rotulo}`)
    .digest('hex')
    .slice(0, 24);
}

export function aberturaAssinaturaConfere(pedidoId: string, rotulo: string, assinatura: string): boolean {
  if (!config.painel.chaveMestra) return false;
  return iguaisEmTempoConstante(assinarAbertura(pedidoId, rotulo), assinatura);
}
