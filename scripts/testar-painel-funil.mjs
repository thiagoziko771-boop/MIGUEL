/**
 * Testa a aba Funil: onde as pessoas param entre abrir o site e pagar.
 *
 *   node scripts/testar-painel-funil.mjs
 *
 * Por que uma bateria só para isto: esta tela existe para mandar o dono mexer
 * numa tela específica do funil. Se ela apontar a pergunta errada, ele reescreve
 * uma tela que estava funcionando e piora o que estava bom — e não tem como
 * perceber, porque o número continua aparecendo com a mesma confiança.
 *
 * Duas partes. A primeira fala com o repositório direto, porque duas contas não
 * podem ser alcançadas pela API: o abandono depende de eventos com mais de 30
 * minutos, e pela rota HTTP o carimbo de tempo é sempre "agora". A segunda sobe
 * o servidor inteiro e confere a resposta que a tela realmente recebe.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_PIXGO = 3397;
const PORTA_APP = 3341;
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

/* ========================================================================== */
/* PARTE 1 — a agregação, com o relógio na mão                                 */
/* ========================================================================== */

console.log('\n== A conta do funil ==\n');

const pastaTemp = mkdtempSync(path.join(tmpdir(), 'funil-teste-'));
const arquivoUnitario = path.join(pastaTemp, 'funil.test.mts');
const moduloRepositorio = pathToFileURL(path.join(raiz, 'server/painel/repositorio.ts')).href;

writeFileSync(
  arquivoUnitario,
  `
import { criarRepositorioEmMemoria } from ${JSON.stringify(moduloRepositorio)};

const resultados: Array<[boolean, string]> = [];
const checar = (ok: boolean, descricao: string) => resultados.push([ok, descricao]);

const repo = criarRepositorioEmMemoria();
const agora = Date.now();

async function passar(sessao: string, ateAEtapa: number, pedidoId: string | null = null) {
  for (let step = 0; step <= ateAEtapa; step += 1) {
    await repo.registrarEventoDoFunil({
      sessionId: sessao,
      pedidoId,
      evento: step === 0 ? 'PageView' : step === 13 ? 'ViewContent' : 'EtapaDoFunil',
      step,
      atribuicao: {},
    });
  }
}

// Dez pessoas entram. Sete passam da primeira pergunta, quatro chegam aos
// depoimentos, duas veem a oferta. A perda maior esta entre a 1 e a 2.
await passar('s1', 0);
await passar('s2', 0);
await passar('s3', 0);
await passar('s4', 1);
await passar('s5', 1);
await passar('s6', 1);
await passar('s7', 11);
await passar('s8', 11);
await passar('s9', 13);
await passar('s10', 13, 'pedido-1');

const resumo = await repo.resumoDoFunil({
  desde: new Date(agora - 3600_000).toISOString(),
  ate: new Date(agora + 3600_000).toISOString(),
  agoraMs: agora,
});

checar(resumo.sessoes === 10, 'conta as dez sessoes (veio ' + resumo.sessoes + ')');
checar(resumo.etapas.length === 14, 'devolve as catorze telas do funil (veio ' + resumo.etapas.length + ')');
checar(resumo.etapas[0].alcancaram === 10, 'todas passaram pela tela 0 (veio ' + resumo.etapas[0].alcancaram + ')');
checar(resumo.etapas[1].alcancaram === 7, 'sete chegaram na pergunta 1 (veio ' + resumo.etapas[1].alcancaram + ')');
checar(resumo.etapas[2].alcancaram === 4, 'quatro passaram para a pergunta 2 (veio ' + resumo.etapas[2].alcancaram + ')');
checar(resumo.etapas[11].alcancaram === 4, 'quatro chegaram nos depoimentos (veio ' + resumo.etapas[11].alcancaram + ')');
checar(resumo.etapas[13].alcancaram === 2, 'duas chegaram na oferta (veio ' + resumo.etapas[13].alcancaram + ')');
checar(resumo.etapas[0].pararam === 3, 'tres pararam logo na entrada (veio ' + resumo.etapas[0].pararam + ')');

// O funil e cumulativo por definicao: cada tela tem de ser menor ou igual a
// anterior. Uma inversao aqui significaria que a conta perdeu alguem no meio.
let emOrdem = true;
for (let i = 1; i < resumo.etapas.length; i += 1) {
  if (resumo.etapas[i].alcancaram > resumo.etapas[i - 1].alcancaram) emOrdem = false;
}
checar(emOrdem, 'nenhuma tela tem mais gente que a anterior');

/* --- Abandono: so conta quem sumiu ha mais de 30 min e nao pagou --- */

const semAbandono = await repo.resumoDoFunil({
  desde: new Date(agora - 3600_000).toISOString(),
  ate: new Date(agora + 3600_000).toISOString(),
  agoraMs: agora,
});
checar(
  semAbandono.abandono.length === 0,
  'quem acabou de parar NAO conta como abandono (veio ' + semAbandono.abandono.length + ' etapa(s))',
);

// O mesmo conjunto, olhado meia hora depois: agora sim.
const depois = await repo.resumoDoFunil({
  desde: new Date(agora - 3600_000).toISOString(),
  ate: new Date(agora + 3600_000).toISOString(),
  agoraMs: agora + 31 * 60_000,
});
const total = depois.abandono.reduce((soma, linha) => soma + linha.sessoes, 0);
checar(total === 9, 'meia hora depois, nove viraram abandono (veio ' + total + ')');
checar(
  !depois.abandono.some((linha) => linha.step === 13 && linha.sessoes > 1),
  'quem tem pedido nao entra no abandono, mesmo parado',
);
checar(
  depois.abandono[0].step === 0 && depois.abandono[0].sessoes === 3,
  'a lista comeca pela etapa que mais perdeu (veio etapa ' + depois.abandono[0].step + ')',
);

/* --- O funil sabe quando NAO pode falar sobre o quiz --- */

checar(
  resumo.sessoesComTelasDoMeio === 7,
  'conta quantas sessoes foram medidas tela a tela (veio ' + resumo.sessoesComTelasDoMeio + ')',
);

/*
 * Uma visita do tempo em que so havia tres marcos: entrou, terminou o quiz, viu
 * a VSL. O acumulado a distribui por todas as perguntas -- e esta certo, e a
 * melhor leitura possivel --, mas a tela precisa saber que nao mediu nada ali,
 * senao mostra nove perguntas iguais e parece que o quiz nao perde ninguem.
 */
const repoAntigo = criarRepositorioEmMemoria();
for (const sessao of ['velha-1', 'velha-2']) {
  await repoAntigo.registrarEventoDoFunil({ sessionId: sessao, evento: 'PageView', step: 0, atribuicao: {} });
  await repoAntigo.registrarEventoDoFunil({ sessionId: sessao, evento: 'CompleteRegistration', step: 12, atribuicao: {} });
}
const antigo = await repoAntigo.resumoDoFunil({
  desde: new Date(agora - 3600_000).toISOString(),
  ate: new Date(agora + 3600_000).toISOString(),
  agoraMs: agora,
});
checar(antigo.sessoes === 2, 'as visitas antigas continuam contando (veio ' + antigo.sessoes + ')');
checar(
  antigo.etapas[5].alcancaram === 2,
  'e continuam aparecendo nas telas do meio, por deducao (veio ' + antigo.etapas[5].alcancaram + ')',
);
checar(
  antigo.sessoesComTelasDoMeio === 0,
  'mas nenhuma delas foi medida tela a tela (veio ' + antigo.sessoesComTelasDoMeio + ')',
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
  checar(false, 'a bateria da agregacao rodou', (unitario.stderr ?? '').slice(0, 400));
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

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- provavelmente por um servidor de teste que sobrou.\n`);
  pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'funil-app-'));
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

function matarArvore() {
  if (app.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
    return;
  }
  try { app.kill(); } catch { /* ja morreu */ }
}

function encerrar(codigo) {
  matarArvore();
  pixgoFalsa.close();
  process.exit(codigo);
}

process.on('exit', matarArvore);
process.on('uncaughtException', (erro) => {
  console.error('\nA bateria parou no meio:', erro?.message ?? erro);
  encerrar(1);
});

if (!subiu) {
  console.error('O servidor nao subiu.');
  encerrar(1);
}

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
checar(Boolean(token), 'entra no painel');

/* ========================================================================== */
/* PARTE 2 — a rota que a tela consome                                         */
/* ========================================================================== */

console.log('\n== A rota /admin/funil ==\n');

async function marcar(sessao, evento, step) {
  return pedir('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      evento,
      event_id: `evt_${sessao}_${evento}_${step}`,
      session_id: sessao,
      step,
      attrib: { utm_source: 'facebook', utm_campaign: 'RS_funil' },
    }),
  });
}

/*
 * O evento das telas do meio precisa ser aceito pela rota publica -- ele e novo
 * na lista branca, e sem ele o funil volta a ter um buraco de onze telas.
 */
const etapaAceita = await marcar('rota-1', 'EtapaDoFunil', 4);
checar(etapaAceita.status === 204, `a rota aceita EtapaDoFunil (veio ${etapaAceita.status})`);

// Quatro pessoas: uma para na entrada, uma na pergunta 4, duas chegam na oferta.
await marcar('rota-a', 'PageView', 0);
for (const step of [0, 1, 2, 3, 4]) await marcar('rota-b', step === 0 ? 'PageView' : 'EtapaDoFunil', step);
for (const sessao of ['rota-c', 'rota-d']) {
  for (const step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    await marcar(sessao, step === 0 ? 'PageView' : 'EtapaDoFunil', step);
  }
  await marcar(sessao, 'ViewContent', 13);
}

// Uma delas compra de verdade.
const criacao = await pedir('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Maria de Teste', email: 'maria@exemplo.com', phone: '11912345678', document: '52998224725' },
    session_id: 'rota-c',
  }),
});
checar(criacao.success === true, 'cria o pedido', JSON.stringify(criacao).slice(0, 200));

const idCobranca = [...cobrancas.keys()].at(-1);
cobrancas.get(idCobranca).status = 'completed';
const corpoWebhook = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
const segundos = Math.floor(Date.now() / 1000);
await pedir('/api/webhooks/pix', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': String(segundos),
    'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${segundos}.${corpoWebhook}`).digest('hex'),
  },
  body: corpoWebhook,
});

const painel = await pedir('/api/admin/funil?dias=1', { headers: { 'X-Admin-Sessao': token } });
const dados = painel.data ?? {};
const etapas = dados.etapas ?? [];

checar(painel.status === 200, `a rota responde (veio ${painel.status})`);
checar(dados.sessoes === 5, `conta as cinco sessoes (veio ${dados.sessoes})`);
checar(etapas.length === 14, `traz as catorze telas (veio ${etapas.length})`);
checar(etapas[0]?.nome === 'Abriu o site', `a tela 0 tem nome de gente (veio ${etapas[0]?.nome})`);
checar(etapas[7]?.nome === 'Áudio da Irmã Maria', `a tela 7 e o audio (veio ${etapas[7]?.nome})`);
/*
 * Quatro, e nao tres: a sessao usada acima para provar que a rota aceita o
 * evento novo tambem entrou no funil, com step 4.
 *
 * E ela expoe de proposito um comportamento que precisa continuar valendo: essa
 * sessao registrou UM evento so, direto na tela 4, e mesmo assim conta como
 * tendo passado pelas telas anteriores. E a mesma regra da aba Anuncios --
 * ninguem chega na pergunta 4 sem passar pelas tres primeiras, e um evento
 * perdido no meio nao pode furar o funil.
 */
checar(etapas[4]?.alcancaram === 4, `quatro chegaram na pergunta 4 (veio ${etapas[4]?.alcancaram})`);
checar(etapas[13]?.alcancaram === 2, `duas chegaram na oferta (veio ${etapas[13]?.alcancaram})`);
checar(etapas[0]?.passagem === null, 'a primeira tela nao tem taxa de passagem');
checar(
  etapas[1]?.passagem !== null && Math.abs(etapas[1].passagem - 4 / 5) < 0.001,
  `a passagem da tela 1 e 4 de 5 (veio ${etapas[1]?.passagem})`,
);

// A verdade financeira vem dos pedidos, nao dos eventos.
checar(dados.checkout?.pixGerados === 1, `um Pix gerado (veio ${dados.checkout?.pixGerados})`);
checar(dados.checkout?.pagos === 1, `um pagamento (veio ${dados.checkout?.pagos})`);
checar(dados.checkout?.naoPagaramOPix === 0, `ninguem ficou devendo (veio ${dados.checkout?.naoPagaramOPix})`);
checar(
  Math.abs((dados.conversao?.visitaAteVenda ?? 0) - 1 / 5) < 0.001,
  `conversao de visita a venda e 1 em 5 (veio ${dados.conversao?.visitaAteVenda})`,
);
checar(dados.amostraPequena === true, 'com cinco pessoas, avisa que a amostra e pequena');
checar(
  dados.quizSemMedicao === false,
  'com as telas do meio medidas, NAO avisa que falta medicao (veio ' + dados.quizSemMedicao + ')',
);
checar(
  dados.periodo?.diaInicial === dados.periodo?.diaFinal,
  'no periodo "Hoje" o primeiro e o ultimo dia sao o mesmo',
);

const semSessao = await pedir('/api/admin/funil?dias=1');
checar(semSessao.status === 401, `a aba exige login (veio ${semSessao.status})`);

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
