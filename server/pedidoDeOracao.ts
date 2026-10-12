/**
 * O rótulo que identifica um PEDIDO DE ORAÇÃO na tabela de eventos do funil,
 * num lugar só.
 *
 * O pedido viaja como um evento `EtapaDoFunil` com `pergunta` = este rótulo e
 * `resposta` = JSON {nome, email, tel, pedido} (ver src/App.tsx). Cinco
 * arquivos precisavam concordar sobre o texto exato — e no primeiro teste
 * ponta a ponta um deles recebeu o rótulo com o acento corrompido pelo
 * terminal e o CRM parou de reconhecer o pedido. Daí:
 *
 *  - `ROTULO_PEDIDO_DE_ORACAO` é o texto canônico que a tela manda;
 *  - `ehPedidoDeOracao()` compara SEM acento e sem caixa, para "Pedido de
 *    oração", "pedido de oracao" e um "ora��o" mastigado darem o mesmo;
 *  - `PREFIXO_SQL_PEDIDO` é o que o Postgres usa num ILIKE — o prefixo antes
 *    do acento é estável em qualquer encoding.
 */

export const ROTULO_PEDIDO_DE_ORACAO = 'Pedido de oração';

/** Para `pergunta ILIKE ${PREFIXO_SQL_PEDIDO}` — casa qualquer grafia do acento. */
export const PREFIXO_SQL_PEDIDO = 'pedido de ora%';

const semAcento = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .toLowerCase();

export function ehPedidoDeOracao(pergunta: string | null | undefined): boolean {
  if (!pergunta) return false;
  return semAcento(pergunta).startsWith('pedido de ora');
}
