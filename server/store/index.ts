import { config } from '../config.js';
import { logger } from '../logger.js';
import { createFileStore } from './fileStore.js';
import { createPostgresStore } from './pgStore.js';
import type { Order, OrderStore, ReusableOrderQuery, StatusPollUsage } from './types.js';

export type {
  BoletoEmitido,
  MetodoPagamento,
  Order,
  OrderCustomer,
  OrderStatus,
  OrderStore,
  ReusableOrderQuery,
  StatusPollUsage,
} from './types.js';
export { TERMINAL_STATUSES } from './types.js';

/**
 * Escolhe onde os pedidos ficam guardados:
 *   • DATABASE_URL definida  -> Postgres (obrigatório em serverless/Vercel)
 *   • sem DATABASE_URL       -> arquivo JSON, só para desenvolvimento local
 */
function selectStore(): OrderStore {
  if (config.databaseUrl) return createPostgresStore(config.databaseUrl);
  return createFileStore();
}

const store: OrderStore = selectStore();

let initialized: Promise<void> | null = null;

/** Garante que o armazenamento está pronto (idempotente, seguro no cold start). */
export function initStore(): Promise<void> {
  if (!initialized) {
    initialized = store.init().catch((error: unknown) => {
      initialized = null; // deixa a próxima requisição tentar de novo
      throw error;
    });
  }
  return initialized;
}

export function storeKind(): 'file' | 'postgres' {
  return store.kind;
}

export function warnIfNotProductionReady(): void {
  if (store.kind === 'file' && process.env.NODE_ENV === 'production') {
    logger.warn(
      'DATABASE_URL não configurada: os pedidos estão indo para um arquivo local. ' +
        'Em serverless ou com mais de uma instância isso PERDE pedidos pagos. Configure o Postgres.',
    );
  }
}

export async function getOrder(orderId: string): Promise<Order | undefined> {
  await initStore();
  return store.getOrder(orderId);
}

export async function getOrderByPaymentId(paymentId: string): Promise<Order | undefined> {
  await initStore();
  return store.getOrderByPaymentId(paymentId);
}

export async function listChildOrders(parentOrderId: string): Promise<Order[]> {
  await initStore();
  return store.listChildOrders(parentOrderId);
}

export async function listOrders(options: { desde?: string; limite: number }): Promise<Order[]> {
  await initStore();
  return store.listOrders(options);
}

export async function saveOrder(order: Order): Promise<void> {
  await initStore();
  return store.saveOrder(order);
}

export async function findReusableOrder(query: ReusableOrderQuery): Promise<Order | undefined> {
  await initStore();
  return store.findReusableOrder(query);
}

export async function tryConsumeStatusPoll(): Promise<boolean> {
  await initStore();
  return store.tryConsumeStatusPoll();
}

export async function getStatusPollUsage(): Promise<StatusPollUsage> {
  await initStore();
  return store.getStatusPollUsage();
}

export async function markWebhookProcessed(dedupeKey: string, orderId: string): Promise<boolean> {
  await initStore();
  return store.markWebhookProcessed(dedupeKey, orderId);
}
