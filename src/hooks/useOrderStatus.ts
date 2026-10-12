import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Order } from '../lib/api';

const POLL_INTERVAL_MS = 4000;

interface UseOrderStatusResult {
  order: Order | null;
  isChecking: boolean;
  error: string | null;
  /** Força uma verificação imediata (botão "já paguei"). */
  checkNow: () => Promise<Order | null>;
}

/**
 * Acompanha a confirmação do PIX. O servidor é quem decide quando o pagamento
 * foi confirmado — aqui só perguntamos e paramos assim que o status vira final.
 */
export function useOrderStatus(initialOrder: Order | null, enabled: boolean): UseOrderStatusResult {
  const [order, setOrder] = useState<Order | null>(initialOrder);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setOrder(initialOrder);
    setError(null);
  }, [initialOrder]);

  const orderId = order?.id ?? null;

  const check = useCallback(async (): Promise<Order | null> => {
    if (!orderId || inFlightRef.current) return null;
    inFlightRef.current = true;
    setIsChecking(true);
    try {
      const updated = await api.getOrder(orderId);
      setOrder(updated);
      setError(null);
      return updated;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Falha ao verificar o pagamento.');
      return null;
    } finally {
      inFlightRef.current = false;
      setIsChecking(false);
    }
  }, [orderId]);

  const isPending = order?.status === 'pending';

  useEffect(() => {
    if (!enabled || !orderId || !isPending) return;
    const timer = window.setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, orderId, isPending, check]);

  return { order, isChecking, error, checkNow: check };
}
