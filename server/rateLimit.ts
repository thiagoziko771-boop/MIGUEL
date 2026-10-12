import type { NextFunction, Request, Response } from 'express';
import { ipDoCliente } from './utils.js';

interface Bucket {
  hits: number[];
}

/**
 * Limitador em memória por IP. Criar cobrança consome crédito pré-pago da
 * gateway, então a rota precisa de um freio contra abuso e cliques repetidos.
 * Para múltiplas instâncias, troque por um limitador compartilhado (Redis).
 */
export function createRateLimiter(options: { windowMs: number; max: number; message: string }) {
  const buckets = new Map<string, Bucket>();

  function sweep(now: number): void {
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < options.windowMs);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    if (buckets.size > 5_000) sweep(now);

    /*
     * `ipDoCliente` e não `req.ip`: atrás da CDN, `req.ip` é a borda da Vercel —
     * a MESMA para todo mundo. O limite de 12 cobranças por janela deixaria de
     * ser por pessoa e passaria a valer para o site inteiro, e o décimo terceiro
     * comprador do período receberia 429 sem ter feito nada. Um freio contra
     * abuso que barra cliente pagante é pior do que freio nenhum.
     */
    const key = ipDoCliente(req);
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < options.windowMs);

    if (bucket.hits.length >= options.max) {
      const retryAfterSeconds = Math.ceil((options.windowMs - (now - bucket.hits[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ success: false, error: 'RATE_LIMITED', message: options.message });
      return;
    }

    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
}
