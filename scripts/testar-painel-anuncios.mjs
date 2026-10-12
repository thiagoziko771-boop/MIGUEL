/**
 * Testa as contas da aba Anúncios do painel: CTR, CPC, CPM, ROAS, custo por
 * venda, lucro e a comparação com o período anterior.
 *
 *   node scripts/testar-painel-anuncios.mjs
 *
 * Por que uma bateria só para isto: estes números não quebram, eles MENTEM. Um
 * pedido do período passado somado ao de hoje não derruba tela nenhuma — só faz
 * o dono achar que o anúncio de hoje vendeu o dobro e triplicar o orçamento em
 * cima de um número inventado. Nada aqui toca dinheiro: sobe uma PixGo falsa
 * local e o servidor roda numa pasta vazia, com banco em arquivo temporário.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_PIXGO = 3395;
const PORTA_APP = 3339;
const CHAVE_PIX = 'pk_chavedeteste';
const SEGREDO_PIX = 'whsec_segredodeteste';

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const base = `http://localhost:${PORTA_APP}`;

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/** Compara com folga: 41.666... nunca vai ser exatamente igual a 41.67. */
const perto = (a, b) => a !== null && a !== undefined && Math.abs(a - b) < 0.01;

/* ========================================================================== */
/* PARTE 1 — leitura de contagem e das colunas novas da planilha               */
/* ========================================================================== */

console.log('\n== Impressões e cliques vindos da planilha ==\n');

/*
 * O módulo é TypeScript e importa irmãos com extensão .js: só o tsx resolve
 * isso. Rodar num arquivo à parte e trazer o resultado por stdout é o mesmo
 * caminho que scripts/testar-rastreamento.mjs já usa.
 */
const pastaTemp = mkdtempSync(path.join(tmpdir(), 'anuncios-teste-'));
const arquivoUnitario = path.join(pastaTemp, 'planilha.test.mts');
const moduloInvestimento = pathToFileURL(path.join(raiz, 'server/investimento.ts')).href;
const moduloPeriodo = pathToFileURL(path.join(raiz, 'server/periodo.ts')).href;

writeFileSync(
  arquivoUnitario,
  `
import { paraContagem, interpretarCsv } from ${JSON.stringify(moduloInvestimento)};
import { diaLocal, janelaAnterior, janelaDeDias, somarDias } from ${JSON.stringify(moduloPeriodo)};

const resultados: Array<[boolean, string]> = [];
const checar = (ok: boolean, descricao: string) => resultados.push([ok, descricao]);

/* ---------------------------------------------------------------------------
 * O dia do painel é o dia de São Paulo, não o do relógio UTC do servidor.
 *
 * O instante escolhido é o que quebrava tudo: 01:00 UTC do dia 11 é 22:00 do
 * dia 10 no Brasil. Pela conta antiga, "hoje" já era o dia 11 e o gasto que o
 * dono tinha acabado de anotar no dia 10 sumia da tela.
 * ------------------------------------------------------------------------- */

const noiteDoDia10 = Date.UTC(2026, 7, 11, 1, 0, 0); // 22:00 de 10/08 em BRT

checar(diaLocal(noiteDoDia10) === '2026-08-10', 'as 22h do dia 10 ainda são o dia 10 (veio ' + diaLocal(noiteDoDia10) + ')');
checar(diaLocal(Date.UTC(2026, 7, 10, 3, 0, 0)) === '2026-08-10', 'a meia-noite em SP já é o dia novo');
checar(diaLocal(Date.UTC(2026, 7, 10, 2, 59, 0)) === '2026-08-09', 'um minuto antes da meia-noite ainda é o dia anterior');

const hojeParcial = janelaDeDias(1, noiteDoDia10);
checar(hojeParcial.diaInicial === '2026-08-10' && hojeParcial.diaFinal === '2026-08-10', 'Hoje é um dia só');
checar(hojeParcial.desde === '2026-08-10T03:00:00.000Z', 'Hoje começa à meia-noite de SP (veio ' + hojeParcial.desde + ')');
checar(hojeParcial.ate === new Date(noiteDoDia10).toISOString(), 'Hoje termina agora, não à meia-noite seguinte');

const seteDias = janelaDeDias(7, noiteDoDia10);
checar(seteDias.diaInicial === '2026-08-04', '7 dias conta hoje mais os seis anteriores (veio ' + seteDias.diaInicial + ')');

// A janela anterior é recortada no MESMO ponto do dia: dia parcial contra dia
// parcial. Comparar hoje até as 22h com ontem inteiro diria que caiu sempre.
const ontem = janelaAnterior(hojeParcial, 1, noiteDoDia10);
checar(ontem.desde === '2026-08-09T03:00:00.000Z', 'ontem começa à meia-noite de 09 (veio ' + ontem.desde + ')');
checar(
  Date.parse(ontem.ate) - Date.parse(ontem.desde) === noiteDoDia10 - Date.parse(hojeParcial.desde),
  'ontem é medido pelo mesmo tanto de horas que já se passaram hoje',
);
checar(Date.parse(ontem.ate) <= Date.parse(hojeParcial.desde), 'a janela anterior não invade a de hoje');

checar(somarDias('2024-03-01', -1) === '2024-02-29', 'a aritmética de dias respeita o ano bissexto');
checar(somarDias('2026-01-01', -1) === '2025-12-31', 'a aritmética de dias atravessa o ano');

checar(paraContagem('1234') === 1234, 'le um numero simples');
checar(paraContagem('1.234') === 1234, 'le 1.234 como mil duzentos e trinta e quatro');
// O caso que separa contagem de dinheiro. paraCentavos('1,234') responde um e
// vinte e tres, porque para dinheiro a virgula e decimal -- e esta certo. Aqui
// seria a diferenca entre 1.234 impressoes e 1 impressao, o que faria o CTR
// aparecer mil vezes maior do que e.
checar(paraContagem('1,234') === 1234, 'le 1,234 como milhar, e nao como um virgula dois');
checar(paraContagem('12.345.678') === 12345678, 'le milhar repetido');
checar(paraContagem('') === null, 'campo vazio nao vira zero silencioso');
checar(paraContagem('abc') === null, 'texto nao vira numero');

const csv = [
  'Date,Campaign ID,Campaign name,Amount spent,Impressions,Link clicks,Clicks (all)',
  '2026-08-09,120200,RS_frio_video01,"123,45","10.000","250","900"',
].join('\\n');

const lido = interpretarCsv(csv);
checar(lido.linhas.length === 1, 'le a linha da planilha');
checar(lido.linhas[0].centavos === 12345, 'le o gasto (veio ' + lido.linhas[0].centavos + ')');
checar(lido.linhas[0].impressoes === 10000, 'le as impressoes (veio ' + lido.linhas[0].impressoes + ')');
// "Cliques no link" (250) e nao "cliques (todos)" (900). Todos inclui curtida e
// expandir imagem: usar esse numero faria o CTR parecer 3,6x maior e o CPC 3,6x
// menor -- e um anuncio ruim passaria por bom.
checar(
  lido.linhas[0].cliques === 250,
  'prefere o clique NO LINK ao clique em qualquer coisa (veio ' + lido.linhas[0].cliques + ')',
);

// Planilha so com gasto continua entrando: as colunas novas sao um extra.
const semExtras = interpretarCsv('Data;ID da campanha;Valor gasto\\n09/08/2026;120200;"99,90"');
checar(semExtras.linhas.length === 1, 'planilha sem impressoes e cliques continua sendo aceita');
checar(
  semExtras.linhas[0].impressoes === 0 && semExtras.linhas[0].cliques === 0,
  'sem as colunas, contagem vira zero',
);

console.log(JSON.stringify(resultados));
`,
  'utf8',
);

const unitario = spawnSync('npx', ['tsx', arquivoUnitario], {
  cwd: raiz,
  shell: process.platform === 'win32',
  encoding: 'utf8',
});

try {
  const saida = (unitario.stdout ?? '').trim().split('\n').at(-1);
  for (const [ok, descricao] of JSON.parse(saida)) checar(ok, descricao);
} catch {
  checar(false, 'a bateria da planilha rodou', (unitario.stderr ?? '').slice(0, 300));
}

/* ========================================================================== */
/* PixGo falsa                                                                 */
/* ========================================================================== */

const cobrancas = new Map();

const pixgoFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (pedaco) => { corpo += pedaco; });
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.headers['x-api-key'] !== CHAVE_PIX) {
      responder(401, { success: false, error: 'UNAUTHORIZED' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      const dados = JSON.parse(corpo);
      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount });
      responder(201, {
        success: true,
        data: {
          payment_id: id,
          external_id: dados.external_id,
          amount: dados.amount,
          status: 'pending',
          qr_code: '00020126-FALSO-' + id,
          expires_at: '2026-12-31T23:59:00',
        },
      });
      return;
    }

    const casa = req.url.match(/^\/api\/v1\/payment\/([^/?]+?)(?:\/status)?$/);
    if (req.method === 'GET' && casa) {
      const cobranca = cobrancas.get(decodeURIComponent(casa[1]));
      if (!cobranca) {
        responder(404, { success: false, error: 'NOT_FOUND' });
        return;
      }
      responder(200, { success: true, data: { payment_id: casa[1], status: cobranca.status, amount: cobranca.amount } });
      return;
    }

    responder(404, { success: false, error: 'NOT_FOUND' });
  });
});

await new Promise((ok) => pixgoFalsa.listen(PORTA_PIXGO, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

const senhaPainel = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');

/*
 * Pasta vazia como diretório de trabalho, de propósito: server/config.ts carrega
 * o .env.local do diretório atual com `override: true`. Rodando na raiz, este
 * teste falaria com a PixGo de verdade e criaria cobrança de dinheiro real.
 */
/*
 * Porta ocupada aborta na hora, com o motivo escrito.
 *
 * Se uma execução anterior deixou servidor órfão, o novo morre com EADDRINUSE
 * mas o health check responde -- o velho atende. A bateria seguia adiante
 * falando com o servidor errado e falhava com "senha incorreta", que manda
 * procurar defeito exatamente no lugar onde não há nenhum.
 */
const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(
    `\nA porta ${PORTA_APP} já está ocupada -- provavelmente por um servidor de teste que sobrou.\n` +
    `Encerre esse processo antes de rodar de novo.\n`,
  );
  pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'anuncios-app-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'live',
    PIXGO_API_KEY: CHAVE_PIX,
    PIXGO_WEBHOOK_SECRET: SEGREDO_PIX,
    PIXGO_BASE_URL: `http://localhost:${PORTA_PIXGO}/api/v1`,
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: senhaPainel,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    STATUS_POLL_MIN_INTERVAL_MS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

app.stderr.on('data', (d) => {
  const linha = String(d);
  if (process.env.DEPURAR || /Uncaught|TypeError|ReferenceError/.test(linha)) process.stderr.write('[app] ' + linha);
});

let subiu = false;
for (let tentativa = 0; tentativa < 60; tentativa += 1) {
  if (app.exitCode !== null) break;
  try {
    const resposta = await fetch(`${base}/api/health`);
    if (resposta.ok) { subiu = true; break; }
  } catch { /* ainda subindo */ }
  await new Promise((ok) => setTimeout(ok, 500));
}

/**
 * Mata o servidor E os filhos dele.
 *
 * No Windows o comando roda como `npx tsx ...` dentro de um shell: `app.kill()`
 * derruba só o npx e deixa o tsx — o servidor de verdade — vivo, segurando a
 * porta. A execução seguinte então falha ao subir, mas encontra a porta
 * respondendo e conversa com o processo VELHO, servindo o código antigo. O
 * sintoma é uma bateria que falha em testes que não têm nada de errado.
 */
function matarArvore() {
  if (app.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já morreu */ }
    return;
  }
  try { app.kill(); } catch { /* já morreu */ }
}

function encerrar(codigo) {
  matarArvore();
  pixgoFalsa.close();
  process.exit(codigo);
}

// O servidor morre junto com a bateria, aconteça o que acontecer.
process.on('exit', matarArvore);
process.on('uncaughtException', (erro) => {
  console.error('\nA bateria parou no meio:', erro?.message ?? erro);
  encerrar(1);
});

if (!subiu) {
  console.error('O servidor não subiu.');
  encerrar(1);
}

/*
 * `Connection: close` em toda requisição.
 *
 * Sem isso o Node reaproveita a conexão e, quando o servidor a encerra do outro
 * lado, o fetch seguinte estoura ECONNRESET no meio da bateria — uma falha de
 * transporte que se disfarça de teste quebrado e custa a tarde inteira até
 * alguém desconfiar do teste em vez do código.
 */
async function pedir(caminho, opcoes) {
  opcoes = opcoes || {};
  const resposta = await fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { Connection: 'close', ...(opcoes.headers ?? {}) },
  });
  const corpo = await resposta.json().catch(() => ({}));
  return { status: resposta.status, ...corpo };
}

const sessao = await pedir('/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: senhaPainel }),
});

const token = sessao.data?.token ?? '';
const cabecalhoAdmin = { 'X-Admin-Sessao': token, 'Content-Type': 'application/json' };
checar(Boolean(token), 'entra no painel', JSON.stringify(sessao).slice(0, 200));

/* ========================================================================== */
/* PARTE 2 — um dia de tráfego, uma venda e um gasto                           */
/* ========================================================================== */

console.log('\n== As contas da aba Anúncios ==\n');

const carimbo = {
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'RS_frio_video01',
  fb_campaign_id: '120200',
  fb_adset_id: '120300',
  fb_ad_id: '120400',
  fbclid: 'IwAR2xyz',
};

// Quatro pessoas chegam, três começam o quiz, duas veem a VSL, uma abre o
// checkout. É o funil que a tela precisa saber desenhar.
const etapas = [
  ['PageView', 4],
  ['CompleteRegistration', 3],
  ['ViewContent', 2],
  ['InitiateCheckout', 1],
];

for (const [evento, quantas] of etapas) {
  for (let i = 0; i < quantas; i += 1) {
    await pedir('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evento,
        event_id: `evt_${evento}_${i}`,
        session_id: `sessao-${i}`,
        attrib: carimbo,
      }),
    });
  }
}

// Uma venda de verdade: pedido criado e confirmado pelo callback assinado.
const criacao = await pedir('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: ['salmos_150'],
    customer: {
      name: 'Maria de Teste',
      email: 'maria@exemplo.com',
      phone: '11912345678',
      document: '52998224725',
    },
    attrib: carimbo,
    session_id: 'sessao-0',
  }),
});

checar(criacao.success === true, 'cria o pedido', JSON.stringify(criacao).slice(0, 200));

const idCobranca = [...cobrancas.keys()].at(-1);
cobrancas.get(idCobranca).status = 'completed';

const corpoWebhook = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
const segundos = Math.floor(Date.now() / 1000);
const assinatura = crypto
  .createHmac('sha256', SEGREDO_PIX)
  .update(`${segundos}.${corpoWebhook}`)
  .digest('hex');

const aviso = await pedir('/api/webhooks/pix', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': String(segundos),
    'X-Webhook-Signature': assinatura,
  },
  body: corpoWebhook,
});
checar(aviso.status === 200, 'a venda é confirmada pelo callback', String(aviso.status));

/* -------------------------------------------------------------------------- */
/* O gasto de hoje, com impressões e cliques                                    */
/* -------------------------------------------------------------------------- */

/*
 * O dia vem do servidor, não do relógio deste processo.
 *
 * Entre 21 h e a meia-noite o UTC já virou e `toISOString()` devolveria o dia
 * seguinte — a bateria anotaria o gasto num dia que a tela não mostra e
 * acusaria falha no lugar errado. É o mesmo motivo pelo qual o painel também
 * passou a perguntar ao servidor qual dia é hoje.
 */
const previa = await pedir('/api/admin/anuncios?dias=1', { headers: { 'X-Admin-Sessao': token } });
const diaDeHoje = previa.data?.periodo?.diaDeHoje ?? new Date().toISOString().slice(0, 10);
checar(/^\d{4}-\d{2}-\d{2}$/.test(diaDeHoje), `o painel informa qual dia ele chama de hoje (veio ${diaDeHoje})`);
checar(
  previa.data?.periodo?.diaInicial === diaDeHoje && previa.data?.periodo?.diaFinal === diaDeHoje,
  'no período "Hoje" o primeiro e o último dia são hoje',
);

/** Aritmética de calendário, sem passar por fuso nenhum. */
function maisDias(dia, delta) {
  const [ano, mes, resto] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, resto + delta)).toISOString().slice(0, 10);
}

const diaDeOntem = maisDias(diaDeHoje, -1);
const diaAntigo = maisDias(diaDeHoje, -10);

async function anotar(dia, corpo) {
  return pedir('/api/admin/investimento', {
    method: 'POST',
    headers: cabecalhoAdmin,
    body: JSON.stringify({ chave: carimbo.fb_campaign_id, dia, ...corpo }),
  });
}

// R$ 20,00 · 10.000 impressões · 250 cliques.
const anotado = await anotar(diaDeHoje, { valor: '20,00', impressoes: 10000, cliques: 250 });
checar(anotado.success === true, 'anota gasto, impressões e cliques de hoje', JSON.stringify(anotado).slice(0, 200));
checar(anotado.data?.impressoes === 10000 && anotado.data?.cliques === 250, 'guarda as três contagens juntas');

/*
 * Dez dias atrás: FORA da janela de 7 dias, DENTRO da de 14. É o caso que prova
 * que o período anterior não vaza para o número de hoje — a mentira mais cara
 * que esta tela poderia contar.
 *
 * Sem impressões nem cliques de propósito: é assim que fica a conta de quem só
 * anota o gasto, e é dela que sai a checagem de divisão por zero, mais abaixo.
 */
await anotar(diaAntigo, { valor: '999,00' });

const painel = await pedir('/api/admin/anuncios?dias=7&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});

const dados = painel.data ?? {};
const linha = (dados.linhas ?? []).find((item) => item.chave === carimbo.fb_campaign_id);

checar(Boolean(linha), 'a campanha aparece na tabela');

/* -------------------------------------------------------------------------- */
/* Tráfego: CTR, CPC, CPM                                                       */
/* -------------------------------------------------------------------------- */

checar(linha?.impressoes === 10000, `traz as impressões (veio ${linha?.impressoes})`);
checar(linha?.cliques === 250, `traz os cliques (veio ${linha?.cliques})`);
// 250 / 10.000 = 2,5%
checar(perto(linha?.ctr, 0.025), `CTR = cliques ÷ impressões (veio ${linha?.ctr})`);
// R$ 20,00 / 250 = R$ 0,08
checar(perto(linha?.cpcCentavos, 8), `CPC = gasto ÷ cliques (veio ${linha?.cpcCentavos})`);
/*
 * CPM é por MIL impressões: 2000 centavos / 10.000 × 1000 = 200 centavos.
 * Esquecer o × 1000 daria R$ 0,02 e faria qualquer campanha parecer baratíssima.
 */
checar(perto(linha?.cpmCentavos, 200), `CPM = gasto por mil impressões (veio ${linha?.cpmCentavos})`);
// R$ 20,00 / 4 visitas = R$ 5,00
checar(perto(linha?.custoPorVisitaCentavos, 500), `custo por visita (veio ${linha?.custoPorVisitaCentavos})`);

/* -------------------------------------------------------------------------- */
/* Resultado: ROAS, custo por venda, lucro, ticket                              */
/* -------------------------------------------------------------------------- */

checar(linha?.vendas === 1, `conta a venda (veio ${linha?.vendas})`);
checar(linha?.receitaCentavos === 7400, `soma a receita de 47,00 + 27,00 (veio ${linha?.receitaCentavos})`);
// 7400 / 2000 = 3,7
checar(perto(linha?.roas, 3.7), `ROAS = receita ÷ investido (veio ${linha?.roas})`);
checar(perto(linha?.cpaCentavos, 2000), `custo por venda (veio ${linha?.cpaCentavos})`);
checar(linha?.lucroCentavos === 5400, `lucro = receita − investido (veio ${linha?.lucroCentavos})`);
checar(perto(linha?.ticketCentavos, 7400), `ticket médio (veio ${linha?.ticketCentavos})`);

/* -------------------------------------------------------------------------- */
/* Funil                                                                        */
/* -------------------------------------------------------------------------- */

checar(linha?.visitas === 4, `conta as visitas (veio ${linha?.visitas})`);
checar(linha?.quiz === 3, `conta quem começou o quiz (veio ${linha?.quiz})`);
checar(linha?.vsl === 2, `conta quem chegou na VSL (veio ${linha?.vsl})`);
checar(linha?.checkout === 1, `conta quem abriu o checkout (veio ${linha?.checkout})`);
checar(perto(linha?.conversao, 0.25), `conversão visita→venda (veio ${linha?.conversao})`);

/* -------------------------------------------------------------------------- */
/* O período anterior não pode vazar para o de hoje                             */
/* -------------------------------------------------------------------------- */

checar(
  linha?.investimentoCentavos === 2000,
  `o gasto de 10 dias atrás NÃO entra no total de hoje (veio ${linha?.investimentoCentavos})`,
);
checar(
  dados.anterior?.investimentoCentavos === 99900,
  `o gasto antigo aparece como período anterior (veio ${dados.anterior?.investimentoCentavos})`,
);
checar(dados.totais?.vendas === 1, `o total soma as vendas do período (veio ${dados.totais?.vendas})`);
checar(dados.anterior?.vendas === 0, `o período anterior não tem venda nenhuma (veio ${dados.anterior?.vendas})`);

/* -------------------------------------------------------------------------- */
/* Divisão por zero nunca vira zero                                             */
/* -------------------------------------------------------------------------- */

const semNada = dados.anterior ?? {};
checar(semNada.ctr === null, 'sem impressões, o CTR é "sem base" e não 0%');
checar(semNada.cpaCentavos === null, 'sem venda, o custo por venda é "sem base" e não R$ 0,00');
checar(semNada.ticketCentavos === null, 'sem venda, o ticket é "sem base" e não R$ 0,00');

/* ========================================================================== */
/* PARTE 3 — "Hoje" é hoje                                                     */
/* ========================================================================== */

console.log('\n== O período "Hoje" ==\n');

// R$ 50,00 gastos ONTEM. Em "Hoje" isso não pode aparecer; em "7 dias", sim.
await anotar(diaDeOntem, { valor: '50,00' });

const soHoje = await pedir('/api/admin/anuncios?dias=1&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
const linhaDeHoje = (soHoje.data?.linhas ?? []).find((item) => item.chave === carimbo.fb_campaign_id);

checar(
  linhaDeHoje?.investimentoCentavos === 2000,
  `em "Hoje" só entra o gasto de hoje (veio ${linhaDeHoje?.investimentoCentavos})`,
);
checar(
  soHoje.data?.anterior?.investimentoCentavos === 5000,
  `o gasto de ontem aparece como período anterior (veio ${soHoje.data?.anterior?.investimentoCentavos})`,
);

const seteDias = await pedir('/api/admin/anuncios?dias=7&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
const linhaDeSete = (seteDias.data?.linhas ?? []).find((item) => item.chave === carimbo.fb_campaign_id);
checar(
  linhaDeSete?.investimentoCentavos === 7000,
  `em "7 dias" o gasto de ontem soma ao de hoje (veio ${linhaDeSete?.investimentoCentavos})`,
);
checar(
  seteDias.data?.periodo?.diaInicial === maisDias(diaDeHoje, -6),
  `"7 dias" começa seis dias antes de hoje (veio ${seteDias.data?.periodo?.diaInicial})`,
);

/* ========================================================================== */
/* PARTE 4 — o funil não pode inverter                                         */
/* ========================================================================== */

console.log('\n== O funil não inverte ==\n');

/*
 * Esta é a queixa que a tela recebia: "quem entrou na próxima etapa não consta
 * na anterior". Ela tem três causas, e as três aparecem aqui.
 */

const campanhaB = '120900';
const carimboB = {
  utm_source: 'facebook',
  utm_campaign: 'RS_teste_funil',
  fb_campaign_id: campanhaB,
  fb_ad_id: '120901',
  fbclid: 'IwARfunil',
};

async function marcar(evento, sessao, attrib) {
  return pedir('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evento,
      event_id: `evt_${evento}_${sessao}`,
      session_id: sessao,
      attrib: attrib ?? {},
    }),
  });
}

/*
 * Causa 1 — o PageView não chegou.
 *
 * Bloqueador de anúncio, aba fechada antes de a requisição sair, celular
 * trocando de antena. A pessoa terminou o quiz e abriu o checkout, então ela
 * visitou o site: contá-la só no checkout produzia passagem acima de 100 %.
 */
await marcar('CompleteRegistration', 'sem-pageview', carimboB);
await marcar('InitiateCheckout', 'sem-pageview', carimboB);

/*
 * Causa 2 — o carimbo sumiu no meio da visita.
 *
 * A origem viaja no localStorage e pode se perder entre uma tela e outra. Antes
 * a MESMA pessoa era visita do anúncio e checkout de "(sem origem)".
 */
await marcar('PageView', 'carimbo-sumiu', carimboB);
await marcar('InitiateCheckout', 'carimbo-sumiu', {});

const funilB = await pedir(`/api/admin/anuncios?dias=1&agrupamento=campanha`, {
  headers: { 'X-Admin-Sessao': token },
});
const linhaB = (funilB.data?.linhas ?? []).find((item) => item.chave === campanhaB);

checar(linhaB?.visitas === 2, `quem perdeu o PageView continua sendo visita (veio ${linhaB?.visitas})`);
checar(linhaB?.quiz === 2, `quem chegou ao checkout consta no quiz (veio ${linhaB?.quiz})`);
checar(linhaB?.vsl === 2, `quem chegou ao checkout consta na VSL (veio ${linhaB?.vsl})`);
checar(linhaB?.checkout === 2, `as duas sessões abriram o checkout (veio ${linhaB?.checkout})`);

const semOrigem = (funilB.data?.linhas ?? []).find((item) => item.chave === '');
checar(
  !semOrigem || semOrigem.checkout === 0,
  `a sessão com carimbo perdido não vira uma linha "(sem origem)" (veio ${semOrigem?.checkout})`,
);

/*
 * Causa 3 — o pedido chega sem carimbo.
 *
 * A venda existe, o dinheiro entrou, e ela caía em "(sem origem)" enquanto as
 * visitas ficavam na campanha. O `session_id` do pedido é a ponte.
 */
const vendaOrfa = await pedir('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    customer: {
      name: 'Jose de Teste',
      email: 'jose@exemplo.com',
      phone: '11987654321',
      document: '52998224725',
    },
    attrib: {},
    session_id: 'carimbo-sumiu',
  }),
});
checar(vendaOrfa.success === true, 'cria o pedido sem carimbo', JSON.stringify(vendaOrfa).slice(0, 200));

const cobrancaOrfa = [...cobrancas.keys()].at(-1);
cobrancas.get(cobrancaOrfa).status = 'completed';

const corpoOrfa = JSON.stringify({ event: 'payment.completed', payment_id: cobrancaOrfa, status: 'completed' });
const segundosOrfa = Math.floor(Date.now() / 1000);
await pedir('/api/webhooks/pix', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': String(segundosOrfa),
    'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${segundosOrfa}.${corpoOrfa}`).digest('hex'),
  },
  body: corpoOrfa,
});

const comVenda = await pedir('/api/admin/anuncios?dias=1&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
const linhaComVenda = (comVenda.data?.linhas ?? []).find((item) => item.chave === campanhaB);

checar(linhaComVenda?.vendas === 1, `a venda sem carimbo volta para a campanha certa (veio ${linhaComVenda?.vendas})`);
checar(linhaComVenda?.pixGerados === 1, `o Pix gerado também (veio ${linhaComVenda?.pixGerados})`);

/*
 * Causa 4 — venda sem evento nenhum.
 *
 * Acontece quando o rastreamento do navegador falha do começo ao fim e só o
 * pedido chega ao banco. O funil não pode mostrar "0 visitas, 1 venda": o
 * pagamento prova que a pessoa passou por todas as telas.
 */
const campanhaC = '120990';
const vendaCega = await pedir('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    customer: {
      name: 'Ana de Teste',
      email: 'ana@exemplo.com',
      phone: '11911112222',
      document: '52998224725',
    },
    attrib: { utm_source: 'facebook', utm_campaign: 'RS_sem_evento', fb_campaign_id: campanhaC },
  }),
});
checar(vendaCega.success === true, 'cria o pedido sem evento nenhum de funil');

const listaCega = await pedir('/api/admin/anuncios?dias=1&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
const linhaCega = (listaCega.data?.linhas ?? []).find((item) => item.chave === campanhaC);

checar(linhaCega?.pixGerados === 1, `o Pix aparece mesmo sem evento (veio ${linhaCega?.pixGerados})`);
checar(
  linhaCega?.checkout >= 1 && linhaCega?.vsl >= 1 && linhaCega?.quiz >= 1 && linhaCega?.visitas >= 1,
  `um Pix gerado preenche as etapas anteriores (veio ${JSON.stringify({
    visitas: linhaCega?.visitas,
    quiz: linhaCega?.quiz,
    vsl: linhaCega?.vsl,
    checkout: linhaCega?.checkout,
  })})`,
);

// A regra, valendo para a tabela inteira e para o rodapé de totais.
const emOrdem = (n) =>
  n.visitas >= n.quiz && n.quiz >= n.vsl && n.vsl >= n.checkout && n.checkout >= n.pixGerados && n.pixGerados >= n.vendas;

checar(
  (listaCega.data?.linhas ?? []).every(emOrdem),
  'nenhuma linha tem etapa maior que a anterior',
);
checar(emOrdem(listaCega.data?.totais ?? {}), 'o total também respeita a ordem do funil');

/* -------------------------------------------------------------------------- */
/* Meta de retorno                                                              */
/* -------------------------------------------------------------------------- */

console.log('\n== Meta de retorno ==\n');

checar(dados.metaRoas === 2, `a meta começa em 2x (veio ${dados.metaRoas})`);

const salva = await pedir('/api/admin/anuncios/meta-roas', {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ valor: '2,5' }),
});
checar(salva.data?.metaRoas === 2.5, `aceita vírgula decimal (veio ${salva.data?.metaRoas})`);

const recusada = await pedir('/api/admin/anuncios/meta-roas', {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ valor: '0' }),
});
checar(recusada.success === false, 'recusa meta zero, que aprovaria qualquer prejuízo');

const depois = await pedir('/api/admin/anuncios?dias=7', {
  headers: { 'X-Admin-Sessao': token },
});
checar(depois.data?.metaRoas === 2.5, `a meta salva volta na tabela (veio ${depois.data?.metaRoas})`);

const semSessao = await pedir('/api/admin/anuncios/meta-roas', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ valor: '3' }),
});
checar(semSessao.status === 401, `mudar a meta exige login (veio ${semSessao.status})`);

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
