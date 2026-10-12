import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Order, OrderStore, ReusableOrderQuery, StatusPollUsage } from './types.js';

/**
 * Persistência em Postgres — obrigatória em serverless (Vercel), onde o
 * filesystem é efêmero e cada requisição pode cair em uma instância diferente.
 *
 * O pedido inteiro fica em uma coluna JSONB; as colunas soltas existem só para
 * indexar as buscas (por pagamento, por pedido pai e a de reaproveitamento).
 */
export function createPostgresStore(connectionString: string): OrderStore {
  const sql: NeonQueryFunction<false, false> = neon(connectionString);
  let ready: Promise<void> | null = null;

  function rowToOrder(row: { data: unknown }): Order {
    return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Order;
  }

  async function migrate(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS orders (
        id                TEXT PRIMARY KEY,
        payment_id        TEXT,
        parent_order_id   TEXT,
        offer             TEXT        NOT NULL,
        status            TEXT        NOT NULL,
        amount_cents      INTEGER     NOT NULL,
        customer_document TEXT        NOT NULL,
        items_key         TEXT        NOT NULL,
        expires_at        TIMESTAMPTZ,
        data              JSONB       NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_id_key ON orders (payment_id) WHERE payment_id IS NOT NULL`;
    await sql`CREATE INDEX IF NOT EXISTS orders_parent_idx ON orders (parent_order_id)`;
    await sql`
      CREATE INDEX IF NOT EXISTS orders_reuse_idx
        ON orders (customer_document, offer, status, amount_cents, items_key, created_at DESC)
    `;

    // Idempotência dos webhooks: a PRIMARY KEY é quem descarta reentregas,
    // inclusive quando duas chegam ao mesmo tempo em instâncias diferentes.
    await sql`
      CREATE TABLE IF NOT EXISTS webhook_events (
        dedupe_key  TEXT PRIMARY KEY,
        order_id    TEXT        NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS status_polls (
        day   DATE PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      )
    `;
  }

  return {
    kind: 'postgres',

    init(): Promise<void> {
      // Uma migração por processo: em serverless isso roda no cold start.
      if (!ready) {
        ready = migrate().then(
          () => logger.info('Postgres pronto (tabelas verificadas)'),
          (error: unknown) => {
            ready = null; // permite nova tentativa na próxima requisição
            throw error;
          },
        );
      }
      return ready;
    },

    async getOrder(orderId) {
      const rows = await sql`SELECT data FROM orders WHERE id = ${orderId} LIMIT 1`;
      return rows.length > 0 ? rowToOrder(rows[0] as { data: unknown }) : undefined;
    },

    async getOrderByPaymentId(paymentId) {
      const rows = await sql`SELECT data FROM orders WHERE payment_id = ${paymentId} LIMIT 1`;
      return rows.length > 0 ? rowToOrder(rows[0] as { data: unknown }) : undefined;
    },

    async listChildOrders(parentOrderId) {
      const rows = await sql`SELECT data FROM orders WHERE parent_order_id = ${parentOrderId}`;
      return rows.map((row) => rowToOrder(row as { data: unknown }));
    },

    async listOrders({ desde, limite }) {
      const rows = desde
        ? await sql`SELECT data FROM orders WHERE created_at >= ${desde} ORDER BY created_at DESC LIMIT ${limite}`
        : await sql`SELECT data FROM orders ORDER BY created_at DESC LIMIT ${limite}`;
      return rows.map((row) => rowToOrder(row as { data: unknown }));
    },

    async saveOrder(order) {
      order.updatedAt = new Date().toISOString();
      const itemsKey = [...order.itemIds].sort().join(',');

      await sql`
        INSERT INTO orders (
          id, payment_id, parent_order_id, offer, status, amount_cents,
          customer_document, items_key, expires_at, data, created_at, updated_at
        ) VALUES (
          ${order.id}, ${order.paymentId}, ${order.parentOrderId}, ${order.offer},
          ${order.status}, ${order.amountCents}, ${order.customer.document}, ${itemsKey},
          ${order.expiresAt}, ${JSON.stringify(order)}, ${order.createdAt}, ${order.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          payment_id      = EXCLUDED.payment_id,
          parent_order_id = EXCLUDED.parent_order_id,
          status          = EXCLUDED.status,
          amount_cents    = EXCLUDED.amount_cents,
          items_key       = EXCLUDED.items_key,
          expires_at      = EXCLUDED.expires_at,
          data            = EXCLUDED.data,
          updated_at      = EXCLUDED.updated_at
      `;
    },

    async findReusableOrder(query: ReusableOrderQuery) {
      const cutoff = new Date(Date.now() - config.reuseWindowMs).toISOString();
      const itemsKey = [...query.itemIds].sort().join(',');

      const rows = await sql`
        SELECT data FROM orders
         WHERE customer_document = ${query.document}
           AND offer             = ${query.offer}
           AND status            = 'pending'
           AND amount_cents      = ${query.amountCents}
           AND items_key         = ${itemsKey}
           AND created_at       >= ${cutoff}
           AND (expires_at IS NULL OR expires_at > now())
           -- Pedido sem 'metodo' é PIX: gravado antes de a escolha existir.
           AND COALESCE(data->>'metodo', 'pix') = ${query.metodo}
           -- E precisa ter o instrumento do método, ou não há o que mostrar.
           AND (
                 (${query.metodo} = 'pix'    AND data->>'qrCode' IS NOT NULL)
              OR (${query.metodo} = 'boleto' AND data->'boleto'  IS NOT NULL)
               )
         ORDER BY created_at DESC
         LIMIT 1
      `;
      return rows.length > 0 ? rowToOrder(rows[0] as { data: unknown }) : undefined;
    },

    async tryConsumeStatusPoll() {
      // O WHERE no DO UPDATE faz o teto diário ser respeitado atomicamente,
      // mesmo com várias instâncias consultando ao mesmo tempo.
      const rows = await sql`
        INSERT INTO status_polls (day, count) VALUES (CURRENT_DATE, 1)
        ON CONFLICT (day) DO UPDATE SET count = status_polls.count + 1
          WHERE status_polls.count < ${config.polling.dailyBudget}
        RETURNING count
      `;
      return rows.length > 0;
    },

    async getStatusPollUsage(): Promise<StatusPollUsage> {
      const rows = await sql`SELECT day::text AS day, count FROM status_polls WHERE day = CURRENT_DATE`;
      const row = rows[0] as { day: string; count: number } | undefined;
      return {
        day: row?.day ?? new Date().toISOString().slice(0, 10),
        count: Number(row?.count ?? 0),
        budget: config.polling.dailyBudget,
      };
    },

    async markWebhookProcessed(dedupeKey, orderId) {
      const rows = await sql`
        INSERT INTO webhook_events (dedupe_key, order_id) VALUES (${dedupeKey}, ${orderId})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING dedupe_key
      `;
      return rows.length > 0;
    },
  };
}
