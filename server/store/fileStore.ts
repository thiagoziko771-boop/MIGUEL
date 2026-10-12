import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Order, OrderStore, ReusableOrderQuery, StatusPollUsage } from './types.js';

interface StoreShape {
  version: number;
  orders: Record<string, Order>;
  /** Contador diário de consultas ao gateway, para não martelar a API. */
  statusPolls: { day: string; count: number };
  /** Chaves de webhook já processadas. */
  webhookEvents: Record<string, string>;
}

const EMPTY_STORE: StoreShape = {
  version: 2,
  orders: {},
  statusPolls: { day: '', count: 0 },
  webhookEvents: {},
};

/**
 * Persistência em arquivo JSON — só para desenvolvimento local, num único
 * processo. Não use em produção: não sobrevive a serverless nem a réplicas.
 */
export function createFileStore(): OrderStore {
  const filePath = path.join(config.dataDir, 'orders.json');
  let state: StoreShape = structuredClone(EMPTY_STORE);
  const paymentIdIndex = new Map<string, string>();
  let writeQueue: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue
      .then(async () => {
        const tempPath = `${filePath}.${process.pid}.tmp`;
        // O arquivo guarda CPF e contato dos clientes: 0600 restringe a leitura ao dono.
        await fsp.writeFile(tempPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(tempPath, filePath);
      })
      .catch((error: unknown) => {
        logger.error('Falha ao gravar a base de pedidos', { error: (error as Error).message });
      });
    return writeQueue;
  }

  return {
    kind: 'file',

    async init() {
      fs.mkdirSync(config.dataDir, { recursive: true });
      if (!fs.existsSync(filePath)) {
        logger.info('Base de pedidos criada', { filePath });
        await persist();
        return;
      }
      let parsed: StoreShape;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoreShape;
      } catch (error) {
        // Não sobrescrevemos o arquivo: um JSON corrompido pode conter pedidos pagos.
        throw new Error(
          `Não foi possível ler ${filePath}: ${(error as Error).message}. ` +
            'Corrija ou mova o arquivo manualmente para não perder pedidos já confirmados.',
        );
      }
      state = { ...structuredClone(EMPTY_STORE), ...parsed };
      paymentIdIndex.clear();
      for (const order of Object.values(state.orders)) {
        if (order.paymentId) paymentIdIndex.set(order.paymentId, order.id);
      }
      logger.info('Base de pedidos carregada', { filePath, orders: Object.keys(state.orders).length });
    },

    async getOrder(orderId) {
      return state.orders[orderId];
    },

    async getOrderByPaymentId(paymentId) {
      const orderId = paymentIdIndex.get(paymentId);
      return orderId ? state.orders[orderId] : undefined;
    },

    async listChildOrders(parentOrderId) {
      return Object.values(state.orders).filter((order) => order.parentOrderId === parentOrderId);
    },

    async listOrders({ desde, limite }) {
      const cutoff = desde ? Date.parse(desde) : Number.NEGATIVE_INFINITY;
      return Object.values(state.orders)
        .filter((order) => Date.parse(order.createdAt) >= cutoff)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limite);
    },

    async saveOrder(order) {
      order.updatedAt = new Date().toISOString();
      state.orders[order.id] = order;
      if (order.paymentId) paymentIdIndex.set(order.paymentId, order.id);
      await persist();
    },

    async findReusableOrder(query: ReusableOrderQuery) {
      const cutoff = Date.now() - config.reuseWindowMs;
      const wantedItems = [...query.itemIds].sort().join(',');

      return Object.values(state.orders).find((order) => {
        if (order.status !== 'pending') return false;
        // Pedido sem método é PIX: nasceu antes de a escolha existir.
        if ((order.metodo ?? 'pix') !== query.metodo) return false;
        // Sem o instrumento de pagamento não há o que devolver para a tela.
        if (query.metodo === 'boleto' ? !order.boleto : !order.qrCode) return false;
        if (order.offer !== query.offer) return false;
        if (order.amountCents !== query.amountCents) return false;
        if (order.customer.document !== query.document) return false;
        if ([...order.itemIds].sort().join(',') !== wantedItems) return false;
        if (Date.parse(order.createdAt) < cutoff) return false;
        if (order.expiresAt && Date.parse(order.expiresAt) < Date.now()) return false;
        return true;
      });
    },

    async tryConsumeStatusPoll() {
      const today = new Date().toISOString().slice(0, 10);
      if (state.statusPolls.day !== today) {
        state.statusPolls = { day: today, count: 0 };
      }
      if (state.statusPolls.count >= config.polling.dailyBudget) return false;
      state.statusPolls.count += 1;
      void persist();
      return true;
    },

    async getStatusPollUsage(): Promise<StatusPollUsage> {
      return { ...state.statusPolls, budget: config.polling.dailyBudget };
    },

    async markWebhookProcessed(dedupeKey, orderId) {
      if (state.webhookEvents[dedupeKey]) return false;
      state.webhookEvents[dedupeKey] = orderId;
      await persist();
      return true;
    },
  };
}
