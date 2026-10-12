/**
 * A memória local do que a pessoa já nos contou antes do checkout.
 *
 * Nasceu com o fluxo curto do anúncio do dinheiro (14/08/2026: nome + data de
 * nascimento) e cresceu com o fluxo do PEDIDO DE ORAÇÃO (15/08/2026: nome +
 * e-mail + WhatsApp + o pedido). É com isso que a análise e a oferta falam com
 * a pessoa pelo nome, o checkout vem pré-preenchido, e — o mais importante —
 * quem recarrega a página não é obrigada a pedir de novo nem vira um lead
 * duplicado: `pedidoEnviado` diz "já pediu, siga em frente".
 *
 * localStorage e não sessionStorage: quem volta no dia seguinte pelo mesmo
 * navegador ainda merece ser chamada pelo nome. Tudo em try/catch porque
 * navegador embutido de aplicativo (Instagram/Facebook) às vezes bloqueia o
 * armazenamento — e memória que não persiste não pode derrubar o funil.
 */

const CHAVE = 'rezas_cadastro_rapido';

export interface CadastroRapido {
  nome: string;
  /** Como digitada, DD/MM/AAAA — serve à personalização, não a cálculo. */
  nascimento: string;
  email?: string;
  telefone?: string;
  /** O pedido de oração, como a pessoa escreveu (até 600 caracteres). */
  pedido?: string;
  /** Já entregou o pedido nesta visita/navegador: não pedir de novo. */
  pedidoEnviado?: boolean;
}

export function gravarCadastroRapido(cadastro: CadastroRapido): void {
  try {
    // Mescla com o que já havia: o fluxo curto grava só nome+nascimento e o
    // do pedido grava o resto — nenhum dos dois pode apagar o do outro.
    const anterior = lerCadastroRapido() ?? {};
    window.localStorage.setItem(CHAVE, JSON.stringify({ ...anterior, ...cadastro }));
  } catch {
    // Sem armazenamento não há personalização; o funil segue.
  }
}

export function lerCadastroRapido(): CadastroRapido | null {
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const dados = JSON.parse(bruto) as Partial<CadastroRapido>;
    if (typeof dados.nome !== 'string' || dados.nome.trim() === '') return null;
    return {
      nome: dados.nome,
      nascimento: typeof dados.nascimento === 'string' ? dados.nascimento : '',
      email: typeof dados.email === 'string' ? dados.email : undefined,
      telefone: typeof dados.telefone === 'string' ? dados.telefone : undefined,
      pedido: typeof dados.pedido === 'string' ? dados.pedido : undefined,
      pedidoEnviado: dados.pedidoEnviado === true,
    };
  } catch {
    return null;
  }
}

/** "maria da silva" -> "Maria" — é assim que as telas chamam a pessoa. */
export function primeiroNome(nome: string): string {
  const primeiro = nome.trim().split(/\s+/)[0] ?? '';
  if (primeiro === '') return '';
  return primeiro.charAt(0).toLocaleUpperCase('pt-BR') + primeiro.slice(1).toLocaleLowerCase('pt-BR');
}
