/**
 * Testa o dialeto ZuckPay de ponta a ponta, sem falar com a ZuckPay de verdade.
 *
 *   node scripts/testar-zuckpay.mjs
 *
 * Sobe um dublê da API deles (/v3/pix/qrcode e /v3/pix/status, com Basic auth)
 * e o funil inteiro apontado para ele com PIX_PROVIDER=zuckpay em modo LIVE —
 * é o único jeito de exercitar o caminho real do dinheiro sem gerar cobrança:
 * o mock interno pularia justamente o código novo.
 *
 * O CASO QUE PAGA A BATERIA: o postback da ZuckPay traz TRÊS identificadores
 * dentro de `transaction`, e um deles (`external_id`) é uma referência INTERNA
 * deles que não corresponde a pedido nenhum nosso. A lista genérica de chaves
 * do webhook procura `external_id` antes de `id` — herança de outro provedor.
 * Se essa ordem valesse para a ZuckPay, TODO callback cairia em "pedido
 * desconhecido" e nenhuma venda se confirmaria pelo webhook. É silencioso: o
 * dinheiro entra no gateway e o cliente fica olhando a tela.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_APP = 3339;
const PORTA_APP_ASSINADO = 3340;
const PORTA_ZUCK = 3403;
const CLIENT_ID = 'tropadeteste00_0000000000';
const CLIENT_SECRET = 'a'.repeat(64);
const SEGREDO_WEBHOOK = 'whsec-de-teste-' + crypto.randomBytes(8).toString('hex');

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/*
 * CPFs válidos gerados na hora, um por caso.
 *
 * Um CPF por caso NÃO é preciosismo: o sistema reaproveita cobrança viva do
 * mesmo pagador com os mesmos itens (comportamento correto — evita duas
 * cobranças para a mesma intenção). Repetir o CPF faria o caso seguinte medir o
 * reaproveitamento em vez do que ele quer medir, e passar por engano.
 */
function cpfValido(base) {
  const d = String(base).padStart(9, '0').slice(0, 9).split('').map(Number);
  for (let rodada = 0; rodada < 2; rodada += 1) {
    const peso = d.length + 1;
    const soma = d.reduce((acc, n, i) => acc + n * (peso - i), 0);
    const resto = (soma * 10) % 11;
    d.push(resto === 10 ? 0 : resto);
  }
  return d.join('');
}

/* ========================================================================== */
/* O dublê da ZuckPay                                                          */
/* ========================================================================== */

const transacoes = new Map();
const cobrancasRecebidas = [];
const autorizacoesVistas = [];

/* Interruptores que cada fase liga para exercitar um caminho de erro. */
let responderCom = 0;        // 0 = normal; 401/403/429 = recusa administrativa
let distorcerValor = false;  // devolve a cobrança por outro valor
let expiracaoS = 1200;

const dublê = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://127.0.0.1:${PORTA_ZUCK}`);
    let dados = {};
    try { dados = corpo ? JSON.parse(corpo) : {}; } catch { /* segue vazio */ }

    autorizacoesVistas.push(String(req.headers.authorization ?? ''));

    const basic = String(req.headers.authorization ?? '').replace(/^Basic\s+/i, '');
    const par = Buffer.from(basic, 'base64').toString('utf8');
    if (par !== `${CLIENT_ID}:${CLIENT_SECRET}`) {
      return responder(401, { message: 'Credenciais inválidas' });
    }

    if (responderCom === 403) return responder(403, { message: 'IP não autorizado' });
    if (responderCom === 429) return responder(429, { message: 'Too Many Requests' });
    if (responderCom === 401) return responder(401, { message: 'Credenciais inválidas' });

    if (req.method === 'POST' && url.pathname === '/v3/pix/qrcode') {
      if (!dados.nome || !dados.cpf || !dados.valor || !dados.email || !dados.telefone) {
        return responder(400, { message: 'Campos obrigatórios ausentes' });
      }
      cobrancasRecebidas.push(dados);
      const transactionId = crypto.randomBytes(16).toString('hex');
      const valor = distorcerValor ? Number(dados.valor) + 10 : Number(dados.valor);
      transacoes.set(transactionId, { status: 'PENDING', amount: valor });
      return responder(200, {
        transactionId,
        /* A referência INTERNA deles. Não é o nosso pedido — é o caso de ouro. */
        external_id: 'ORDER-INTERNO-' + crypto.randomBytes(4).toString('hex'),
        external_id_client: dados.external_id_client,
        status: 'PENDING',
        amount: valor,
        amount_liquid: Number((valor * 0.93).toFixed(2)),
        calendar: { expiration: expiracaoS },
        debtor: { name: dados.nome, document: dados.cpf },
        qrcode: '00020126580014br.gov.bcb.pix-zuck-de-teste5802BR5913ZUCK TESTE LT6009Sao Paulo62070503***6304ZZZZ',
        pix_code: '00020126580014br.gov.bcb.pix-zuck-de-teste5802BR5913ZUCK TESTE LT6009Sao Paulo62070503***6304ZZZZ',
        qrcode_image: 'https://exemplo.invalido/qr.png',
        checkout_url: 'https://exemplo.invalido/checkout/1',
      });
    }

    if (req.method === 'GET' && url.pathname === '/v3/pix/status') {
      const id = url.searchParams.get('transactionId') ?? '';
      const t = transacoes.get(id);
      if (!t) return responder(404, { statusCode: 404, message: 'Transação não encontrada' });
      return responder(200, {
        statusCode: 200,
        transactionId: id,
        status: t.status,
        amount: t.amount,
        amount_liquid: Number((t.amount * 0.93).toFixed(2)),
        payment_method: 'pix',
        ...(t.status === 'PAID' ? { confirmed_date: '2026-08-20 13:29:00' } : {}),
        created_at: '2026-08-20 13:20:00',
      });
    }

    return responder(404, { statusCode: 404, message: 'rota desconhecida no dublê' });
  });
});
await new Promise((ok) => dublê.listen(PORTA_ZUCK, ok));

/* ========================================================================== */
/* O funil, apontado para o dublê, em modo LIVE                                */
/* ========================================================================== */

const processos = [];

function subirApp(porta, extras) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'zuckpay-teste-'));
  const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
    cwd: dataDir,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PIX_MODE: 'live',
      PIX_PROVIDER: 'zuckpay',
      ZUCKPAY_CLIENT_ID: CLIENT_ID,
      ZUCKPAY_CLIENT_SECRET: CLIENT_SECRET,
      ZUCKPAY_BASE_URL: `http://127.0.0.1:${PORTA_ZUCK}`,
      /* Vazio de propósito: com provider=zuckpay a PixGo não pode ser exigida. */
      PIXGO_API_KEY: '',
      PIXGO_WEBHOOK_SECRET: '',
      META_TRACKING_ENABLED: 'false',
      EMAIL_API_KEY: '',
      DISCORD_WEBHOOK_VENDA: '',
      DISCORD_WEBHOOK_PENDENTE: '',
      ADMIN_SENHA: 'senha-de-teste-' + crypto.randomBytes(4).toString('hex'),
      PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
      RATE_LIMIT_MAX_ORDERS: '500',
      PORT: String(porta),
      DATA_DIR: dataDir,
      DATABASE_URL: '',
      LOG_LEVEL: 'warn',
      PUBLIC_BASE_URL: `http://127.0.0.1:${porta}`,
      ...extras,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.erro = '';
  app.stderr.on('data', (d) => { app.erro += String(d); if (process.env.DEPURAR) process.stderr.write(`[${porta}] ` + d); });
  processos.push(app);
  return app;
}

async function esperarSubir(app, porta) {
  for (let i = 0; i < 60; i += 1) {
    if (app.exitCode !== null) return false;
    try {
      if ((await fetch(`http://127.0.0.1:${porta}/api/health`)).ok) return true;
    } catch { /* subindo */ }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return false;
}

function encerrar(codigo) {
  for (const app of processos) {
    if (app?.pid && process.platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
    } else if (app) {
      app.kill();
    }
  }
  dublê.close();
  process.exit(codigo);
}

for (const porta of [PORTA_APP, PORTA_APP_ASSINADO]) {
  const ocupada = await fetch(`http://127.0.0.1:${porta}/api/health`).then(() => true).catch(() => false);
  if (ocupada) {
    console.error(`\nA porta ${porta} ja esta ocupada -- servidor de teste que sobrou.\n`);
    dublê.close();
    process.exit(1);
  }
}

/* Sem segredo de webhook: é a configuração provável do dono no primeiro dia. */
const app = subirApp(PORTA_APP, { ZUCKPAY_WEBHOOK_SECRET: '' });
if (!await esperarSubir(app, PORTA_APP)) {
  console.error('\nO servidor nao subiu com PIX_PROVIDER=zuckpay.\n' + app.erro.slice(-1200));
  encerrar(1);
}

const base = `http://127.0.0.1:${PORTA_APP}`;

const pedirCobranca = (nome, email, cpf, telefone) => fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'main', bumps: [], customer: { name: nome, email, phone: telefone, document: cpf } }),
}).then((r) => r.json());

console.log('\n== O app sobe sem credencial da PixGo ==\n');
checar(true, 'modo live + provider zuckpay subiu sem PIXGO_API_KEY');

/* ========================================================================== */
console.log('\n== A cobranca ==\n');

const criado = await pedirCobranca('Cliente Zuck de Teste', 'cliente.zuck@gmail.com', cpfValido(390533447), '11988887777');
checar(criado.success === true, 'cria o pedido pela ZuckPay', JSON.stringify(criado).slice(0, 240));
const pedido = criado.data ?? {};
checar(String(pedido.pix?.code ?? '').includes('ZUCK TESTE LT'), 'o codigo PIX veio do dublê');

const cobranca = cobrancasRecebidas.at(-1) ?? {};
checar(cobranca.cpf === cpfValido(390533447), 'o CPF do pagador foi ao gateway');
checar(cobranca.telefone === '11988887777', 'o telefone real foi quando existia');
checar(cobranca.valor === 47, `o valor foi em REAIS decimais (veio ${cobranca.valor})`);
checar(cobranca.external_id_client === pedido.id, 'o NOSSO id de pedido foi como external_id_client');
checar(
  cobranca.urlnoty === undefined,
  'sem base publica https, a urlnoty NAO vai (o gateway nao alcancaria localhost)',
  `urlnoty: ${JSON.stringify(cobranca.urlnoty)}`,
);

/*
 * O segredo NAO pode viajar no corpo. A doc da ZuckPay permite mandar
 * client_id/client_secret dentro do JSON — e corpo de requisicao acaba em log
 * de erro e no `details` das falhas, que o painel mostra.
 */
const corpoCru = JSON.stringify(cobranca);
checar(!corpoCru.includes(CLIENT_SECRET), 'o client_secret NAO viajou no corpo do JSON');
checar(
  autorizacoesVistas.every((a) => a.startsWith('Basic ')),
  'toda chamada levou Basic auth no header',
);

const validade = Date.parse(pedido.pix?.expiresAt ?? '') - Date.now();
checar(
  validade > 19 * 60_000 && validade < 21 * 60_000,
  `a validade veio do calendar.expiration do gateway (${Math.round(validade / 60000)} min para 1200 s)`,
);

/* ========================================================================== */
console.log('\n== Sem telefone, a venda continua ==\n');

const semFone = await pedirCobranca('Sem Telefone', 'sem.telefone.zuck@gmail.com', cpfValido(529982247), '');
checar(semFone.success === true, 'pedido sem telefone ainda vira cobranca', JSON.stringify(semFone).slice(0, 200));
checar(
  (cobrancasRecebidas.at(-1)?.telefone ?? '') === '11999999999',
  'sem telefone vai o numero neutro, e nao um campo vazio que o gateway recusaria',
  `telefone recebido: ${JSON.stringify(cobrancasRecebidas.at(-1)?.telefone)}`,
);

/* ========================================================================== */
console.log('\n== O CASO DE OURO: o postback traz o id INTERNO deles junto ==\n');

const idInterno = 'ORDER-INTERNO-XYZ';
const transactionId = [...transacoes.keys()].find((k) => transacoes.get(k).amount === 47);
checar(Boolean(transactionId), 'o dublê registrou a transacao');

const postback = (corpo, extrasDeHeader = {}, porta = PORTA_APP) => fetch(`http://127.0.0.1:${porta}/api/webhooks/zuckpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extrasDeHeader },
  body: JSON.stringify(corpo),
});

const corpoDoPostback = (status) => ({
  event: status === 'PAID' ? 'payment_approved' : 'payment_pending',
  platform: 'ZuckPay',
  transaction: {
    /* A ordem aqui e de proposito: `external_id` ANTES de `id`, como no JSON deles. */
    external_id: idInterno,
    id: transactionId,
    external_id_client: pedido.id,
    amount: '47.000000',
    status,
    payment_method: 'pix',
    nome: 'Cliente Zuck de Teste',
  },
  timestamp: new Date().toISOString(),
});

const aindaPendente = await postback(corpoDoPostback('PAID'));
checar(aindaPendente.status === 200, `o postback e aceito (${aindaPendente.status})`);

const corpoResp = await aindaPendente.json();
checar(
  corpoResp.ignored !== 'PEDIDO_DESCONHECIDO',
  'O CASO DE OURO: o pedido FOI encontrado, apesar do external_id interno deles vir primeiro',
  JSON.stringify(corpoResp),
);

const aposForja = await fetch(`${base}/api/orders/${pedido.id}/access`).then((r) => r.json());
checar(aposForja.data?.released !== true, 'e o corpo dizendo PAID NAO libera nada: o dublê ainda diz PENDING');

/* Agora o pagamento acontece de verdade no gateway... */
transacoes.get(transactionId).status = 'PAID';

const legitimo = await postback(corpoDoPostback('PAID'));
checar(legitimo.status === 200, 'o postback depois do pagamento e aceito');
const aposPagar = await fetch(`${base}/api/orders/${pedido.id}/access`).then((r) => r.json());
checar(aposPagar.data?.released === true, 'e AGORA o acesso libera: a reconsulta confirmou no gateway');

/* ========================================================================== */
console.log('\n== checkout_abandoned nao queima requisicao ==\n');

const antesDoAbandono = autorizacoesVistas.length;
const abandono = await postback({
  event: 'checkout_abandoned',
  platform: 'ZuckPay',
  transaction: { id: transactionId, external_id_client: pedido.id, status: 'PENDING' },
});
checar(abandono.status === 200, 'checkout_abandoned e aceito');
checar((await abandono.json()).ignored === 'SEM_NADA_A_CONFIRMAR', 'e ignorado: nao ha o que confirmar');
checar(
  autorizacoesVistas.length === antesDoAbandono,
  'e NAO gastou consulta ao gateway',
  `chamadas: ${antesDoAbandono} -> ${autorizacoesVistas.length}`,
);

/* ========================================================================== */
console.log('\n== EXPIRADO em portugues vira expirado, nao pendente ==\n');

const paraExpirar = await pedirCobranca('Vai Expirar', 'vai.expirar.zuck@gmail.com', cpfValido(111444777), '11966665555');
const idExpirar = [...transacoes.keys()].at(-1);
transacoes.get(idExpirar).status = 'EXPIRADO';

await postback({
  event: 'payment_pending',
  platform: 'ZuckPay',
  transaction: { external_id: 'ORDER-INTERNO-2', id: idExpirar, external_id_client: paraExpirar.data.id, status: 'EXPIRADO' },
});

const statusExpirado = await fetch(`${base}/api/orders/${paraExpirar.data.id}`).then((r) => r.json());
checar(
  statusExpirado.data?.status === 'expired',
  'EXPIRADO (portugues) foi mapeado para expirado',
  `status: ${JSON.stringify(statusExpirado.data?.status)}`,
);

/* ========================================================================== */
console.log('\n== REFUSED vira falha, nao pendente eterno ==\n');

const paraRecusar = await pedirCobranca('Vai Recusar', 'vai.recusar.zuck@gmail.com', cpfValido(222555888), '11955554444');
const idRecusar = [...transacoes.keys()].at(-1);
transacoes.get(idRecusar).status = 'REFUSED';

await postback({
  event: 'payment_refused',
  platform: 'ZuckPay',
  transaction: { external_id: 'ORDER-INTERNO-3', id: idRecusar, external_id_client: paraRecusar.data.id, status: 'REFUSED' },
});

const statusRecusado = await fetch(`${base}/api/orders/${paraRecusar.data.id}`).then((r) => r.json());
checar(
  statusRecusado.data?.status === 'failed',
  'REFUSED foi mapeado para falha',
  `status: ${JSON.stringify(statusRecusado.data?.status)}`,
);

/* ========================================================================== */
console.log('\n== A cobranca com outro valor e recusada ==\n');

distorcerValor = true;
const divergente = await pedirCobranca('Valor Torto', 'valor.torto.zuck@gmail.com', cpfValido(333666999), '11944443333');
distorcerValor = false;
checar(divergente.success !== true, 'cobranca criada por outro valor NAO vira pedido', JSON.stringify(divergente).slice(0, 200));
checar(
  !String(divergente.message ?? '').toLowerCase().includes('valor'),
  'e o cliente NAO le "criou a cobranca com outro valor" -- ele ligaria para o banco',
  JSON.stringify(divergente).slice(0, 200),
);

/* ========================================================================== */
console.log('\n== O 403 de IP nao vaza para a tela do cliente ==\n');

responderCom = 403;
const comIpBloqueado = await pedirCobranca('Ip Bloqueado', 'ip.bloqueado.zuck@gmail.com', cpfValido(444777222), '11933332222');
responderCom = 0;
checar(comIpBloqueado.success !== true, 'o 403 derruba a criacao da cobranca');
const textoDoErro = JSON.stringify(comIpBloqueado).toLowerCase();
checar(
  !textoDoErro.includes('ip') && !textoDoErro.includes('autoriz'),
  'e a tela NAO diz "IP nao autorizado" para quem so queria comprar',
  JSON.stringify(comIpBloqueado).slice(0, 200),
);

responderCom = 429;
const comLimite = await pedirCobranca('Muito Rapido', 'muito.rapido.zuck@gmail.com', cpfValido(555888111), '11922221111');
responderCom = 0;
checar(comLimite.success !== true, 'o 429 derruba a criacao da cobranca');
checar(
  String(comLimite.message ?? comLimite.error?.message ?? '').toLowerCase().includes('instantes'),
  'e o cliente le "tente novamente em instantes"',
  JSON.stringify(comLimite).slice(0, 200),
);

/* ========================================================================== */
console.log('\n== Com segredo gerado, o postback assinado e conferido ==\n');

const appAssinado = subirApp(PORTA_APP_ASSINADO, {
  ZUCKPAY_WEBHOOK_SECRET: SEGREDO_WEBHOOK,
  /* Base https: e o unico jeito de exercitar a urlnoty, que orders.ts so monta
   * quando a base publica e https -- em producao ela sempre e. */
  PUBLIC_BASE_URL: 'https://migueltechama.exemplo.invalido',
});
if (!await esperarSubir(appAssinado, PORTA_APP_ASSINADO)) {
  console.error('\nO servidor com ZUCKPAY_WEBHOOK_SECRET nao subiu.\n' + appAssinado.erro.slice(-1200));
  encerrar(1);
}
const baseAssinado = `http://127.0.0.1:${PORTA_APP_ASSINADO}`;

const criadoB = await fetch(`${baseAssinado}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Assinado', email: 'assinado.zuck@gmail.com', phone: '11911110000', document: cpfValido(666999333) },
  }),
}).then((r) => r.json());
checar(criadoB.success === true, 'o app com segredo cria cobranca normalmente');
checar(
  String(cobrancasRecebidas.at(-1)?.urlnoty ?? '').startsWith('https://migueltechama.exemplo.invalido/api/webhooks/'),
  'com base https, a urlnoty do postback vai junto',
  `urlnoty: ${JSON.stringify(cobrancasRecebidas.at(-1)?.urlnoty)}`,
);
const idB = [...transacoes.keys()].at(-1);
transacoes.get(idB).status = 'PAID';

const corpoB = JSON.stringify({
  event: 'payment_approved',
  platform: 'ZuckPay',
  transaction: { external_id: 'ORDER-INTERNO-B', id: idB, external_id_client: criadoB.data.id, status: 'PAID' },
});
const carimbo = Math.floor(Date.now() / 1000);
const v1 = crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(`${carimbo}.${corpoB}`).digest('hex');

const semHeader = await fetch(`${baseAssinado}/api/webhooks/zuckpay`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpoB,
});
checar(semHeader.status === 401, `sem assinatura e recusado com 401 (veio ${semHeader.status})`);

const assinaturaErrada = await fetch(`${baseAssinado}/api/webhooks/zuckpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ZuckPay-Signature': `t=${carimbo},v1=${'0'.repeat(64)}` },
  body: corpoB,
});
checar(assinaturaErrada.status === 401, `assinatura errada e recusada com 401 (veio ${assinaturaErrada.status})`);

const carimboVelho = carimbo - 100_000;
const v1Velho = crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(`${carimboVelho}.${corpoB}`).digest('hex');
const reenvioAntigo = await fetch(`${baseAssinado}/api/webhooks/zuckpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ZuckPay-Signature': `t=${carimboVelho},v1=${v1Velho}` },
  body: corpoB,
});
checar(reenvioAntigo.status === 401, `assinatura boa mas VELHA e recusada (veio ${reenvioAntigo.status})`);

const correto = await fetch(`${baseAssinado}/api/webhooks/zuckpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ZuckPay-Signature': `v1=${v1},t=${carimbo}` },
  body: corpoB,
});
checar(correto.status === 200, `assinatura correta e aceita, mesmo com as partes fora de ordem (veio ${correto.status})`);

const acessoB = await fetch(`${baseAssinado}/api/orders/${criadoB.data.id}/access`).then((r) => r.json());
checar(acessoB.data?.released === true, 'e o acesso libera depois do postback assinado');

/* ========================================================================== */

console.log('');
if (tudoOk) console.log('TODOS OS TESTES PASSARAM');
else console.log('HOUVE FALHAS');
encerrar(tudoOk ? 0 : 1);
