import { logger } from './logger.js';

/**
 * Importa quanto foi gasto em cada anúncio, a partir de uma planilha.
 *
 * O gasto vive no Gerenciador de Anúncios e não no nosso banco. Ferramentas
 * como a Stract extraem esse número para uma Google Sheet; daqui a gente lê a
 * planilha publicada em CSV e preenche a coluna "Investido" do painel — que
 * antes era digitada à mão, todo dia, para cada campanha.
 *
 * Nada aqui participa do caminho da venda: falhar significa uma coluna
 * desatualizada, nunca um cliente sem produto.
 *
 * O maior risco deste arquivo não é falhar — é acertar o formato errado em
 * silêncio. "1.234" pode ser mil duzentos e trinta e quatro ou um vírgula
 * duzentos e trinta e quatro, e errar por mil vezes transforma um anúncio
 * lucrativo em prejuízo aparente. Por isso a leitura de número é explícita e
 * testada, em vez de um parseFloat otimista.
 */

export interface LinhaDeInvestimento {
  /** Dia no formato AAAA-MM-DD. */
  dia: string;
  /** Identificador da campanha (o mesmo que o painel usa para agrupar). */
  chave: string;
  /** Nome legível, quando a planilha traz. Só para a mensagem de conferência. */
  nome: string | null;
  centavos: number;
  /**
   * Impressões e cliques, quando a planilha traz. Zero quando não traz.
   *
   * São opcionais de propósito: quem só quer ver retorno precisa apenas do
   * gasto, e exigir as três colunas faria a importação inteira falhar em
   * planilha que hoje funciona.
   */
  impressoes: number;
  cliques: number;
}

export interface ResultadoDaImportacao {
  linhas: LinhaDeInvestimento[];
  /** Linhas descartadas e o motivo, para o dono ver o que não entrou. */
  ignoradas: string[];
  colunasEncontradas: {
    dia: string;
    chave: string;
    valor: string;
    nome: string | null;
    impressoes: string | null;
    cliques: string | null;
  };
}

export class ImportacaoError extends Error {
  readonly codigo: string;
  constructor(mensagem: string, codigo = 'IMPORTACAO_INVALIDA') {
    super(mensagem);
    this.name = 'ImportacaoError';
    this.codigo = codigo;
  }
}

/* -------------------------------------------------------------------------- */
/* Leitura do CSV                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Separa uma linha de CSV respeitando aspas.
 *
 * Nome de campanha com vírgula é comum ("Frio, video 01"), e um split simples
 * quebraria a linha inteira no meio — deslocando todas as colunas seguintes e
 * fazendo o valor virar texto sem ninguém perceber.
 */
function separarLinha(linha: string, separador: string): string[] {
  const campos: string[] = [];
  let atual = '';
  let dentroDeAspas = false;

  for (let i = 0; i < linha.length; i += 1) {
    const caractere = linha[i];

    if (caractere === '"') {
      // Aspas duplas dentro de campo entre aspas são o escape do próprio CSV.
      if (dentroDeAspas && linha[i + 1] === '"') {
        atual += '"';
        i += 1;
      } else {
        dentroDeAspas = !dentroDeAspas;
      }
      continue;
    }

    if (caractere === separador && !dentroDeAspas) {
      campos.push(atual);
      atual = '';
      continue;
    }

    atual += caractere;
  }

  campos.push(atual);
  return campos.map((campo) => campo.trim());
}

/**
 * Descobre o separador. Planilha brasileira exporta com ponto e vírgula, porque
 * a vírgula já é o separador decimal — assumir vírgula sempre quebraria metade
 * dos arquivos que este importador vai receber.
 */
function detectarSeparador(cabecalho: string): string {
  const virgulas = (cabecalho.match(/,/g) ?? []).length;
  const pontoEVirgula = (cabecalho.match(/;/g) ?? []).length;
  const tabulacoes = (cabecalho.match(/\t/g) ?? []).length;

  if (tabulacoes > virgulas && tabulacoes > pontoEVirgula) return '\t';
  return pontoEVirgula > virgulas ? ';' : ',';
}

/* -------------------------------------------------------------------------- */
/* Reconhecimento das colunas                                                  */
/* -------------------------------------------------------------------------- */

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/*
 * O nome das colunas muda conforme quem exportou, o idioma da conta e o que o
 * dono escolheu na Stract. Em vez de exigir um formato, reconhecemos os nomes
 * conhecidos — o mesmo caminho que server/pix.ts já usa para as APIs de PIX,
 * que nomeiam as mesmas coisas de um jeito diferente cada uma.
 */
const NOMES_DE_DIA = ['date', 'data', 'dia', 'datestart', 'datainicio', 'dataderelatorio', 'reportdate', 'day'];
const NOMES_DE_CHAVE = [
  'campaignid', 'idcampanha', 'campanhaid', 'idcampaign', 'iddacampanha',
  'adsetid', 'idconjunto', 'adid', 'idanuncio',
];
const NOMES_DE_NOME = ['campaignname', 'campanha', 'nomecampanha', 'nomedacampanha', 'campaign'];
const NOMES_DE_VALOR = [
  'spend', 'gasto', 'investimento', 'investido', 'custo', 'cost', 'valorgasto',
  'amountspent', 'valorusado', 'totalgasto',
];
const NOMES_DE_IMPRESSOES = ['impressions', 'impressoes', 'impressao', 'imprexibicoes', 'exibicoes'];
/*
 * Clique NO LINK vem primeiro, e a ordem é o que decide.
 *
 * O Meta exporta as duas contagens: "cliques (todos)" inclui curtida, comentário
 * e expandir a imagem; "cliques no link" é quem realmente saiu em direção ao
 * site. Usar a primeira faria o CTR parecer o dobro do real e o CPC, metade —
 * e a decisão de matar ou escalar o anúncio sairia do número errado.
 */
const NOMES_DE_CLIQUES = [
  'linkclicks', 'cliquesnolink', 'cliqueslink', 'outboundclicks', 'cliquesdesaida',
  'clicks', 'cliques', 'cliquestodos', 'clicksall',
];

function acharColuna(cabecalhos: string[], candidatos: string[]): number {
  const normalizados = cabecalhos.map(normalizar);
  for (const candidato of candidatos) {
    const posicao = normalizados.indexOf(candidato);
    if (posicao >= 0) return posicao;
  }
  // Segunda passada, por conteúdo: "Valor gasto (BRL)" não bate exato com nada.
  for (const candidato of candidatos) {
    const posicao = normalizados.findIndex((cabecalho) => cabecalho.includes(candidato));
    if (posicao >= 0) return posicao;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Números e datas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Converte o valor gasto em centavos.
 *
 * O caso perigoso é o ponto sozinho: "1.234" é mil duzentos e trinta e quatro
 * numa planilha brasileira e um vírgula duzentos e trinta e quatro numa
 * americana. Tratamos como milhar só quando o texto inteiro tem a forma clássica
 * de agrupamento (1.234, 12.345.678); qualquer outro ponto é decimal. Errar aqui
 * por mil vezes faria um anúncio lucrativo parecer prejuízo.
 */
export function paraCentavos(bruto: string): number | null {
  const limpo = (bruto ?? '')
    .replace(/R\$/gi, '')
    .replace(/\s| /g, '')
    .trim();

  if (limpo === '' || limpo === '-') return null;
  if (!/^-?[\d.,]+$/.test(limpo)) return null;

  const temPonto = limpo.includes('.');
  const temVirgula = limpo.includes(',');

  let normalizado: string;
  if (temPonto && temVirgula) {
    // O último separador é o decimal; o outro é agrupamento de milhar.
    normalizado = limpo.lastIndexOf(',') > limpo.lastIndexOf('.')
      ? limpo.replace(/\./g, '').replace(',', '.')
      : limpo.replace(/,/g, '');
  } else if (temVirgula) {
    normalizado = limpo.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(limpo)) {
    // Agrupamento clássico de milhar, sem casa decimal.
    normalizado = limpo.replace(/\./g, '');
  } else {
    normalizado = limpo;
  }

  const numero = Number.parseFloat(normalizado);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return Math.round(numero * 100);
}

/**
 * Converte uma contagem (impressões, cliques) em número inteiro.
 *
 * Não dá para reusar `paraCentavos` aqui: ela precisa decidir se "1,234" é mil
 * duzentos e trinta e quatro ou um e vinte e três, e escolhe o segundo — o que
 * está certo para dinheiro e errado para contagem, onde casa decimal não
 * existe. Um separador seguido de exatamente três dígitos é sempre milhar.
 */
export function paraContagem(bruto: string): number | null {
  const limpo = (bruto ?? '').replace(/\s| /g, '').trim();

  if (limpo === '' || limpo === '-') return null;
  if (!/^-?[\d.,]+$/.test(limpo)) return null;

  // 1.234 · 1,234 · 12.345.678 · 1,234,567 — agrupamento de milhar, em qualquer
  // das duas convenções.
  const normalizado = /^-?\d{1,3}([.,]\d{3})+$/.test(limpo)
    ? limpo.replace(/[.,]/g, '')
    : limpo.replace(/,/g, '.');

  const numero = Number.parseFloat(normalizado);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return Math.round(numero);
}

/** Aceita AAAA-MM-DD e DD/MM/AAAA, que são os dois formatos que aparecem. */
export function paraDia(bruto: string): string | null {
  const limpo = (bruto ?? '').trim();

  const iso = limpo.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const brasileiro = limpo.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (brasileiro) return `${brasileiro[3]}-${brasileiro[2]}-${brasileiro[1]}`;

  return null;
}

/* -------------------------------------------------------------------------- */
/* Busca e interpretação                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Só planilha publicada pelo Google.
 *
 * A URL é digitada por quem entrou no painel, e o servidor é quem faz a
 * requisição: sem essa trava, o painel viraria uma porta para sondar endereços
 * internos da rede onde ele roda (`http://localhost:...`, metadados da nuvem).
 */
const HOSTS_ACEITOS = ['docs.google.com', 'www.googleapis.com', 'sheets.googleapis.com'];

/**
 * Hosts extras, só para a bateria de teste apontar a um CSV local.
 *
 * Fica atrás de variável de ambiente e vazio por padrão: em produção a lista
 * continua sendo só o Google. Sem esta abertura, o caminho inteiro da
 * importação ficaria sem teste — e é ele que mexe nos números que o dono usa
 * para decidir onde colocar dinheiro.
 */
function hostsAceitos(): string[] {
  const extras = (process.env.INVESTIMENTO_HOSTS_EXTRA ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return [...HOSTS_ACEITOS, ...extras];
}

export function conferirEndereco(url: string): URL {
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch {
    throw new ImportacaoError('O endereço da planilha não é uma URL válida.', 'URL_INVALIDA');
  }

  const permitidos = hostsAceitos();
  const liberadoParaTeste = permitidos.includes(alvo.hostname) && !HOSTS_ACEITOS.includes(alvo.hostname);

  if (alvo.protocol !== 'https:' && !liberadoParaTeste) {
    throw new ImportacaoError('O endereço precisa começar com https.', 'URL_INSEGURA');
  }
  if (!permitidos.includes(alvo.hostname)) {
    throw new ImportacaoError(
      'Só aceitamos planilha publicada pelo Google (docs.google.com). ' +
        'No Google Sheets: Arquivo → Compartilhar → Publicar na web → CSV.',
      'HOST_NAO_ACEITO',
    );
  }
  return alvo;
}

export function interpretarCsv(texto: string): ResultadoDaImportacao {
  const linhas = texto.split(/\r?\n/).filter((linha) => linha.trim() !== '');
  if (linhas.length < 2) {
    throw new ImportacaoError('A planilha veio vazia ou só com o cabeçalho.', 'PLANILHA_VAZIA');
  }

  const separador = detectarSeparador(linhas[0]);
  const cabecalhos = separarLinha(linhas[0], separador);

  const posDia = acharColuna(cabecalhos, NOMES_DE_DIA);
  const posChave = acharColuna(cabecalhos, NOMES_DE_CHAVE);
  const posValor = acharColuna(cabecalhos, NOMES_DE_VALOR);
  const posNome = acharColuna(cabecalhos, NOMES_DE_NOME);
  const posImpressoes = acharColuna(cabecalhos, NOMES_DE_IMPRESSOES);
  const posCliques = acharColuna(cabecalhos, NOMES_DE_CLIQUES);

  if (posDia < 0 || posChave < 0 || posValor < 0) {
    const faltando = [
      posDia < 0 ? 'data' : null,
      posChave < 0 ? 'id da campanha' : null,
      posValor < 0 ? 'valor gasto' : null,
    ].filter(Boolean);
    throw new ImportacaoError(
      `Não encontrei ${faltando.join(', ')} na planilha. ` +
        `Colunas que vieram: ${cabecalhos.join(', ')}.`,
      'COLUNAS_AUSENTES',
    );
  }

  const resultado: LinhaDeInvestimento[] = [];
  const ignoradas: string[] = [];

  for (let i = 1; i < linhas.length; i += 1) {
    const campos = separarLinha(linhas[i], separador);
    const dia = paraDia(campos[posDia] ?? '');
    const chave = (campos[posChave] ?? '').trim();
    const centavos = paraCentavos(campos[posValor] ?? '');

    if (!dia) {
      ignoradas.push(`linha ${i + 1}: data "${campos[posDia] ?? ''}" não reconhecida`);
      continue;
    }
    if (!chave) {
      ignoradas.push(`linha ${i + 1}: sem id de campanha`);
      continue;
    }
    if (centavos === null) {
      ignoradas.push(`linha ${i + 1}: valor "${campos[posValor] ?? ''}" não é um número`);
      continue;
    }

    resultado.push({
      dia,
      chave,
      nome: posNome >= 0 ? (campos[posNome] ?? '').trim() || null : null,
      centavos,
      // Coluna ausente ou ilegível vira zero em vez de descartar a linha: o
      // gasto é o dado que não pode faltar; impressão e clique são um extra
      // que, quando falta, só apaga CTR e CPM daquela linha.
      impressoes: posImpressoes >= 0 ? (paraContagem(campos[posImpressoes] ?? '') ?? 0) : 0,
      cliques: posCliques >= 0 ? (paraContagem(campos[posCliques] ?? '') ?? 0) : 0,
    });
  }

  /*
   * A mesma campanha pode aparecer várias vezes no mesmo dia (uma linha por
   * anúncio, por exemplo). Somamos, em vez de deixar a última sobrescrever as
   * outras — senão o investimento apareceria menor do que foi.
   */
  const somados = new Map<string, LinhaDeInvestimento>();
  for (const linha of resultado) {
    const id = JSON.stringify([linha.chave, linha.dia]);
    const atual = somados.get(id);
    if (atual) {
      atual.centavos += linha.centavos;
      atual.impressoes += linha.impressoes;
      atual.cliques += linha.cliques;
    } else somados.set(id, { ...linha });
  }

  return {
    linhas: [...somados.values()],
    ignoradas: ignoradas.slice(0, 20),
    colunasEncontradas: {
      dia: cabecalhos[posDia],
      chave: cabecalhos[posChave],
      valor: cabecalhos[posValor],
      nome: posNome >= 0 ? cabecalhos[posNome] : null,
      impressoes: posImpressoes >= 0 ? cabecalhos[posImpressoes] : null,
      cliques: posCliques >= 0 ? cabecalhos[posCliques] : null,
    },
  };
}

/** Busca a planilha e interpreta. Lança ImportacaoError com mensagem legível. */
export async function buscarPlanilha(url: string, timeoutMs = 15_000): Promise<ResultadoDaImportacao> {
  const alvo = conferirEndereco(url);

  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), timeoutMs);

  let resposta: Response;
  try {
    resposta = await fetch(alvo.toString(), { signal: abortar.signal, redirect: 'follow' });
  } catch (erro) {
    const abortado = (erro as Error)?.name === 'AbortError';
    throw new ImportacaoError(
      abortado ? 'A planilha demorou demais para responder.' : 'Não consegui acessar a planilha.',
      'FALHA_DE_REDE',
    );
  } finally {
    clearTimeout(relogio);
  }

  if (!resposta.ok) {
    throw new ImportacaoError(
      `A planilha respondeu ${resposta.status}. Confira se ela está publicada na web em formato CSV.`,
      'RESPOSTA_INVALIDA',
    );
  }

  const texto = await resposta.text();

  // Uma planilha não publicada devolve a página de login do Google, com 200.
  if (/^\s*</.test(texto)) {
    throw new ImportacaoError(
      'O endereço devolveu uma página, não um CSV. Em Arquivo → Compartilhar → ' +
        'Publicar na web, escolha "Valores separados por vírgula (.csv)".',
      'NAO_E_CSV',
    );
  }

  const interpretado = interpretarCsv(texto);
  logger.info('Planilha de investimento lida', {
    linhas: interpretado.linhas.length,
    ignoradas: interpretado.ignoradas.length,
  });
  return interpretado;
}
