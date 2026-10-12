export function onlyDigits(value: string): string {
  return (value ?? '').replace(/\D+/g, '');
}

export function formatBRL(amount: number): string {
  return `R$ ${amount.toFixed(2).replace('.', ',')}`;
}

export function maskCPF(value: string): string {
  const digits = onlyDigits(value).slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}

export function maskPhone(value: string): string {
  const digits = onlyDigits(value).slice(0, 11);
  if (digits.length <= 10) {
    return digits.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d{1,4})$/, '$1-$2');
  }
  return digits.replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
}

/**
 * Validação de CPF no cliente apenas para dar retorno imediato — o servidor
 * revalida antes de gerar qualquer cobrança.
 */
export function isValidCPF(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1+$/.test(digits)) return false;

  for (const [length, factor] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (factor - index);
    }
    const remainder = (sum * 10) % 11;
    const checkDigit = remainder === 10 ? 0 : remainder;
    if (checkDigit !== Number(digits[length])) return false;
  }
  return true;
}

/** Tempo restante em "mm:ss"; devolve null quando não há prazo ou já venceu. */
export function formatCountdown(expiresAt: string | null | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const remainingMs = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
