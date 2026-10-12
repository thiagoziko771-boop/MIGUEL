/**
 * Período em dia-calendário brasileiro.
 *
 * A função roda na Vercel, e lá o relógio do processo está em UTC. "Hoje"
 * calculado como `agora - 24 h` responde *as últimas 24 horas*, que é outra
 * pergunta: às 10 h da manhã isso soma metade de ontem no número de hoje, e o
 * dono decide orçamento em cima de um dia que não existe. Pior no fim da noite
 * — das 21 h em diante o UTC já virou, e o gasto anotado hoje cai fora do
 * recorte de "hoje".
 *
 * Aqui o dia começa à meia-noite em São Paulo, que é o mesmo dia que o
 * Gerenciador de Anúncios mostra e o mesmo que o dono tem na cabeça.
 */

/** Fuso do negócio. Todo cliente é brasileiro e o dono também. */
export const FUSO_DO_PAINEL = 'America/Sao_Paulo';

const FORMATADOR = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_DO_PAINEL,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // h23 e não hour12:false: em algumas engines o segundo devolve "24" para a
  // meia-noite, e o dia inteiro sairia deslocado.
  hourCycle: 'h23',
});

interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function partesLocais(quandoMs: number): PartesLocais {
  const partes = FORMATADOR.formatToParts(new Date(quandoMs));
  const pegar = (tipo: string): number => Number(partes.find((parte) => parte.type === tipo)?.value ?? '0');
  return {
    ano: pegar('year'),
    mes: pegar('month'),
    dia: pegar('day'),
    hora: pegar('hour'),
    minuto: pegar('minute'),
    segundo: pegar('second'),
  };
}

/**
 * Quanto o relógio de São Paulo está à frente do UTC neste instante.
 *
 * Calculado a cada chamada em vez de fixado em -3 h: o Brasil já teve horário
 * de verão e pode voltar a ter. Um deslocamento fixo faria o painel errar o
 * começo do dia por uma hora justamente na virada, e ninguém desconfiaria.
 */
function deslocamentoMs(quandoMs: number): number {
  const p = partesLocais(quandoMs);
  const comoSeFosseUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  // Os milissegundos não aparecem no formatador: descontá-los evita um resto
  // que faria o deslocamento variar entre chamadas do mesmo segundo.
  return comoSeFosseUtc - Math.floor(quandoMs / 1000) * 1000;
}

function doisDigitos(valor: number): string {
  return String(valor).padStart(2, '0');
}

/** Dia-calendário (AAAA-MM-DD) em São Paulo. É o "dia" que o painel usa. */
export function diaLocal(quandoMs: number = Date.now()): string {
  const p = partesLocais(quandoMs);
  return `${p.ano}-${doisDigitos(p.mes)}-${doisDigitos(p.dia)}`;
}

/** Soma (ou subtrai) dias de calendário. Só aritmética de data, sem horário. */
export function somarDias(dia: string, delta: number): string {
  const [ano, mes, resto] = dia.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, resto + delta));
  return `${data.getUTCFullYear()}-${doisDigitos(data.getUTCMonth() + 1)}-${doisDigitos(data.getUTCDate())}`;
}

/** Instante (ISO em UTC) da meia-noite desse dia em São Paulo. */
export function inicioDoDiaLocal(dia: string): string {
  const [ano, mes, resto] = dia.split('-').map(Number);
  const meiaNoiteComoUtc = Date.UTC(ano, mes - 1, resto);

  // Duas passadas: a primeira usa o deslocamento aproximado, a segunda corrige
  // caso o instante encontrado caia do outro lado de uma mudança de fuso.
  const primeiro = meiaNoiteComoUtc - deslocamentoMs(meiaNoiteComoUtc);
  const ajustado = meiaNoiteComoUtc - deslocamentoMs(primeiro);
  return new Date(ajustado).toISOString();
}

export interface Janela {
  /** Instante inicial, inclusivo. */
  desde: string;
  /** Instante final, exclusivo. */
  ate: string;
  /** Primeiro dia-calendário da janela. */
  diaInicial: string;
  /** Último dia-calendário da janela. */
  diaFinal: string;
}

/**
 * Os últimos N dias de calendário, terminando hoje e incluindo hoje.
 *
 * `dias = 1` é "Hoje": da meia-noite em São Paulo até agora. `dias = 7` é hoje
 * mais os seis dias anteriores — não "168 horas atrás", que partiria o primeiro
 * dia no meio e mudaria o número a cada minuto.
 */
export function janelaDeDias(dias: number, agoraMs: number = Date.now()): Janela {
  return janelaDeDiasAte(dias, diaLocal(agoraMs), agoraMs);
}

/**
 * Os últimos N dias de calendário terminando num dia escolhido.
 *
 * É o que `janelaDeDias` não sabe responder: "ontem", um dia que já fechou. A
 * diferença mora no fim da janela. Terminando hoje ela para AGORA, porque o dia
 * ainda está correndo e nada do futuro pode entrar; terminando num dia passado
 * ela vai até a meia-noite seguinte, que é o dia inteiro.
 *
 * Cortar um dia fechado no horário de agora seria o erro silencioso aqui: às
 * 10 h, "ontem" mostraria só o gasto até as 10 h de ontem, e o número subiria
 * sozinho conforme o dia passasse — sobre um dia que não muda mais.
 */
export function janelaDeDiasAte(dias: number, diaFinal: string, agoraMs: number = Date.now()): Janela {
  const seguro = Number.isFinite(dias) && dias > 0 && dias <= 365 ? Math.floor(dias) : 7;
  const hoje = diaLocal(agoraMs);
  // Dia no futuro vira hoje: o painel nunca promete número que ainda não existe.
  const fim = diaFinal > hoje ? hoje : diaFinal;
  const diaInicial = somarDias(fim, -(seguro - 1));

  return {
    desde: inicioDoDiaLocal(diaInicial),
    ate: fim === hoje ? new Date(agoraMs).toISOString() : inicioDoDiaLocal(somarDias(fim, 1)),
    diaInicial,
    diaFinal: fim,
  };
}

/**
 * A janela imediatamente anterior, do mesmo tamanho — e recortada no mesmo
 * ponto do dia.
 *
 * O recorte por horário é o que torna a comparação honesta: hoje até as 10 h
 * contra ontem INTEIRO diria que as vendas caíram todo dia de manhã. Aqui hoje
 * até as 10 h é comparado com ontem até as 10 h.
 */
export function janelaAnterior(janela: Janela, dias: number, agoraMs: number = Date.now()): Janela {
  const seguro = Number.isFinite(dias) && dias > 0 && dias <= 365 ? Math.floor(dias) : 7;
  const diaFinal = somarDias(janela.diaInicial, -1);
  const diaInicial = somarDias(diaFinal, -(seguro - 1));
  const desde = inicioDoDiaLocal(diaInicial);
  /*
   * O tamanho da janela atual, e não "agora menos o começo dela".
   *
   * Para os períodos que terminam hoje os dois dão no mesmo. Deixaram de dar
   * quando passou a existir período de dia fechado: comparar ontem INTEIRO com
   * um pedaço de anteontem — só até a hora em que o dono abriu a tela —
   * inventaria uma queda que não aconteceu.
   */
  const fimAtual = Date.parse(janela.ate);
  const decorridoMs = Math.max(0, (Number.isFinite(fimAtual) ? fimAtual : agoraMs) - Date.parse(janela.desde));

  return {
    desde,
    ate: new Date(Date.parse(desde) + decorridoMs).toISOString(),
    diaInicial,
    diaFinal,
  };
}
