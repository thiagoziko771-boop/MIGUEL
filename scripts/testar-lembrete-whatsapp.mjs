/**
 * O botão "Enviar lembrete no WhatsApp".
 *
 *   node scripts/testar-lembrete-whatsapp.mjs
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-lembrete-whatsapp.mjs   # + a tela
 *
 * O QUE ESTA BATERIA PROTEGE, em ordem de estrago:
 *
 * 1. QUE O BOTÃO NÃO COBRE NADA. Ele fica ao lado de "Marcar como pago" e de
 *    "Cobrar no WhatsApp", que geram cobrança e link com desconto. Se um dia
 *    alguém apontar este botão para aquele caminho, o dono passa a dar desconto
 *    sem querer, todo dia, para gente que ainda pagaria o preço cheio — e
 *    ninguém percebe, porque a tela continua igual.
 * 2. QUE PEDIDO PAGO NÃO RECEBA "falta concluir sua contribuição". É a mensagem
 *    mais cara que este painel poderia enviar, e a recusa tem de ser do
 *    SERVIDOR: a tela esconde o botão, mas uma aba aberta desde antes do
 *    pagamento ainda o tem na mão.
 * 3. QUE O TEXTO CHEGUE INTEIRO. Acento, emoji e quebra de linha passam por
 *    codificação de URL; errar isso entrega uma mensagem com `%0A` no meio.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_PIXGO = 3392;
const PORTA_APP = 3348;
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
/* PixGo falsa                                                                 */
/* ========================================================================== */

const cobrancas = new Map();
/** Toda chamada que a PixGo falsa recebe: é assim que se prova que NÃO houve cobrança. */
const chamadasNoGateway = [];

const pixgoFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    chamadasNoGateway.push(`${req.method} ${req.url}`);
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers['x-api-key'] !== CHAVE_PIX) return responder(401, { success: false, error: 'UNAUTHORIZED' });

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      const dados = JSON.parse(corpo);
      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount });
      return responder(201, {
        success: true,
        data: {
          payment_id: id, external_id: dados.external_id, amount: dados.amount, status: 'pending',
          qr_code: '00020126-FALSO-' + id, expires_at: '2026-12-31T23:59:00',
        },
      });
    }
    const casa = req.url.match(/^\/api\/v1\/payment\/([^/?]+?)(?:\/status)?$/);
    if (req.method === 'GET' && casa) {
      const c = cobrancas.get(decodeURIComponent(casa[1]));
      if (!c) return responder(404, { success: false, error: 'NOT_FOUND' });
      return responder(200, { success: true, data: { payment_id: casa[1], status: c.status, amount: c.amount } });
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
  console.error(`\nA porta ${PORTA_APP} já está ocupada — encerre o servidor órfão.\n`);
  pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'lembrete-'));

/* O painel copiado para a pasta temporária. Ver testar-aba-resumo.mjs. */
const distOrigem = path.join(raiz, 'dist');
if (process.env.PLAYWRIGHT_DIR) {
  if (!existsSync(path.join(distOrigem, 'admin.html'))) {
    console.error('\nRode `npm run build` antes: a parte da tela precisa do dist/ gerado.\n');
    pixgoFalsa.close();
    process.exit(1);
  }
  const destino = path.join(dataDir, 'dist');
  mkdirSync(destino, { recursive: true });
  for (const arquivo of readdirSync(distOrigem)) {
    if (/^admin.*\.(html|css|js)$/.test(arquivo) || arquivo === 'index.html') {
      copyFileSync(path.join(distOrigem, arquivo), path.join(destino, arquivo));
    }
  }
}

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
    SERVE_STATIC: process.env.PLAYWRIGHT_DIR ? 'true' : 'false',
    STATUS_POLL_MIN_INTERVAL_MS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stderr.on('data', (d) => {
  const l = String(d);
  if (process.env.DEPURAR || /Uncaught|TypeError|ReferenceError/.test(l)) process.stderr.write('[app] ' + l);
});

let subiu = false;
for (let i = 0; i < 60; i += 1) {
  if (app.exitCode !== null) break;
  try { if ((await fetch(`${base}/api/health`)).ok) { subiu = true; break; } } catch { /* subindo */ }
  await new Promise((ok) => setTimeout(ok, 500));
}
function matarArvore() {
  if (app.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já morreu */ }
    return;
  }
  try { app.kill(); } catch { /* já morreu */ }
}
function encerrar(codigo) { matarArvore(); pixgoFalsa.close(); process.exit(codigo); }
process.on('exit', matarArvore);
process.on('uncaughtException', (e) => { console.error('\nA bateria parou:', e?.message ?? e); encerrar(1); });
if (!subiu) { console.error('O servidor não subiu.'); encerrar(1); }

async function pedir(caminho, opcoes) {
  opcoes = opcoes || {};
  const r = await fetch(`${base}${caminho}`, { ...opcoes, headers: { Connection: 'close', ...(opcoes.headers ?? {}) } });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

const sessao = await pedir('/api/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: senhaPainel }),
});
const cab = { 'X-Admin-Sessao': sessao.data?.token ?? '', 'Content-Type': 'application/json' };

const CPFS = ['52998224725', '15350946056', '11144477735', '39053344705'];
let proximo = 0;
async function criarPedido(telefone, nome) {
  const document = CPFS[proximo % CPFS.length];
  proximo += 1;
  const r = await pedir('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      customer: { name: nome ?? 'MARIA ANUNCIATA ROSA', email: 'maria@exemplo.com', phone: telefone, document },
      attrib: { bm: 'bm2' },
      session_id: `s-${crypto.randomBytes(3).toString('hex')}`,
    }),
  });
  return r.data?.orderId ?? r.data?.id ?? r.data?.pedido?.id ?? null;
}

/* ========================================================================== */
/* PARTE 1 — a mensagem e o endereço                                           */
/* ========================================================================== */

console.log('\n== O link e a mensagem ==\n');

const idPendente = await criarPedido('11912345678');
checar(Boolean(idPendente), 'cria um pedido pendente', String(idPendente));

const antes = (await pedir(`/api/admin/pedidos?limite=50`, { headers: cab })).data.pedidos
  .find((p) => p.id === idPendente);
checar(antes?.status === 'pending', 'nasce pendente', String(antes?.status));
checar(antes?.cabeLembrete === true, 'cabe lembrete');
checar(antes?.lembretesEnviados === 0, 'começa com zero lembretes', String(antes?.lembretesEnviados));

const chamadasAntes = chamadasNoGateway.length;
const r1 = await pedir(`/api/admin/pedidos/${idPendente}/lembrete-whatsapp`, { method: 'POST', headers: cab });
checar(r1.success === true, 'o lembrete responde', JSON.stringify(r1).slice(0, 160));

const url = r1.data?.url ?? '';
checar(url.startsWith('https://wa.me/5511912345678?text='), 'usa wa.me com o número do cliente', url.slice(0, 60));

const texto = decodeURIComponent(url.split('?text=')[1] ?? '');
checar(texto.startsWith('Olá, Maria 🙏❤️'), 'trata pela primeira parte do nome, sem gritar', texto.slice(0, 30));
checar(texto.includes('guardada em seu nome'), 'diz que a oração está guardada');
checar(texto.includes('chegou a gerar o Pix'), 'lembra que a pessoa gerou o PIX');
checar(texto.includes('me responda por aqui'), 'convida a responder');
checar(texto.split('\n').length > 8, 'as quebras de linha sobrevivem à codificação', String(texto.split('\n').length));
/*
 * Espaço codificado como %20, e NUNCA como `+`. `URLSearchParams` usaria `+`, e
 * o WhatsApp mostraria os sinais literais no meio do texto — a mensagem chegaria
 * com "Olá,+Maria" e o dono teria de reescrever tudo à mão.
 */
checar(!url.includes('+'), 'espaço vira %20, não "+"');
checar(url.includes('%F0%9F%99%8F'), 'o emoji 🙏 é codificado', url.slice(0, 90));

/* ========================================================================== */
/* PARTE 2 — NÃO COBRA, NÃO MUDA STATUS                                        */
/* ========================================================================== */

console.log('\n== O que ele NÃO faz ==\n');

checar(
  chamadasNoGateway.length === chamadasAntes,
  `>>> nenhuma chamada ao gateway <<< (${chamadasNoGateway.length - chamadasAntes} feita(s))`,
  chamadasNoGateway.slice(chamadasAntes).join(', '),
);
checar(r1.data?.alterouStatus === false, 'a resposta declara que não mexeu no status');

const depois = (await pedir(`/api/admin/pedidos?limite=50`, { headers: cab })).data.pedidos
  .find((p) => p.id === idPendente);
checar(depois?.status === 'pending', '>>> o status continua pendente <<<', String(depois?.status));
checar(depois?.pagoEm === null, 'não marcou data de pagamento', String(depois?.pagoEm));
checar(depois?.valor === antes?.valor, 'o valor não mudou', `${antes?.valor} -> ${depois?.valor}`);
checar(depois?.cobrancaId === antes?.cobrancaId, 'não gerou cobrança nova', String(depois?.cobrancaId));

/* ========================================================================== */
/* PARTE 3 — o contador                                                        */
/* ========================================================================== */

console.log('\n== O contador ==\n');

checar(r1.data?.lembretesEnviados === 1, 'o primeiro lembrete conta 1', String(r1.data?.lembretesEnviados));
checar(depois?.lembretesEnviados === 1, 'a lista já mostra 1', String(depois?.lembretesEnviados));
checar(Boolean(depois?.ultimoLembreteEm), 'guarda quando foi', String(depois?.ultimoLembreteEm));

const r2 = await pedir(`/api/admin/pedidos/${idPendente}/lembrete-whatsapp`, { method: 'POST', headers: cab });
const r3 = await pedir(`/api/admin/pedidos/${idPendente}/lembrete-whatsapp`, { method: 'POST', headers: cab });
checar(r2.data?.lembretesEnviados === 2 && r3.data?.lembretesEnviados === 3,
  'reenviar soma em vez de substituir', `${r2.data?.lembretesEnviados}, ${r3.data?.lembretesEnviados}`);

const eventos = (await pedir(`/api/admin/pedidos/${idPendente}/eventos`, { headers: cab })).data.eventos;
const doLembrete = eventos.filter((e) => e.evento === 'whatsapp_reminder_sent');
checar(doLembrete.length === 3, 'os 3 ficaram gravados no banco, nenhum apagado', String(doLembrete.length));
checar(Boolean(doLembrete[0]?.t), 'cada um com data e hora', String(doLembrete[0]?.t));

/* ========================================================================== */
/* PARTE 4 — quem NÃO pode receber                                             */
/* ========================================================================== */

console.log('\n== Quem não recebe ==\n');

const semTelefone = await criarPedido('');
const rSem = await pedir(`/api/admin/pedidos/${semTelefone}/lembrete-whatsapp`, { method: 'POST', headers: cab });
checar(rSem.status === 400, 'sem telefone é recusado com motivo', String(rSem.status));
checar(String(rSem.message ?? '').includes('telefone'), 'e a mensagem diz que é o telefone', String(rSem.message));

/* Paga o primeiro e tenta de novo: a recusa tem de vir do SERVIDOR. */
const idPago = await criarPedido('11987654321');
const idCobranca = [...cobrancas.keys()].at(-1);
cobrancas.get(idCobranca).status = 'completed';
const corpoWh = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
const seg = Math.floor(Date.now() / 1000);
await pedir('/api/webhooks/pix', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': String(seg),
    'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${seg}.${corpoWh}`).digest('hex'),
  },
  body: corpoWh,
});

const rPago = await pedir(`/api/admin/pedidos/${idPago}/lembrete-whatsapp`, { method: 'POST', headers: cab });
checar(rPago.status === 400, '>>> pedido PAGO é recusado pelo servidor <<<', String(rPago.status));
checar(String(rPago.message ?? '').includes('já foi pago'), 'e diz por quê', String(rPago.message));

const pagoNaLista = (await pedir(`/api/admin/pedidos?limite=50`, { headers: cab })).data.pedidos
  .find((p) => p.id === idPago);
checar(pagoNaLista?.cabeLembrete === false, 'e a tela também esconde o botão nele');

const semLogin = await pedir(`/api/admin/pedidos/${idPendente}/lembrete-whatsapp`, { method: 'POST' });
checar(semLogin.status === 401, 'exige login', String(semLogin.status));

/* ========================================================================== */
/* PARTE 5 — a tela                                                            */
/* ========================================================================== */

if (!process.env.PLAYWRIGHT_DIR) {
  console.log('\n(sem PLAYWRIGHT_DIR: a parte da tela foi pulada)');
} else {
  console.log('\n== A tela ==\n');
  const { chromium } = await import(
    pathToFileURL(path.resolve(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'index.mjs')).href
  );
  const nav = await chromium.launch();
  const pg = await nav.newPage();
  const erros = [];
  pg.on('pageerror', (e) => erros.push(String(e).slice(0, 160)));

  await pg.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await pg.fill('#senha', senhaPainel);
  await pg.click('#botaoEntrar');
  await pg.waitForSelector('#painel:not([hidden])', { timeout: 15000 });
  await pg.waitForTimeout(1500);

  await pg.locator(`tr[data-id="${idPendente}"], [data-id="${idPendente}"]`).first().click();
  await pg.waitForTimeout(1200);

  const botao = pg.locator('button[data-acao="lembrete"]');
  checar((await botao.count()) === 1, 'o botão existe no pedido pendente');
  checar(
    (await botao.innerText()).trim() === 'Enviar lembrete no WhatsApp',
    'com o texto exato pedido',
    (await botao.innerText()).trim(),
  );
  /*
   * Sem a classe `destaque`, que a tela usa nas ações de dinheiro. Dois botões
   * de aparência igual lado a lado — um que só escreve e outro que confirma
   * pagamento — é um erro esperando o dedo errado num dia corrido.
   */
  const classe = (await botao.getAttribute('class')) ?? '';
  checar(!classe.includes('destaque'), 'não tem a aparência das ações de dinheiro', classe);
  checar((await pg.locator('#notaLembrete').innerText()).includes('3'), 'o contador aparece com 3');

  checar(erros.length === 0, 'nenhum erro de JavaScript', erros.slice(0, 3).join(' | '));
  await nav.close();
}

console.log(tudoOk
  ? '\nPASSOU — o lembrete abre a conversa e não toca em dinheiro.'
  : '\nREPROVOU: veja as linhas FALHOU acima.');
encerrar(tudoOk ? 0 : 1);
