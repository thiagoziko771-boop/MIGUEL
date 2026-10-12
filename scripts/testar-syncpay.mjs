/**
 * Testa o dialeto SyncPay de ponta a ponta, sem falar com a SyncPay de verdade.
 *
 *   node scripts/testar-syncpay.mjs
 *
 * Sobe um dublê da API deles (auth-token com validade curta, cash-in,
 * transaction) e o funil inteiro apontado para ele com PIX_PROVIDER=syncpay em
 * modo LIVE — é o único jeito de exercitar o caminho real do dinheiro sem
 * gerar cobrança: o mock interno pularia justamente o código novo.
 *
 * O CASO QUE PAGA A BATERIA: a SyncPay não assina webhook. Qualquer pessoa que
 * descubra a URL pode POSTar "completed". O que impede produto grátis é o
 * desenho de reconsulta — o webhook forjado tem de ser aceito com 200 e NÃO
 * liberar nada enquanto a API (o dublê) disser pending. Se esse caso quebrar,
 * a troca de gateway abre uma porta que a PixGo mantinha fechada por HMAC.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_APP = 3338;
const PORTA_SYNC = 3402;
const CLIENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const CLIENT_SECRET = 'a1b2c3d4-0000-4000-8000-000000000002';

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/* ========================================================================== */
/* O dublê da SyncPay                                                          */
/* ========================================================================== */

const transacoes = new Map();
let tokensEmitidos = 0;
let tokenVivo = '';
const cashinsRecebidos = [];
/* Validade curta de propósito: o caso da renovação não pode esperar 1 h. */
let validadeDoTokenS = 2;

const dublê = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://127.0.0.1:${PORTA_SYNC}`);
    let dados = {};
    try { dados = corpo ? JSON.parse(corpo) : {}; } catch { /* segue vazio */ }

    if (req.method === 'POST' && url.pathname === '/api/partner/v1/auth-token') {
      if (dados.client_id !== CLIENT_ID || dados.client_secret !== CLIENT_SECRET) {
        return responder(401, { message: 'Unauthorized' });
      }
      tokensEmitidos += 1;
      tokenVivo = 'sync_' + crypto.randomBytes(12).toString('hex');
      const emitidoEm = Date.now();
      setTimeout(() => { if (Date.now() - emitidoEm >= validadeDoTokenS * 1000) { /* vencido naturalmente */ } }, 0);
      return responder(200, {
        access_token: tokenVivo,
        token_type: 'Bearer',
        expires_in: validadeDoTokenS,
        expires_at: new Date(emitidoEm + validadeDoTokenS * 1000).toISOString(),
      });
    }

    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (bearer !== tokenVivo) return responder(401, { message: 'Token inválido ou vencido' });

    if (req.method === 'POST' && url.pathname === '/api/partner/v1/cash-in') {
      const c = dados.client ?? {};
      if (!dados.amount || !c.name || !c.cpf || !c.email || !c.phone) {
        return responder(422, { message: 'Campos obrigatórios ausentes' });
      }
      cashinsRecebidos.push(dados);
      const identifier = crypto.randomUUID();
      transacoes.set(identifier, { status: 'pending', amount: dados.amount });
      return responder(200, {
        message: 'Cashin request successfully submitted',
        pix_code: '00020126360014br.gov.bcb.pix0114sync-de-teste5204000053039865802BR5915SYNC TESTE LTDA6009Sao Paulo62070503***6304ABCD',
        identifier,
      });
    }

    const consulta = url.pathname.match(/^\/api\/partner\/v1\/transaction\/(.+)$/);
    if (req.method === 'GET' && consulta) {
      const t = transacoes.get(decodeURIComponent(consulta[1]));
      if (!t) return responder(404, { message: 'Not found' });
      return responder(200, {
        reference_id: consulta[1],
        currency: 'BRL',
        amount: t.amount,
        status: t.status,
        transaction_date: new Date().toISOString(),
      });
    }

    return responder(404, { message: 'rota desconhecida no dublê' });
  });
});
await new Promise((ok) => dublê.listen(PORTA_SYNC, ok));

/* ========================================================================== */
/* O funil, apontado para o dublê, em modo LIVE                                */
/* ========================================================================== */

const ocupada = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`).then(() => true).catch(() => false);
if (ocupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- servidor de teste que sobrou.\n`);
  dublê.close();
  process.exit(1);
}

const SENHA = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');
const dataDir = mkdtempSync(path.join(tmpdir(), 'syncpay-teste-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'live',
    PIX_PROVIDER: 'syncpay',
    SYNCPAY_CLIENT_ID: CLIENT_ID,
    SYNCPAY_CLIENT_SECRET: CLIENT_SECRET,
    SYNCPAY_BASE_URL: `http://127.0.0.1:${PORTA_SYNC}`,
    SYNCPAY_WEBHOOK_TOKEN: 'token-de-webhook-do-teste',
    /* Vazio de propósito: com provider=syncpay a PixGo não pode ser exigida. */
    PIXGO_API_KEY: '',
    PIXGO_WEBHOOK_SECRET: '',
    META_TRACKING_ENABLED: 'false',
    EMAIL_API_KEY: '',
    ADMIN_SENHA: SENHA,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
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
  dublê.close();
  process.exit(codigo);
}

if (!subiu) {
  console.error('\nO servidor nao subiu com PIX_PROVIDER=syncpay.\n' + erroDoApp.slice(-800));
  encerrar(1);
}

const base = `http://127.0.0.1:${PORTA_APP}`;

console.log('\n== O app sobe sem credencial da PixGo ==\n');
checar(true, 'modo live + provider syncpay subiu sem PIXGO_API_KEY');

/* ========================================================================== */
console.log('\n== A cobranca ==\n');

const criado = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Cliente Sync de Teste', email: 'cliente.sync@gmail.com', phone: '11988887777', document: '39053344705' },
  }),
}).then((r) => r.json());

checar(criado.success === true, 'cria o pedido pela SyncPay', JSON.stringify(criado).slice(0, 200));
const pedido = criado.data ?? {};
checar(String(pedido.pix?.code ?? '').includes('SYNC TESTE LTDA'), 'o codigo PIX veio do dublê');
const identifier = [...transacoes.keys()].at(-1);
checar(Boolean(identifier), 'o dublê registrou a transacao');

const validade = Date.parse(pedido.pix?.expiresAt ?? '') - Date.now();
checar(validade > 18 * 60_000 && validade < 22 * 60_000, `expiracao local de ~20 min (veio ${Math.round(validade / 60000)} min)`);

const ultimoCashin = cashinsRecebidos.at(-1) ?? {};
checar(ultimoCashin.client?.cpf === '39053344705', 'o CPF do pagador foi ao gateway');
checar(ultimoCashin.client?.phone === '11988887777', 'o telefone real foi quando existia');
checar(typeof ultimoCashin.amount === 'number' && ultimoCashin.amount === 47, `o valor foi em REAIS decimais (veio ${ultimoCashin.amount})`);

/*
 * Pedido sem telefone: o campo obrigatorio do gateway nao pode derrubar a venda.
 *
 * CPF DIFERENTE do caso anterior de proposito: o sistema reaproveita cobranca
 * viva de mesmo pagador + mesmos itens (comportamento correto — evita duas
 * cobrancas para a mesma intencao), e com o mesmo CPF este caso nao geraria
 * cash-in novo e estaria medindo o cache, nao o fallback do telefone.
 */
const semFone = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Sem Telefone', email: 'sem.telefone@gmail.com', phone: '', document: '52998224725' },
  }),
}).then((r) => r.json());
checar(semFone.success === true, 'pedido sem telefone ainda vira cobranca', JSON.stringify(semFone).slice(0, 160));
checar(
  (cashinsRecebidos.at(-1)?.client?.phone ?? '') === '11999999999',
  'sem telefone vai o numero neutro, nao um campo vazio',
  `phone recebido: ${JSON.stringify(cashinsRecebidos.at(-1)?.client?.phone)} | cashins: ${cashinsRecebidos.length}`,
);

/* ========================================================================== */
console.log('\n== O caso de ouro: webhook sem assinatura nao libera nada ==\n');

/*
 * O token do webhook: a SyncPay manda um Bearer proprio em cada aviso (veio na
 * criacao do webhook pela API). Header presente e ERRADO e forja na certa —
 * recusa na porta. Ausente, passa e cai na reconsulta.
 */
const bearerErrado = await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-forjado' },
  body: JSON.stringify({ event: 'cashin.update', data: { id: identifier, status: 'completed' } }),
});
checar(bearerErrado.status === 401, `Bearer errado e recusado com 401 (veio ${bearerErrado.status})`);

const bearerCerto = await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-de-webhook-do-teste' },
  body: JSON.stringify({ event: 'cashin.update', data: { id: identifier, status: 'completed' } }),
});
checar(bearerCerto.status === 200, 'Bearer certo e aceito');
const aposBearerCerto = await fetch(`${base}/api/orders/${pedido.id}/access`).then((r) => r.json());
checar(aposBearerCerto.data?.released !== true, 'mesmo com Bearer certo, corpo dizendo pago NAO libera: o dublê diz pending');

const forjado = await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'cashin.update', data: { id: identifier, status: 'completed' } }),
});
checar(forjado.status === 200, `o webhook sem assinatura e aceito (${forjado.status}) — a SyncPay nao assina`);

const aposForja = await fetch(`${base}/api/orders/${pedido.id}/access`).then((r) => r.json());
checar(aposForja.data?.released !== true, 'mas o acesso CONTINUA fechado: o dublê ainda diz pending');

/* Agora o pagamento acontece de verdade no gateway... */
transacoes.get(identifier).status = 'completed';

const legitimo = await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'cashin.update', data: { id: identifier, status: 'completed' } }),
});
checar(legitimo.status === 200, 'o webhook depois do pagamento e aceito');

const aposPagar = await fetch(`${base}/api/orders/${pedido.id}/access`).then((r) => r.json());
checar(aposPagar.data?.released === true, 'e AGORA o acesso libera: a reconsulta confirmou no gateway');

/* ========================================================================== */
console.log('\n== O token de uma hora renova sozinho ==\n');

/* O token do dublê vive 2 s. Espera vencer e cria outra cobranca: o app deve
 * renovar sem falhar — é a instancia que hibernou e voltou. */
await new Promise((ok) => setTimeout(ok, 2_500));
const tokensAntes = tokensEmitidos;
const aposVencer = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Depois Do Vencimento', email: 'renova.token@gmail.com', phone: '11977776666', document: '11144477735' },
  }),
}).then((r) => r.json());
checar(aposVencer.success === true, 'cobranca depois do token vencer funciona');
checar(tokensEmitidos > tokensAntes, `um token novo foi gerado (${tokensAntes} -> ${tokensEmitidos})`);

/* ========================================================================== */

console.log('');
if (tudoOk) console.log('TODOS OS TESTES PASSARAM');
else console.log('HOUVE FALHAS');
encerrar(tudoOk ? 0 : 1);
