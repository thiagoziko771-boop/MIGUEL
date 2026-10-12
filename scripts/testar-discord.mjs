/**
 * Os avisos de venda no Discord.
 *
 *   node scripts/testar-discord.mjs
 *
 * Sobe um Discord FALSO e confere o que sai dele. Nenhuma mensagem chega ao
 * canal de verdade e nenhum webhook real é usado.
 *
 * O que esta bateria protege, em ordem de estrago:
 *
 * 1. UMA VENDA PERDIDA POR CAUSA DE UM AVISO. Discord fora do ar, lento ou
 *    devolvendo erro não pode impedir a cobrança de nascer nem o acesso de ser
 *    liberado. É a regra 11 do CLAUDE.md, e é a única coisa aqui que custa
 *    dinheiro de verdade se quebrar.
 * 2. O CPF NUM CANAL DE CHAT. Ele existe no pedido porque o gateway exige.
 *    Mensagem de Discord é lida, encaminhada e fica no histórico para sempre.
 * 3. UM ENDEREÇO ERRADO virando requisição do nosso servidor para qualquer
 *    lugar, de dentro do fluxo de pagamento e com dados do cliente no corpo.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORTA_DISCORD = 3394;
const PORTA_PIXGO = 3393;
const PORTA_APP = 3347;
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
/* Discord falso                                                               */
/* ========================================================================== */

const recebidas = [];
/** Trocado pelos testes: 'ok', 'erro' ou 'lento'. */
let comoResponder = 'ok';

const discordFalso = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(corpo); } catch { /* fica null */ }
    recebidas.push({ caminho: req.url, corpo: json, cru: corpo });

    if (comoResponder === 'erro') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }));
      return;
    }
    if (comoResponder === 'lento') {
      // Mais que o orçamento de 2,5 s: obriga o servidor a desistir sozinho.
      setTimeout(() => { res.writeHead(204); res.end(); }, 8000);
      return;
    }
    res.writeHead(204);
    res.end();
  });
});
await new Promise((ok) => discordFalso.listen(PORTA_DISCORD, ok));

/* ========================================================================== */
/* PixGo falsa                                                                 */
/* ========================================================================== */

/** Trocado pelos testes: o gateway informa o adquirente ou nao. */
let mandarAdquirente = false;

/*
 * Um BR Code de VERDADE, montado campo a campo.
 *
 * O dublê devolvia '00020126-FALSO-<id>', que nao e um EMV: a leitura parava no
 * primeiro campo e a nominal e o adquirente sumiam sozinhos. Os casos abaixo
 * passariam sem testar nada -- que e a pior forma de um teste falhar.
 *
 * Os tamanhos sao calculados, nunca escritos a mao: um numero errado desloca
 * TODOS os campos seguintes, e o teste passaria a medir lixo.
 */
const campo = (id, valor) => id + String(valor.length).padStart(2, '0') + valor;

/* Trocado entre as fases para provar que o dominio desconhecido aparece cru. */
let dominioDoPsp = 'qrcode.fyhub.com.br';
let nominalDoPix = 'AXIA_TECNOLOGIA_LTDA';

function brCodeFalso(id) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('25', `${dominioDoPsp}/qr/v3/at/${id}`);
  return campo('00', '01')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + campo('58', 'BR')
    + campo('59', nominalDoPix)
    + campo('60', 'SAO_PAULO')
    + campo('62', campo('05', '***'))
    + '63041234';
}

const cobrancas = new Map();
const pixgoFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers['x-api-key'] !== CHAVE_PIX) return responder(401, { success: false, error: 'UNAUTHORIZED' });

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      const dados = JSON.parse(corpo);
      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount });
      /*
       * `acquirer` só é devolvido quando `mandarAdquirente` está ligado.
       *
       * É o caso real: PixGo e SyncPay não informam esse campo hoje. O aviso
       * precisa funcionar dos dois jeitos — mostrando quando vem, e OMITINDO a
       * linha quando não vem, em vez de escrever "não informado" em toda venda.
       */
      const extra = mandarAdquirente ? { acquirer: { name: 'Celcoin' } } : {};
      return responder(201, {
        success: true,
        data: {
          payment_id: id, external_id: dados.external_id, amount: dados.amount, status: 'pending',
          qr_code: brCodeFalso(id), expires_at: '2026-12-31T23:59:00',
          ...extra,
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
  discordFalso.close(); pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'discord-'));

/*
 * Os endereços entram por VARIÁVEL DE AMBIENTE, não pelo painel.
 *
 * O Discord falso é http e localhost, e a validação do painel recusa os dois —
 * com razão, é ela que impede um endereço colado errado de virar requisição do
 * nosso servidor para qualquer lugar. Pela variável, o teste exercita o ENVIO
 * sem afrouxar a regra que protege produção.
 */
const APROVADA = `http://localhost:${PORTA_DISCORD}/api/webhooks/111/aaa`;
const PENDENTE = `http://localhost:${PORTA_DISCORD}/api/webhooks/222/bbb`;

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
    SERVE_STATIC: 'false',
    STATUS_POLL_MIN_INTERVAL_MS: '0',
    DISCORD_WEBHOOK_APROVADA: APROVADA,
    DISCORD_WEBHOOK_PENDENTE: PENDENTE,
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
function encerrar(codigo) { matarArvore(); discordFalso.close(); pixgoFalsa.close(); process.exit(codigo); }
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

/* ========================================================================== */
/* PARTE 1 — o endereço                                                        */
/* ========================================================================== */

console.log('\n== O endereço do webhook ==\n');

/*
 * Endereço que não é do Discord tem de ser RECUSADO. Sem isso, um texto colado
 * errado viraria requisição do nosso servidor para onde ele apontasse, de
 * dentro do fluxo de pagamento e com os dados do cliente no corpo.
 */
for (const ruim of [
  'http://discord.com/api/webhooks/1/x',
  'https://evil.example.com/api/webhooks/1/x',
  'https://discord.com/api/outra-coisa/1',
  'nao-e-url',
]) {
  const r = await pedir('/api/admin/discord', {
    method: 'POST', headers: cab, body: JSON.stringify({ aprovada: ruim }),
  });
  checar(r.status === 400, `recusa endereço inválido: ${ruim.slice(0, 46)}`, String(r.status));
}

console.log('\n== Aviso de PIX gerado ==\n');

/* ========================================================================== */
/* PARTE 2 — o que sai na mensagem                                             */
/* ========================================================================== */

/*
 * CPFs DIFERENTES a cada chamada, e não um só.
 *
 * `createOrder` reaproveita cobrança pendente do mesmo CPF com o mesmo valor —
 * e com razão, é isso que impede o cliente que clicou duas vezes de receber dois
 * PIX. Mas num teste isso é uma armadilha: da segunda chamada em diante o
 * servidor devolveria o pedido velho em 5 ms sem criar nada, e a checagem de
 * "o Discord travado não segura a criação" passaria sem nunca ter chamado o
 * Discord. Foi o que aconteceu na primeira versão desta bateria.
 */
/*
 * CPF NOVO a cada chamada, calculado -- e nao sorteado de uma lista fixa.
 *
 * Antes eram cinco CPFs num anel com `%`. Funcionava enquanto a bateria tinha
 * menos de cinco criacoes; ao passar disso o anel dava a volta, o sexto pedido
 * caia no CPF do primeiro e o servidor reaproveitava a cobranca pendente. O
 * caso do "Discord travado" voltava em 3 ms e PASSAVA -- sem nunca ter chamado
 * o Discord. Foi o que aconteceu ao acrescentar dois casos em 20/08/2026.
 *
 * A lista fixa transformava "escrever um caso novo" em "quebrar um caso
 * antigo, em silencio e a distancia". Gerar o numero remove a armadilha de vez.
 */
let proximoCpf = 0;

function cpfDeTeste(n) {
  const base = String(100000000 + (n * 7919) % 800000000).slice(0, 9).split('').map(Number);
  for (let rodada = 0; rodada < 2; rodada += 1) {
    const peso = base.length + 1;
    const soma = base.reduce((acc, d, i) => acc + d * (peso - i), 0);
    const resto = (soma * 10) % 11;
    base.push(resto === 10 ? 0 : resto);
  }
  return base.join('');
}

async function criarPedido(atrib) {
  const document = cpfDeTeste(proximoCpf);
  proximoCpf += 1;
  return pedir('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      customer: {
        name: 'Maria de Teste', email: 'maria@exemplo.com',
        phone: '11912345678', document,
      },
      attrib: atrib,
      session_id: `s-${crypto.randomBytes(3).toString('hex')}`,
    }),
  });
}

recebidas.length = 0;
const criado = await criarPedido({ bm: 'bm2', utm_source: 'facebook', utm_campaign: 'CTV_TESTE', utm_content: 'AD_01' });
checar(criado.success === true, 'a cobrança é criada', JSON.stringify(criado).slice(0, 140));
await new Promise((ok) => setTimeout(ok, 600));

const pendenteMsg = recebidas.find((r) => r.caminho.includes('/222/'));
const aprovadaMsgCedo = recebidas.find((r) => r.caminho.includes('/111/'));
checar(Boolean(pendenteMsg), `o aviso de PIX gerado foi para o webhook de PENDENTE (${recebidas.length} recebida(s))`);
checar(!aprovadaMsgCedo, 'PIX gerado NÃO dispara o webhook de aprovada');

if (pendenteMsg) {
  const e = pendenteMsg.corpo?.embeds?.[0] ?? {};
  const texto = JSON.stringify(pendenteMsg.corpo);
  checar(String(e.title ?? '').includes('PIX GERADO'), 'o título diz que ainda não pagou', String(e.title));
  checar(String(e.description ?? '').includes('R$'), 'o valor aparece', String(e.description).slice(0, 60));
  checar(texto.includes('bm2'), 'a BM aparece — é a primeira pergunta com três contas');
  checar(texto.includes('CTV_TESTE'), 'a campanha aparece');
  checar(texto.includes('wa.me/5511912345678'), 'o telefone vira link de WhatsApp');
  /* O CPF NUNCA. Canal de chat é lido, encaminhado e fica no histórico. */
  checar(!texto.includes('52998224725'), '>>> o CPF NÃO vai na mensagem <<<');
}

/* ========================================================================== */
/* PARTE 3 — venda aprovada                                                    */
/* ========================================================================== */

console.log('\n== Aviso de venda aprovada ==\n');

async function confirmar() {
  const id = [...cobrancas.keys()].at(-1);
  cobrancas.get(id).status = 'completed';
  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: id, status: 'completed' });
  const seg = Math.floor(Date.now() / 1000);
  return pedir('/api/webhooks/pix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Timestamp': String(seg),
      'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${seg}.${corpo}`).digest('hex'),
    },
    body: corpo,
  });
}

recebidas.length = 0;
const aviso = await confirmar();
checar(aviso.status === 200, 'o callback é aceito', String(aviso.status));
await new Promise((ok) => setTimeout(ok, 600));

const aprovadaMsg = recebidas.find((r) => r.caminho.includes('/111/'));
checar(Boolean(aprovadaMsg), 'a venda aprovada foi para o webhook de APROVADA');
if (aprovadaMsg) {
  const e = aprovadaMsg.corpo?.embeds?.[0] ?? {};
  checar(String(e.title ?? '').includes('VENDA APROVADA'), 'o título diz que foi aprovada', String(e.title));
  checar(e.color === 0x2ecc71, 'a cor é verde — é o que se lê antes do texto');
  checar(!JSON.stringify(aprovadaMsg.corpo).includes('52998224725'), 'o CPF NÃO vai na aprovada também');
}

/* ========================================================================== */
/* PARTE 3.5 - gateway, adquirente e valor liquido                             */
/* ========================================================================== */

console.log('\n== Gateway e adquirente ==\n');

recebidas.length = 0;
mandarAdquirente = false;
await criarPedido({ bm: 'bm1' });
await new Promise((ok) => setTimeout(ok, 600));
const semAdq = JSON.stringify(recebidas.find((r) => r.caminho.includes('/222/'))?.corpo ?? {});
checar(semAdq.includes('Gateway'), 'o gateway aparece na mensagem');
checar(semAdq.includes('PixGo'), 'com o nome de gente, nao o da variavel', semAdq.slice(0, 120));
/*
 * Sem adquirente informado, a LINHA NAO EXISTE. Um campo fixo dizendo "nao
 * informado" em toda venda vira ruido que se aprende a ignorar -- e ai deixa de
 * ser lido no dia em que ele importa.
 */
checar(
  !semAdq.includes('Adquirente informado'),
  'sem adquirente informado pelo gateway, a linha some em vez de dizer vazio',
  semAdq.slice(0, 200),
);
checar(semAdq.includes('Forma'), 'a forma de pagamento aparece');

recebidas.length = 0;
mandarAdquirente = true;
await criarPedido({ bm: 'bm1' });
await new Promise((ok) => setTimeout(ok, 600));
const comAdq = JSON.stringify(recebidas.find((r) => r.caminho.includes('/222/'))?.corpo ?? {});
checar(comAdq.includes('Adquirente informado'), 'quando o gateway informa, o adquirente aparece');
checar(comAdq.includes('Celcoin'), 'com o nome que veio do gateway', comAdq.slice(0, 140));
mandarAdquirente = false;

/* ========================================================================== */
console.log('\n== A nominal e o adquirente FINAL, lidos do proprio PIX ==\n');

/*
 * As duas linhas que o gateway nao conta sobre si mesmo.
 *
 * A NOMINAL e o nome que aparece na tela do banco de quem vai pagar; o
 * ADQUIRENTE FINAL e quem realmente fala com o Banco Central. Nenhum dos dois
 * esta na resposta JSON -- os dois estao dentro do codigo de pagar. Em
 * 20/08/2026 o mesmo funil emitia por onlyup pela SyncPay e passou a emitir por
 * fyhub pela ZuckPay, sem o gateway avisar.
 */
recebidas.length = 0;
await criarPedido({ bm: 'bm1' });
await new Promise((ok) => setTimeout(ok, 600));
const comPix = JSON.stringify(recebidas.find((r) => r.caminho.includes('/222/'))?.corpo ?? {});

checar(comPix.includes('Nominal no PIX'), 'a nominal aparece no aviso', comPix.slice(0, 200));
checar(
  comPix.includes('AXIA_TECNOLOGIA_LTDA'),
  'com o nome do campo 59, que e o que o banco do cliente mostra',
  comPix.slice(0, 220),
);
checar(comPix.includes('Adquirente final'), 'o adquirente final aparece');
checar(
  comPix.includes('FireHub'),
  'com o nome de gente quando conhecemos o dominio',
  comPix.slice(0, 260),
);
checar(
  comPix.includes('fyhub.com.br') && !comPix.includes('qrcode.fyhub.com.br'),
  'e o dominio vem junto como prova, sem o subdominio',
  comPix.slice(0, 260),
);

/*
 * Dominio novo NAO vira "desconhecido": aparece cru. Um liquidante que nunca
 * vimos e exatamente a informacao que interessa -- quer dizer que o gateway
 * trocou sem avisar, e esconder isso atras de um rotulo generico e o mesmo que
 * nao avisar.
 */
recebidas.length = 0;
dominioDoPsp = 'pix.liquidante-novo.com.br';
nominalDoPix = 'EMPRESA_QUE_NUNCA_VIMOS';
await criarPedido({ bm: 'bm2' });
await new Promise((ok) => setTimeout(ok, 600));
const novo = JSON.stringify(recebidas.find((r) => r.caminho.includes('/222/'))?.corpo ?? {});
checar(
  novo.includes('liquidante-novo.com.br'),
  'liquidante desconhecido aparece pelo dominio, nao escondido',
  novo.slice(0, 260),
);
checar(novo.includes('EMPRESA_QUE_NUNCA_VIMOS'), 'e a nominal nova aparece junto');
dominioDoPsp = 'qrcode.fyhub.com.br';
nominalDoPix = 'AXIA_TECNOLOGIA_LTDA';

/* ========================================================================== */
/* PARTE 4 — o Discord não pode derrubar a venda                               */
/* ========================================================================== */

console.log('\n== Discord fora do ar ==\n');

comoResponder = 'erro';
const comErro = await criarPedido({ bm: 'bm3' });
checar(comErro.success === true, 'Discord devolvendo 404 não impede a cobrança de nascer');

comoResponder = 'lento';
const antes = Date.now();
const comLentidao = await criarPedido({ bm: 'bm3' });
const levou = Date.now() - antes;
checar(comLentidao.success === true, 'Discord travado não impede a cobrança de nascer');
/*
 * O orçamento é 2,5 s e o Discord falso segura 8 s. A criação tem de voltar
 * DEPOIS do orçamento (prova que esperou o aviso, em vez de reaproveitar um
 * pedido velho e nem tentar) e MUITO antes dos 8 s (prova que desistiu sozinho).
 * Sem o piso, a checagem passaria justamente no caso em que não testou nada.
 */
checar(
  levou >= 2000 && levou < 6000,
  `a criação desiste do Discord travado sem esperar por ele (levou ${levou} ms, orçamento 2500)`,
);

comoResponder = 'ok';
recebidas.length = 0;
await confirmar();
await new Promise((ok) => setTimeout(ok, 600));
checar(
  recebidas.some((r) => r.caminho.includes('/111/')),
  'depois da falha, o aviso seguinte volta a funcionar',
);

/* ========================================================================== */
/* PARTE 5 — o painel não devolve o endereço inteiro                           */
/* ========================================================================== */

console.log('\n== O painel ==\n');

const visto = await pedir('/api/admin/discord', { headers: cab });
const cru = JSON.stringify(visto);
checar(visto.success === true, 'a rota responde');
checar(!cru.includes('/aaa'), 'o endereço não volta inteiro para o navegador', cru.slice(0, 160));
checar(cru.includes('••') || cru.includes('webhooks/111'), 'volta mascarado', cru.slice(0, 160));

const semLogin = await pedir('/api/admin/discord');
checar(semLogin.status === 401, 'ver os endereços exige login', String(semLogin.status));

console.log(tudoOk
  ? '\nPASSOU — os avisos saem certos e nunca seguram uma venda.'
  : '\nREPROVOU: veja as linhas FALHOU acima.');
encerrar(tudoOk ? 0 : 1);
