/**
 * O pedido em aberto, guardado no navegador.
 *
 * Vive num módulo próprio porque três telas precisam da MESMA resposta para a
 * pergunta "esta pessoa já tem um pedido esperando?": o App (para saber em que
 * etapa abrir), a tela da oferta (para saber se abre o checkout de cara) e o
 * próprio checkout (que retoma o pedido e mostra a mensagem de recuperação).
 * A chave já esteve escrita só dentro do checkout; duplicá-la em três arquivos
 * seria criar três lugares para ela sair de sincronia.
 *
 * Por que guardar isso: o PIX tira o cliente do site. Ele copia o código, abre
 * o app do banco e volta — e no celular a aba costuma ser descartada nesse
 * meio-tempo. Sem essa memória, quem volta reencontra a primeira tela do funil
 * e teria de responder as nove perguntas de novo para chegar ao pagamento que
 * já tinha começado. Na prática, não volta.
 */

const CHAVE = 'rezas_sagradas.pedido';

export interface PedidoGuardado {
  id: string;
  /** Marca que o cliente já passou pelas ofertas seguintes e chegou ao fim. */
  finished?: boolean;
}

export function lerPedidoGuardado(): PedidoGuardado | null {
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const salvo = JSON.parse(bruto) as PedidoGuardado;
    return typeof salvo?.id === 'string' && salvo.id ? salvo : null;
  } catch {
    // Navegação privada, storage cheio ou JSON corrompido: seguimos sem memória.
    return null;
  }
}

export function gravarPedidoGuardado(valor: PedidoGuardado | null): void {
  try {
    if (valor) window.localStorage.setItem(CHAVE, JSON.stringify(valor));
    else window.localStorage.removeItem(CHAVE);
  } catch {
    // Sem storage o pedido vale só para esta carga da página.
  }
}

/**
 * Existe pedido esperando por esta pessoa?
 *
 * Responde pelo que está no navegador, sem ir ao servidor: quem decide se o
 * pedido ainda vale é o checkout, que consulta a API e limpa a memória quando o
 * pedido expirou ou foi cancelado. Aqui a pergunta é outra e mais barata —
 * "vale a pena abrir o funil no fim em vez do começo?" — e ela precisa ser
 * respondida antes da primeira pintura, sem esperar rede nenhuma.
 */
export function temPedidoGuardado(): boolean {
  return lerPedidoGuardado() !== null;
}
