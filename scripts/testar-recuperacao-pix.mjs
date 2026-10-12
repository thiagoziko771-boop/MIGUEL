/**
 * Audita o lembrete de PIX gerado e não pago.
 *
 *   node scripts/testar-recuperacao-pix.mjs
 *
 * O dinheiro que esta funcionalidade persegue é real: 27 dos 31 primeiros
 * pedidos ficaram sem pagamento, R$ 1.684,60 parados, e ninguém falava com
 * essas pessoas.
 *
 * DOIS ERROS QUE ESTA BATERIA EXISTE PARA IMPEDIR, os dois piores que o silêncio:
 *
 * 1. LEMBRAR CEDO DEMAIS. Quem gerou o PIX há trinta segundos está com o
 *    aplicativo do banco aberto. Dizer "não recebemos seu pagamento" nesse
 *    instante é atropelar a pessoa no meio da compra.
 *
 * 2. LEMBRAR QUEM JÁ PAGOU. O webhook da PixGo se perde, e o status guardado
 *    pode estar velho. Cobrar quem pagou destrói a confiança de um cliente que
 *    já tinha comprado — e ainda gera pedido de reembolso.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_EMAIL = 3397;
const PORTA_APP = 3345;
const CRON_SECRET = 'segredo-do-cron-de-teste';

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
/* Provedor de e-mail falso                                                    */
/* ========================================================================== */

const enviados = [];
let respostaDoProvedor = 'ok';

const provedorFalso = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    if (respostaDoProvedor === 'erro') {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'dominio nao verificado' }));
      return;
    }
    try {
      enviados.push(JSON.parse(corpo));
    } catch {
      enviados.push({ invalido: corpo });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg-' + enviados.length }));
  });
});

await new Promise((ok) => provedorFalso.listen(PORTA_EMAIL, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- provavelmente um servidor de teste que sobrou.\n`);
  provedorFalso.close();
  process.exit(1);
}

const SENHA_PAINEL = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');
const dataDir = mkdtempSync(path.join(tmpdir(), 'recuperacao-app-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    // Alto para a cobranca falsa nao se confirmar sozinha no meio da bateria:
    // um pedido que vira "pago" no meio do caminho acusaria falha onde nao ha.
    MOCK_CONFIRM_DELAY_MS: '600000',
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: SENHA_PAINEL,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    CRON_SECRET,
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    EMAIL_API_KEY: 'chave-falsa-de-teste',
    EMAIL_BASE_URL: `http://localhost:${PORTA_EMAIL}`,
    PUBLIC_BASE_URL: base,
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

function encerrar(codigo) {
  /*
   * No Windows, spawn com shell:true cria a arvore cmd -> npx -> node, e
   * app.kill() mata SO o cmd: o node continua vivo segurando a porta, e a
   * proxima execucao morre em 'porta ocupada'. Foi exatamente o que travou a
   * esteira em 14/08/2026 - tres baterias em sequencia, tres zumbis. O
   * taskkill /T derruba a arvore inteira.
   */
  if (app?.pid && process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
  } else if (app) {
    app.kill();
  }
  provedorFalso.close();
  process.exit(codigo);
}

if (!subiu) {
  console.error('\nO servidor nao subiu.\n');
  encerrar(1);
}

const cron = (minutos) =>
  fetch(`${base}/api/cron/recuperacao${minutos === undefined ? '' : `?minutos=${minutos}`}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  }).then((r) => r.json());

/*
 * CPF diferente a cada pedido, e isso não é enfeite.
 *
 * `findReusableOrder` casa por oferta + valor + itens + DOCUMENTO: repetir o
 * CPF devolve o mesmo pedido de antes em vez de criar outro, e a bateria
 * passaria a testar três vezes a mesma linha achando que são três casos.
 */
const criarPedido = (email, document) =>
  fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      bumps: [],
      customer: {
        name: 'Maria Aparecida de Souza',
        email,
        phone: '11988887777',
        document,
      },
    }),
  }).then((r) => r.json());

/* ========================================================================== */
/* PARTE 1 — a porta                                                           */
/* ========================================================================== */

console.log('\n== Quem pode disparar ==\n');

const semSegredo = await fetch(`${base}/api/cron/recuperacao`).then((r) => r.status);
checar(semSegredo === 404, `sem o segredo, a rota nem existe (veio ${semSegredo})`);

const segredoErrado = await fetch(`${base}/api/cron/recuperacao`, {
  headers: { Authorization: 'Bearer segredo-errado' },
}).then((r) => r.status);
checar(segredoErrado === 404, `com segredo errado, idem (veio ${segredoErrado})`);

/* ========================================================================== */
/* PARTE 2 — o falso positivo                                                  */
/* ========================================================================== */

console.log('\n== Nao atropelar quem acabou de comprar ==\n');

const pedido = await criarPedido('recuperacao@exemplo.com', '39053344705');
checar(pedido.success === true, 'cria o pedido com PIX pendente', JSON.stringify(pedido).slice(0, 200));

const semEspera = await cron();
checar(
  semEspera.data?.enviados === 0,
  `quem gerou o PIX agora NAO recebe lembrete (enviados: ${semEspera.data?.enviados})`,
);
checar(enviados.length === 0, `e nenhum e-mail sai do servidor (veio ${enviados.length})`);

/* ========================================================================== */
/* PARTE 3 — o lembrete                                                        */
/* ========================================================================== */

console.log('\n== O lembrete ==\n');

const rodada = await cron(0);
checar(rodada.data?.enviados === 1, `passada a espera, o lembrete sai (enviados: ${rodada.data?.enviados})`);
checar(enviados.length === 1, `um e-mail, nao dois (veio ${enviados.length})`);

const email = enviados[0] ?? {};
checar(
  String(email.to?.[0] ?? '') === 'recuperacao@exemplo.com',
  `vai para quem abandonou (veio ${email.to?.[0]})`,
);

const codigoDoPix = pedido.data?.pix?.code ?? '';
checar(codigoDoPix !== '', 'o pedido tem codigo PIX para reenviar');
checar(
  String(email.text ?? '').includes(codigoDoPix),
  'o e-mail leva o codigo copia-e-cola, e nao so um link de volta ao site',
);
checar(
  String(email.html ?? '').includes('Copia e Cola'),
  'e diz onde colar, no aplicativo do banco',
);
checar(
  !/n[aã]o识|urgente|ultima chance/i.test(String(email.text ?? '')),
  'sem urgencia de loja: o tom nao cobra',
);

/* ========================================================================== */
/* PARTE 4 — nao insistir                                                      */
/* ========================================================================== */

console.log('\n== Uma vez, e so ==\n');

const segunda = await cron(0);
checar(segunda.data?.enviados === 0, `a segunda passada nao reenvia (enviados: ${segunda.data?.enviados})`);
checar(enviados.length === 1, `continua um e-mail so (veio ${enviados.length})`);

/* ========================================================================== */
/* PARTE 5 — quem ja pagou                                                     */
/* ========================================================================== */

console.log('\n== Quem ja pagou ==\n');

const pago = await criarPedido('japagou@exemplo.com', '52998224725');
const idPago = pago.data?.id ?? '';
checar(idPago !== '', 'cria o pedido que sera pago');

const login = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA_PAINEL }),
}).then((r) => r.json());
checar(Boolean(login?.data?.token), 'entra no painel para confirmar o pagamento a mao');

const marcado = await fetch(`${base}/api/admin/pedidos/${idPago}/marcar-pago`, {
  method: 'POST',
  headers: { 'X-Admin-Sessao': login.data.token },
}).then((r) => r.json());
checar(marcado.success === true, 'marca como pago', JSON.stringify(marcado).slice(0, 160));

const antes = enviados.length;
await cron(0);
const foiParaOPago = enviados.slice(antes).some((e) => String(e.to?.[0] ?? '') === 'japagou@exemplo.com');
checar(!foiParaOPago, 'quem ja pagou NAO recebe cobranca de pagamento');

/* ========================================================================== */
/* PARTE 6 — o provedor fora do ar                                             */
/* ========================================================================== */

console.log('\n== Quando o provedor falha ==\n');

respostaDoProvedor = 'erro';
const outro = await criarPedido('falha@exemplo.com', '11144477735');
checar(outro.success === true, 'cria mais um pedido');

const comFalha = await cron(0);
checar(comFalha.success === true, 'a rota responde 200 mesmo com o provedor recusando');
checar(
  (comFalha.data?.enviados ?? 0) === 0,
  `e nao conta como enviado o que nao saiu (enviados: ${comFalha.data?.enviados})`,
);

respostaDoProvedor = 'ok';
const retentativa = await cron(0);
checar(
  (retentativa.data?.enviados ?? 0) >= 1,
  `o que falhou nao fica marcado, e sai na proxima passada (enviados: ${retentativa.data?.enviados})`,
);

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
