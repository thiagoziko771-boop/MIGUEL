/**
 * Testa o envio de pedidos à Utmify sem falar com a Utmify de verdade.
 *
 *   node scripts/testar-utmify.mjs
 *
 * Sobe uma Utmify falsa, aponta o funil para ela e confere o que sai.
 *
 * O CASO QUE PAGA A BATERIA: a doc deles avisa que pedido com mais de 7 dias
 * "pode resultar em bloqueio" da credencial. A reconciliação varre pedidos
 * antigos, então sem uma guarda de idade uma varredura de rotina tentaria
 * reenviar um PIX de agosto em outubro — e o castigo não seria um 400, seria o
 * painel inteiro parando de receber.
 *
 * O SEGUNDO: as datas vão em UTC 0. A Vercel roda em UTC e a máquina do dono em
 * horário de Brasília; um formatador dependente de fuso mandaria a venda três
 * horas no passado sem ninguém notar, e só as vendas da madrugada fechariam no
 * dia errado.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_APP = 3341;
const PORTA_UTMIFY = 3404;
const TOKEN = 'token-de-teste-' + crypto.randomBytes(8).toString('hex');

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/* CPF novo por caso: o servidor reaproveita cobrança pendente do mesmo CPF, e
 * repetir faria o caso seguinte medir o reaproveitamento em vez do envio. */
let proximoCpf = 0;
function cpfDeTeste(n) {
  const base = String(100000000 + (n * 7919) % 800000000).slice(0, 9).split('').map(Number);
  for (let r = 0; r < 2; r += 1) {
    const peso = base.length + 1;
    const soma = base.reduce((acc, d, i) => acc + d * (peso - i), 0);
    const resto = (soma * 10) % 11;
    base.push(resto === 10 ? 0 : resto);
  }
  return base.join('');
}

/* ========================================================================== */
/* A Utmify falsa                                                              */
/* ========================================================================== */

const recebidos = [];
let comoResponder = 'ok'; // 'ok' | 'erro' | 'lento'

const utmify = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    let dados = {};
    try { dados = corpo ? JSON.parse(corpo) : {}; } catch { /* segue vazio */ }
    recebidos.push({ token: req.headers['x-api-token'], corpo: dados });

    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (comoResponder === 'erro') return responder(400, { message: 'INVALID_PAYLOAD' });
    if (comoResponder === 'lento') { setTimeout(() => responder(200, { ok: true }), 8000); return; }
    return responder(200, { ok: true });
  });
});
await new Promise((ok) => utmify.listen(PORTA_UTMIFY, ok));

/* ========================================================================== */
/* O funil                                                                     */
/* ========================================================================== */

const ocupada = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`).then(() => true).catch(() => false);
if (ocupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- servidor de teste que sobrou.\n`);
  utmify.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'utmify-teste-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    /* Confirma rapido: o caso do `paid` precisa da cobranca virar paga sozinha. */
    MOCK_CONFIRM_DELAY_MS: '1500',
    UTMIFY_API_TOKEN: TOKEN,
    UTMIFY_BASE_URL: `http://127.0.0.1:${PORTA_UTMIFY}/api-credentials/orders`,
    META_TRACKING_ENABLED: 'false',
    EMAIL_API_KEY: '',
    DISCORD_WEBHOOK_APROVADA: '',
    DISCORD_WEBHOOK_PENDENTE: '',
    ADMIN_SENHA: 'senha-de-teste-' + crypto.randomBytes(4).toString('hex'),
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    RATE_LIMIT_MAX_ORDERS: '500',
    STATUS_POLL_MIN_INTERVAL_MS: '0',
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    PUBLIC_BASE_URL: `http://127.0.0.1:${PORTA_APP}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let erroDoApp = '';
app.stderr.on('data', (d) => { erroDoApp += String(d); if (process.env.DEPURAR) process.stderr.write('[app] ' + d); });

let subiu = false;
for (let i = 0; i < 60; i += 1) {
  if (app.exitCode !== null) break;
  try {
    if ((await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`)).ok) { subiu = true; break; }
  } catch { /* subindo */ }
  await new Promise((ok) => setTimeout(ok, 500));
}

function encerrar(codigo) {
  if (app?.pid && process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
  } else if (app) {
    app.kill();
  }
  utmify.close();
  process.exit(codigo);
}

if (!subiu) {
  console.error('\nO servidor nao subiu.\n' + erroDoApp.slice(-1000));
  encerrar(1);
}

const base = `http://127.0.0.1:${PORTA_APP}`;

async function criarPedido(atrib) {
  const document = cpfDeTeste(proximoCpf);
  proximoCpf += 1;
  return fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      bumps: [],
      customer: { name: 'Maria de Teste', email: 'maria.utmify@gmail.com', phone: '11988887777', document },
      attrib: atrib,
    }),
  }).then((r) => r.json());
}

/* ========================================================================== */
console.log('\n== O PIX gerado ja vai para a Utmify ==\n');

recebidos.length = 0;
const criado = await criarPedido({
  bm: 'bm2',
  utm_source: 'FB',
  utm_campaign: 'CTV_TESTE',
  utm_medium: 'CONJUNTO_A',
  utm_content: 'ANUNCIO_07',
  utm_term: 'Instagram_Reels',
  fb_campaign_id: '120249664661600055',
  fb_adset_id: '120249664661600056',
  fb_ad_id: '120249664661600057',
});
checar(criado.success === true, 'o pedido foi criado', JSON.stringify(criado).slice(0, 160));

const pendente = recebidos.at(-1);
checar(Boolean(pendente), `a Utmify recebeu o pedido (${recebidos.length} recebido(s))`);
checar(pendente?.token === TOKEN, 'com o token no header x-api-token');

const p = pendente?.corpo ?? {};
checar(p.status === 'waiting_payment', `o status e waiting_payment (veio ${p.status})`);
checar(p.orderId === criado.data?.id, 'o orderId e o nosso id de pedido');
checar(p.paymentMethod === 'pix', 'a forma de pagamento e pix');
checar(p.platform === 'MiguelTeChama', `a plataforma se identifica (veio ${p.platform})`);
checar(p.approvedDate === null, 'sem pagamento, approvedDate e null');
checar(p.refundedAt === null, 'e refundedAt tambem');

/* ------------------------------------------------------------------ datas -- */
checar(
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(p.createdAt)),
  `createdAt no formato "YYYY-MM-DD HH:MM:SS" (veio ${p.createdAt})`,
);
/*
 * A prova do fuso: a data enviada tem de bater com o ISO em UTC do proprio
 * pedido. Comparar com "agora" passaria mesmo com tres horas de erro, porque
 * o teste roda no mesmo instante da criacao.
 */
const esperada = new Date(criado.data.createdAt ?? Date.now()).toISOString().slice(0, 19).replace('T', ' ');
checar(
  p.createdAt === esperada || Math.abs(Date.parse(p.createdAt + 'Z') - Date.parse(criado.data.createdAt ?? '')) < 2000,
  `a data esta em UTC 0, nao no fuso da maquina (enviada ${p.createdAt}, esperada ~${esperada})`,
);

/* ------------------------------------------------------------ atribuicao --- */
checar(p.trackingParameters?.utm_source === 'FB', 'o utm_source vai junto');
checar(
  p.trackingParameters?.utm_campaign === 'CTV_TESTE|120249664661600055',
  'campanha vai no formato NOME|ID, que e o que liga ao Gerenciador',
  JSON.stringify(p.trackingParameters),
);
checar(
  p.trackingParameters?.utm_medium === 'CONJUNTO_A|120249664661600056'
  && p.trackingParameters?.utm_content === 'ANUNCIO_07|120249664661600057',
  'conjunto e anuncio idem',
  JSON.stringify(p.trackingParameters),
);
checar(p.trackingParameters?.src === null && p.trackingParameters?.sck === null, 'src e sck vao como null, e nao ausentes');

/* -------------------------------------------------------------- cliente ---- */
checar(p.customer?.email === 'maria.utmify@gmail.com', 'o e-mail do cliente vai');
checar(p.customer?.country === 'BR', 'o pais vai como BR');
checar(String(p.customer?.document ?? '').length === 11, 'o CPF vai (a Utmify e o painel do dono, nao um canal publico)');

/* ------------------------------------------------------------- produtos ---- */
checar(Array.isArray(p.products) && p.products.length >= 1, 'os produtos vao na lista');
checar(p.products?.[0]?.priceInCents === 4700, `o preco vai em CENTAVOS (veio ${p.products?.[0]?.priceInCents})`);
checar(typeof p.products?.[0]?.name === 'string' && p.products[0].name.length > 3, 'com o nome do catalogo');

/* ------------------------------------------------------------- comissao ---- */
checar(p.commission?.totalPriceInCents === 4700, 'o total vai em centavos');
checar(
  p.commission?.userCommissionInCents === 4700 - (p.commission?.gatewayFeeInCents ?? 0),
  'a comissao do vendedor e o total menos a taxa',
  JSON.stringify(p.commission),
);
checar(
  p.commission?.userCommissionInCents > 0,
  'e nunca e zero, que a doc trata como venda sem receita',
  JSON.stringify(p.commission),
);

/* ========================================================================== */
console.log('\n== O pagamento atualiza a MESMA linha ==\n');

recebidos.length = 0;
/* O mock confirma em 1,5 s; a consulta de status e o que aplica o pagamento. */
await new Promise((ok) => setTimeout(ok, 2500));
await fetch(`${base}/api/orders/${criado.data.id}`).then((r) => r.json());
await new Promise((ok) => setTimeout(ok, 600));

const pago = recebidos.map((r) => r.corpo).find((c) => c.status === 'paid');
checar(Boolean(pago), `a Utmify recebeu o pedido pago (${recebidos.length} recebido(s))`);
checar(pago?.orderId === criado.data.id, 'com o MESMO orderId: atualiza a linha, nao cria outra');
checar(Boolean(pago?.approvedDate), `approvedDate preenchido (veio ${pago?.approvedDate})`);
checar(
  pago?.createdAt === p.createdAt,
  'e o createdAt e o MESMO do envio anterior, como a doc exige',
  `antes ${p.createdAt}, agora ${pago?.createdAt}`,
);

/* ========================================================================== */
console.log('\n== A Utmify nunca derruba uma venda ==\n');

comoResponder = 'erro';
const comErro = await criarPedido({ bm: 'bm1' });
checar(comErro.success === true, 'Utmify devolvendo 400 nao impede a cobranca de nascer');

comoResponder = 'lento';
const antes = Date.now();
const comLentidao = await criarPedido({ bm: 'bm1' });
const levou = Date.now() - antes;
checar(comLentidao.success === true, 'Utmify travada nao impede a cobranca de nascer');
/*
 * A Utmify falsa segura 8 s e o orcamento e 2,5 s. Tem de voltar DEPOIS do
 * orcamento (prova que esperou o envio, em vez de reaproveitar pedido e nem
 * tentar) e MUITO antes dos 8 s (prova que desistiu sozinha).
 */
checar(
  levou >= 2000 && levou < 6000,
  `a criacao desiste da Utmify travada sem esperar por ela (levou ${levou} ms, orcamento 2500)`,
);
comoResponder = 'ok';

recebidos.length = 0;
const depois = await criarPedido({ bm: 'bm1' });
checar(depois.success === true, 'depois da falha, o envio seguinte volta a funcionar');
checar(recebidos.length > 0, 'e a Utmify recebeu de novo');

/* ========================================================================== */

console.log('');
if (tudoOk) console.log('TODOS OS TESTES PASSARAM');
else console.log('HOUVE FALHAS');
encerrar(tudoOk ? 0 : 1);
