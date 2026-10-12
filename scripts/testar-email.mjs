/**
 * Testa o e-mail com os acessos, de ponta a ponta, sem enviar nada a ninguém.
 *
 *   node scripts/testar-email.mjs
 *
 * Sobem dois dublês locais: uma PixGo falsa (para o pedido nascer e ser
 * confirmado pelo callback de verdade) e um provedor de e-mail falso, que
 * guarda o que receberia. É o único jeito de afirmar o que sai daqui — mandar
 * e-mail de teste para uma caixa real não deixa checar conteúdo em teste
 * automático, e mandar para a caixa de um cliente é impensável.
 *
 * O que cada caso protege nasceu do mesmo lugar: a tela promete "seus acessos
 * foram enviados por e-mail" desde o primeiro dia e, até este arquivo existir,
 * NADA era enviado. Quem fechava a aba antes de anotar o link perdia o que
 * acabou de comprar.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORTA_PIXGO = 3361;
const PORTA_EMAIL = 3362;
const PORTA_APP = 3363;
const CHAVE_PIX = 'pk_chavedeteste';
const SEGREDO_PIX = 'whsec_segredodeteste';
const CHAVE_EMAIL = 're_chavedeteste';

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
/* Dublês                                                                      */
/* ========================================================================== */

const cobrancas = new Map();

const pixgoFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers['x-api-key'] !== CHAVE_PIX) return responder(401, { success: false });

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      const dados = JSON.parse(corpo);
      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount });
      return responder(201, {
        success: true,
        data: { payment_id: id, external_id: dados.external_id, amount: dados.amount, status: 'pending', qr_code: 'x' },
      });
    }
    const casa = req.url.match(/^\/api\/v1\/payment\/([^/?]+?)(?:\/status)?$/);
    if (req.method === 'GET' && casa) {
      const c = cobrancas.get(decodeURIComponent(casa[1]));
      if (!c) return responder(404, { success: false });
      return responder(200, { success: true, data: { payment_id: casa[1], status: c.status, amount: c.amount } });
    }
    responder(404, { success: false });
  });
});

/**
 * Provedor de e-mail falso.
 *
 * `modo` troca o comportamento no meio da bateria: é assim que se testa o
 * provedor fora do ar sem esperar um incidente de verdade acontecer.
 */
let recebidos = [];
let modoEmail = 'ok';

const emailFalso = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    if (modoEmail === 'erro') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'domain is not verified' }));
      return;
    }
    if (modoEmail === 'travado') return; // nunca responde: exercita o timeout

    const autorizacao = req.headers.authorization ?? '';
    let json = {};
    try { json = JSON.parse(corpo); } catch { /* corpo invalido cai no caso abaixo */ }
    recebidos.push({ autorizacao, ...json });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_' + crypto.randomBytes(6).toString('hex') }));
  });
});

await new Promise((ok) => pixgoFalsa.listen(PORTA_PIXGO, ok));
await new Promise((ok) => emailFalso.listen(PORTA_EMAIL, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} já está ocupada -- provavelmente por um servidor de teste que sobrou.\n`);
  pixgoFalsa.close(); emailFalso.close();
  process.exit(1);
}

let app = null;

/** Pasta vazia de propósito: na raiz, o .env.local traria as chaves REAIS. */
async function subirApp(extras) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'email-app-'));
  const processo = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
    cwd: dataDir,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PIX_MODE: 'live',
      PIXGO_API_KEY: CHAVE_PIX,
      PIXGO_WEBHOOK_SECRET: SEGREDO_PIX,
      PIXGO_BASE_URL: `http://localhost:${PORTA_PIXGO}/api/v1`,
      META_TRACKING_ENABLED: 'false',
      EMAIL_API_KEY: CHAVE_EMAIL,
      EMAIL_BASE_URL: `http://localhost:${PORTA_EMAIL}`,
      EMAIL_REMETENTE: 'Rezas Sagradas <contato@rezassagradas.site>',
      PUBLIC_BASE_URL: base,
      PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
      ADMIN_SENHA: 'senha-de-teste',
      PORT: String(PORTA_APP),
      DATA_DIR: dataDir,
      DATABASE_URL: '',
      LOG_LEVEL: 'warn',
      STATUS_POLL_MIN_INTERVAL_MS: '0',
      ...extras,
    },
  });
  processo.stderr.on('data', (d) => {
    const linha = String(d);
    if (/Uncaught|TypeError|ReferenceError/.test(linha)) process.stderr.write('[app] ' + linha);
  });
  for (let i = 0; i < 60; i += 1) {
    if (processo.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) return processo; } catch { /* subindo */ }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return processo;
}

/*
 * Mata o servidor E os filhos. No Windows o comando roda como `npx tsx` dentro
 * de um shell: matar o npx deixa o tsx vivo segurando a porta, e a execução
 * seguinte conversa com o processo VELHO servindo código antigo.
 */
function derrubar(processo) {
  if (!processo || processo.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(processo.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já morreu */ }
    return;
  }
  try { processo.kill(); } catch { /* já morreu */ }
}

function encerrar(codigo) {
  derrubar(app);
  pixgoFalsa.close();
  emailFalso.close();
  process.exit(codigo);
}
process.on('exit', () => derrubar(app));
process.on('uncaughtException', (erro) => {
  console.error('\nA bateria parou no meio:', erro?.message ?? erro);
  encerrar(1);
});

app = await subirApp({});

const pedir = async (caminho, opcoes = {}) => {
  const r = await fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { Connection: 'close', ...(opcoes.headers ?? {}) },
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

const CLIENTE = {
  name: 'Maria Aparecida Silva',
  email: 'maria@exemplo.com',
  phone: '11912345678',
  document: '52998224725',
};

/** Cria um pedido e confirma pelo callback assinado, como a PixGo faz. */
async function comprar(cliente = CLIENTE, bumps = ['salmos_150']) {
  const criacao = await pedir('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer: 'main', bumps, customer: cliente, session_id: 's1' }),
  });
  const idCobranca = [...cobrancas.keys()].at(-1);
  cobrancas.get(idCobranca).status = 'completed';
  return { pedido: criacao.data ?? {}, idCobranca };
}

async function avisarPagamento(idCobranca) {
  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
  const segundos = Math.floor(Date.now() / 1000);
  return fetch(`${base}/api/webhooks/pix`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Webhook-Timestamp': String(segundos),
      'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${segundos}.${corpo}`).digest('hex'),
    },
    body: corpo,
  });
}

/* ========================================================================== */
/* PARTE 1 — o e-mail sai, e sai certo                                         */
/* ========================================================================== */

console.log('\n== O cliente recebe os acessos ==\n');

recebidos = [];
const { pedido, idCobranca } = await comprar();
checar(Boolean(pedido.id), 'cria o pedido', JSON.stringify(pedido).slice(0, 150));

const aviso = await avisarPagamento(idCobranca);
checar(aviso.status === 200, 'a PixGo confirma o pagamento', String(aviso.status));
await new Promise((ok) => setTimeout(ok, 1200));

checar(recebidos.length === 1, `sai UM e-mail na confirmacao (saiu ${recebidos.length})`);
const email = recebidos[0] ?? {};

checar(email.autorizacao === `Bearer ${CHAVE_EMAIL}`, 'autentica no provedor com a chave configurada');
checar(Array.isArray(email.to) && email.to[0] === CLIENTE.email, `vai para quem comprou (${email.to?.[0]})`);
checar(String(email.from ?? '').includes('rezassagradas'), `sai do remetente configurado (${email.from})`);
checar(Boolean(email.subject), `tem assunto ("${email.subject}")`);

/*
 * HTML e texto puro, os dois. Cliente de e-mail que bloqueia HTML mostraria
 * uma mensagem vazia -- e mensagem vazia depois de uma compra parece golpe.
 */
checar(Boolean(email.html) && Boolean(email.text), 'manda versao HTML E versao em texto puro');
checar(String(email.html).includes('Maria'), 'chama a pessoa pelo primeiro nome');
checar(String(email.html).includes(pedido.id), 'cita o numero do pedido');

/*
 * O link de acesso e a razao do e-mail existir. Tem de ser absoluto (link
 * relativo em e-mail nao abre em lugar nenhum) e apontar para o nosso dominio.
 */
const link = String(email.text ?? '').match(/https?:\/\/\S+\/api\/entrega\/\S+/)?.[0] ?? '';
checar(link.startsWith(base), `leva um link ABSOLUTO do proprio site (${link.slice(0, 60)}...)`);

/* ========================================================================== */
/* PARTE 2 — o link do e-mail abre mesmo                                       */
/* ========================================================================== */

console.log('\n== O link do e-mail entrega o produto ==\n');

const abertura = await fetch(link, { headers: { Connection: 'close' } });
checar(abertura.status === 200, `o link do e-mail abre a entrega (veio ${abertura.status})`);

// Assinatura trocada por outra: o link nao pode ser adivinhavel nem editavel.
const adulterado = link.replace(/\/[a-f0-9]{40}$/, '/' + 'a'.repeat(40));
const recusado = await fetch(adulterado, { headers: { Connection: 'close' } });
checar(recusado.status !== 200, `link com assinatura trocada e recusado (veio ${recusado.status})`);

/*
 * Prazo adulterado tambem tem de cair. Esticar a validade so mexendo no numero
 * da URL transformaria um link de 72 h em link eterno.
 */
const esticado = link.replace(/\/(\d{13})\//, `/${Date.now() + 400 * 24 * 3_600_000}/`);
const recusadoPrazo = await fetch(esticado, { headers: { Connection: 'close' } });
checar(recusadoPrazo.status !== 200, `link com prazo esticado e recusado (veio ${recusadoPrazo.status})`);

/* ========================================================================== */
/* PARTE 3 — a reentrega do webhook NAO manda o e-mail de novo                 */
/* ========================================================================== */

console.log('\n== Reentrega do webhook ==\n');

recebidos = [];
const reentrega = await avisarPagamento(idCobranca);
await new Promise((ok) => setTimeout(ok, 1200));
checar(reentrega.status === 200, 'a reentrega do callback e aceita');
checar(
  recebidos.length === 0,
  `a reentrega NAO manda um segundo e-mail (mandou ${recebidos.length})`,
);

/* ========================================================================== */
/* PARTE 4 — falha do provedor nao pode custar a venda                         */
/* ========================================================================== */

console.log('\n== O provedor de e-mail fora do ar ==\n');

modoEmail = 'erro';
recebidos = [];
const segunda = await comprar({ ...CLIENTE, email: 'segunda@exemplo.com' });
const avisoDois = await avisarPagamento(segunda.idCobranca);
checar(avisoDois.status === 200, 'com o provedor recusando, o pagamento e confirmado assim mesmo');

const pedidoDois = await pedir(`/api/orders/${segunda.pedido.id}`);
checar(pedidoDois.data?.status === 'completed', `a venda fica paga (status ${pedidoDois.data?.status})`);
const acessoDois = await pedir(`/api/orders/${segunda.pedido.id}/access`);
checar(acessoDois.data?.released === true, 'o acesso e liberado mesmo sem o e-mail sair');

/*
 * Provedor travado: exercita o timeout. O que nao pode acontecer e a resposta
 * do webhook passar da paciencia da PixGo (~10 s) -- ela desiste e reenvia, e
 * reentrega em cima de reentrega vira fila que nunca esvazia.
 */
modoEmail = 'travado';
const terceira = await comprar({ ...CLIENTE, email: 'terceira@exemplo.com' });
const comecou = Date.now();
const avisoTres = await avisarPagamento(terceira.idCobranca);
const demorou = Date.now() - comecou;
checar(avisoTres.status === 200, 'com o provedor travado, o callback ainda responde 200');
checar(demorou < 10_000, `a resposta cabe na paciencia da PixGo (levou ${demorou} ms)`);

const pedidoTres = await pedir(`/api/orders/${terceira.pedido.id}`);
checar(pedidoTres.data?.status === 'completed', 'a venda fica paga mesmo com o provedor travado');

modoEmail = 'ok';

/* ========================================================================== */
/* PARTE 5 — sem chave, nada e enviado e a venda segue igual                   */
/* ========================================================================== */

console.log('\n== EMAIL_API_KEY ausente ==\n');

derrubar(app);
app = await subirApp({ EMAIL_API_KEY: '' });

recebidos = [];
const quarta = await comprar({ ...CLIENTE, email: 'quarta@exemplo.com' });
const avisoQuatro = await avisarPagamento(quarta.idCobranca);
await new Promise((ok) => setTimeout(ok, 1000));

checar(avisoQuatro.status === 200, 'sem chave, o pagamento e confirmado normalmente');
checar(recebidos.length === 0, 'sem chave, NADA e enviado (nem tentativa a esmo)');
const pedidoQuatro = await pedir(`/api/orders/${quarta.pedido.id}`);
checar(pedidoQuatro.data?.status === 'completed', 'sem chave, a venda continua sendo liberada');

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
