import crypto from 'node:crypto';
import type { Request } from 'express';

/** Valores circulam em centavos no servidor; a conversão para reais só acontece na borda. */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Dinheiro escrito como o brasileiro lê: "R$ 1.324,46".
 *
 * O separador de milhar não era necessário enquanto os únicos valores eram os
 * do catálogo, todos abaixo de cem reais. Passou a ser quando o painel começou
 * a somar investimento em anúncio — "R$ 1324,46" faz a pessoa contar as casas
 * na tela para saber se é mil ou treze mil.
 */
export function formatBRL(cents: number): string {
  const inteiro = Math.trunc(Math.abs(centsToAmount(cents)));
  const centavos = Math.abs(Math.round(cents)) % 100;
  const comMilhar = String(inteiro).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sinal = cents < 0 ? '-' : '';
  return `${sinal}R$ ${comMilhar},${String(centavos).padStart(2, '0')}`;
}

export function newId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Mascara o documento para nunca devolver o número completo ao cliente. */
export function maskDocument(digits: string): string {
  const clean = onlyDigits(digits);
  if (clean.length === 11) return `***.${clean.slice(3, 6)}.${clean.slice(6, 9)}-**`;
  if (clean.length === 14) return `**.${clean.slice(2, 5)}.${clean.slice(5, 8)}/****-**`;
  return '***';
}

export function onlyDigits(value: string): string {
  return (value ?? '').replace(/\D+/g, '');
}

export function isExpired(expiresAt: string | undefined | null): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

const SALTOS_INTERNOS =
  /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;

/**
 * O IP de quem está do outro lado, atrás da CDN.
 *
 * Duas coisas dependem deste número e quebram de jeitos diferentes quando ele
 * vem errado:
 *
 *  - o bloqueio por IP do painel, que passaria a bloquear o mundo inteiro de
 *    uma vez, porque todo cliente viraria o mesmo IP da borda;
 *  - a identificação do cliente no Meta. IP e User-Agent são metade do que a
 *    API de Conversões usa para casar o evento do servidor com a pessoa. Mandar
 *    o IP do proxy é pior do que não mandar nada: todos os visitantes viram a
 *    mesma pessoa, a correspondência despenca e o Gerenciador de Eventos
 *    reclama de "client_ip_address" — que foi exatamente o que aconteceu.
 *
 * `req.ip` não serve: sem `trust proxy` ele é o socket (o proxy da Vercel), e
 * COM `trust proxy` ele é o primeiro item de um cabeçalho que o cliente pode
 * escrever. `x-vercel-forwarded-for` é o único que a Vercel sobrescreve e o
 * cliente não consegue forjar, por isso vem primeiro.
 */
export function ipDoCliente(req: Request): string {
  const daVercel = String(req.header('x-vercel-forwarded-for') ?? '').split(',')[0]?.trim();
  if (daVercel) return daVercel;

  const encadeados = String(req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((parte) => parte.trim())
    .filter(Boolean);

  // Do fim para o começo: o primeiro que não for salto interno é o cliente.
  for (let indice = encadeados.length - 1; indice >= 0; indice -= 1) {
    const candidato = encadeados[indice].replace(/^::ffff:/, '');
    if (!SALTOS_INTERNOS.test(candidato)) return candidato;
  }

  return (req.ip ?? req.socket.remoteAddress ?? 'desconhecido').replace(/^::ffff:/, '');
}

/**
 * O mesmo IP, mas `null` quando não dá para saber.
 *
 * O painel mostra "desconhecido" numa tela e ninguém se machuca. O Meta, não:
 * mandar a palavra "desconhecido" no lugar de um IP é mandar lixo hasheado que
 * nunca vai casar com pessoa nenhuma, e ainda conta como dado enviado. Ausente
 * é honesto; inventado, não.
 */
export function ipDoClienteOuNulo(req: Request): string | null {
  const ip = ipDoCliente(req);
  return ip === 'desconhecido' ? null : ip;
}

/**
 * O gateway devolve datas sem timezone ("2025-01-15T12:20:00"), que o Date.parse
 * do Node interpreta como UTC. O horário real é de Brasília (UTC-3).
 */
export function normalizeApiDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const candidate = hasTimezone ? trimmed : `${trimmed.replace(' ', 'T')}-03:00`;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}
