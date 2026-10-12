/**
 * O e-mail digitado tem cara de e-mail? E se não tem, qual era a intenção?
 *
 * Nasceu de duas vendas perdidas em dois dias, do mesmo jeito: gente digitando
 * no celular deixou o dedo escorregar DEPOIS do domínio — `gmail.com989888`
 * (Maria da Paz, 12/08) e `gmail.comn1` (Rosa, R$ 74, 14/08). O checkout
 * aceitou calado, o PIX nasceu, a pessoa não pagou na hora — e aí não existia
 * mais como falar com ela: o lembrete de recuperação recusa endereço
 * implausível (mandar dá devolução, e devolução derruba a reputação do domínio
 * para quem PAGOU), e nenhuma das duas deixou telefone.
 *
 * A regra aqui é ESPELHO da do servidor (server/recuperacao.ts): frouxa no
 * meio, rígida na ponta. Se as duas divergirem, o checkout aceita um endereço
 * que a recuperação depois recusa — exatamente o buraco que isto fecha.
 */
export function emailPlausivel(email: string): boolean {
  const limpo = email.trim();
  if (limpo.length < 6 || limpo.length > 254) return false;
  return /^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(limpo) && /\.[a-z]{2,}$/i.test(limpo);
}

/**
 * Quando dá para adivinhar o que a pessoa quis, a mensagem de erro oferece o
 * endereço pronto em vez de só reclamar.
 *
 * A adivinhação é deliberadamente conservadora: só corta o que sobra DEPOIS de
 * um provedor que praticamente todo este público usa. `rosa@gmail.comn1` vira
 * `rosa@gmail.com`; um domínio desconhecido não vira nada — sugerir errado é
 * pior que não sugerir, porque a pessoa aceita sem ler.
 */
const PROVEDOR_CONHECIDO = /^(.+@(?:gmail|hotmail|outlook|yahoo|icloud|bol|uol|terra|live|msn)\.com(?:\.br)?)(.+)$/i;

export function sugestaoDeEmail(email: string): string | null {
  const m = email.trim().toLowerCase().match(PROVEDOR_CONHECIDO);
  if (!m) return null;
  const cortado = m[1] as string;
  return emailPlausivel(cortado) ? cortado : null;
}
