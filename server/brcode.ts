/**
 * Leitura do BR Code — o "copia e cola" do PIX.
 *
 * Único arquivo que sabe decifrar o EMV, mesma regra do server/pix.ts com o
 * gateway. Existe separado de orders.ts por um motivo mecânico: `orders.ts`
 * importa `discord.ts` para avisar a venda, e o Discord precisa ler o código
 * PIX. Se as funções morassem lá, os dois se importariam em círculo.
 *
 * O QUE ESTE ARQUIVO RESPONDE, e por que importa: quem o cliente vê na tela do
 * banco, e quem de fato liquida o dinheiro. Nenhuma das duas coisas está na
 * resposta JSON do gateway — as duas estão dentro do próprio código de pagar,
 * porque é ele que o Banco Central lê. Por isso a leitura é do código, e não do
 * que o provedor diz sobre si mesmo: se ele trocar de liquidante amanhã, a
 * resposta muda sozinha.
 *
 * O formato é TLV: <id de 2><tamanho de 2><valor>, e alguns campos contêm
 * outro TLV dentro. Toda leitura aqui é TOLERANTE — código malformado, ou o
 * texto do modo mock (que nem é um PIX), devolve `null`. Errar a leitura nunca
 * pode custar a renderização do código que fecha a venda.
 */

/** Percorre um nível de TLV e devolve `{ id: valor }`. */
export function lerTlv(texto: string): Record<string, string> {
  const saida: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= texto.length) {
    const id = texto.slice(i, i + 2);
    const tamanho = Number.parseInt(texto.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(tamanho) || tamanho < 0) break;
    saida[id] = texto.slice(i + 4, i + 4 + tamanho);
    i += 4 + tamanho;
  }
  return saida;
}

/**
 * O campo 59 do EMV — o nome que o aplicativo do banco exibe na confirmação.
 *
 * É a linha mais cara desta tela. Em 14/08/2026 a PixGo estampava "PRIME UNION
 * TRADING FIN" — uma financeira que o cliente nunca ouviu falar, na tela em que
 * ele decide se confia. Um comprador relatou o banco marcando a transação como
 * SUSPEITA, duas vezes, e desistiu.
 */
export function nomeDoRecebedorPix(codigo: string): string | null {
  try {
    const nome = (lerTlv(codigo)['59'] ?? '').trim();
    return nome === '' ? null : nome;
  } catch {
    /* codigo que nao e um EMV: sem aviso, sem erro */
    return null;
  }
}

/**
 * Nomes de gente para os domínios que já apareceram nos nossos códigos.
 *
 * O domínio é a prova; o nome é conveniência de leitura. Domínio desconhecido
 * NÃO vira "desconhecido": ele aparece como está, porque um domínio novo é
 * exatamente a informação que interessa — quer dizer que o gateway trocou de
 * liquidante sem avisar.
 */
const NOME_DO_PSP: Record<string, string> = {
  'fyhub.com.br': 'FireHub',
  'onlyup.com.br': 'OnlyUp',
  'pixgo.org': 'PixGo',
  'syncpayments.com.br': 'SyncPay',
  'zuckpay.com.br': 'ZuckPay',
};

export interface PspDoPix {
  /** O domínio cru, como está no código. É a prova. */
  dominio: string;
  /** Nome de gente quando conhecemos o domínio; senão, o próprio domínio. */
  nome: string;
}

/**
 * Quem REALMENTE liquida o PIX, lido do campo 26 do código.
 *
 * O gateway é o intermediário com quem contratamos; o PSP do campo 26 é a
 * empresa que fala com o Banco Central e cujo domínio hospeda o payload
 * dinâmico. Os dois quase nunca são o mesmo, e a diferença aparece em 20/08/2026
 * de forma concreta: o mesmo funil emitia por `pix.onlyup.com.br` pela SyncPay e
 * passou a emitir por `qrcode.fyhub.com.br` pela ZuckPay.
 *
 * Saber isso importa porque é o liquidante — não o gateway — que determina como
 * o banco do comprador classifica a transação, e porque é ele que responde num
 * MED ou num chargeback. Descobrir a troca pelo extrato, semanas depois, é o
 * jeito caro de aprender.
 *
 * O domínio sai do host da URL, e os subdomínios são descartados: `qrcode.` e
 * `pix.` são o mesmo PSP e agrupar é o que permite ver "trocou" de relance.
 */
export function pspDoPix(codigo: string): PspDoPix | null {
  try {
    const conta = lerTlv(lerTlv(codigo)['26'] ?? '');
    /*
     * `25` é a URL do payload dinâmico e `01` é a chave PIX estática. A URL
     * vem primeiro porque é ela que carrega o domínio do liquidante; uma chave
     * estática (e-mail, CPF, EVP) não diz quem liquida.
     */
    const url = (conta['25'] ?? '').trim();
    if (url === '') return null;

    const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (host === '') return null;

    const partes = host.split('.');
    /*
     * Domínios brasileiros têm três rótulos no registro (`fyhub.com.br`), e os
     * demais têm dois (`exemplo.com`). Cortar sempre dois juntaria
     * `fyhub.com.br` e `onlyup.com.br` num mesmo "com.br", que é o oposto do
     * que se quer: eles são liquidantes DIFERENTES.
     */
    const rotulos = partes.at(-1) === 'br' ? 3 : 2;
    const dominio = partes.slice(-rotulos).join('.');

    return { dominio, nome: NOME_DO_PSP[dominio] ?? dominio };
  } catch {
    return null;
  }
}
