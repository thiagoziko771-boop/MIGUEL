import { onlyDigits } from './utils.js';

export class ValidationError extends Error {
  readonly status = 400;
  readonly code: string;
  readonly field?: string;

  constructor(message: string, options: { code?: string; field?: string } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = options.code ?? 'VALIDATION_ERROR';
    this.field = options.field;
  }
}

function hasRepeatedDigits(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

export function isValidCPF(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || hasRepeatedDigits(digits)) return false;

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

export function isValidCNPJ(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || hasRepeatedDigits(digits)) return false;

  for (const length of [12, 13] as const) {
    let factor = length - 7;
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * factor;
      factor = factor - 1 < 2 ? 9 : factor - 1;
    }
    const remainder = sum % 11;
    const checkDigit = remainder < 2 ? 0 : 11 - remainder;
    if (checkDigit !== Number(digits[length])) return false;
  }
  return true;
}

export function isValidDocument(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length === 11) return isValidCPF(digits);
  if (digits.length === 14) return isValidCNPJ(digits);
  return false;
}

export interface CustomerInput {
  name: string;
  email: string;
  phone: string;
  document: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseCustomer(input: unknown): CustomerInput {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('Os dados do cliente são obrigatórios.', { field: 'customer' });
  }
  const raw = input as Record<string, unknown>;

  const name = String(raw.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) {
    throw new ValidationError('Informe o nome completo (entre 2 e 100 caracteres).', { field: 'name' });
  }

  const email = String(raw.email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 255) {
    throw new ValidationError('Informe um e-mail válido.', { field: 'email' });
  }

  // O gateway exige o CPF/CNPJ de quem vai pagar e trava o QR
  // Code nesse documento: se outra pessoa pagar, a cobrança pode ser rejeitada.
  const document = onlyDigits(String(raw.document ?? raw.cpf ?? ''));
  if (!document) {
    throw new ValidationError('Informe o CPF de quem vai pagar o PIX.', { field: 'document', code: 'DOCUMENT_REQUIRED' });
  }
  if (!isValidDocument(document)) {
    throw new ValidationError('CPF inválido. Confira os números digitados.', { field: 'document', code: 'DOCUMENT_INVALID' });
  }

  const phone = onlyDigits(String(raw.phone ?? ''));
  if (phone && (phone.length < 10 || phone.length > 11)) {
    throw new ValidationError('Informe o telefone com DDD (10 ou 11 dígitos).', { field: 'phone' });
  }

  return { name, email, phone, document };
}

export function parseStringArray(input: unknown, field: string): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new ValidationError(`O campo "${field}" deve ser uma lista.`, { field });
  }
  return input.map((item) => String(item).trim()).filter(Boolean);
}
