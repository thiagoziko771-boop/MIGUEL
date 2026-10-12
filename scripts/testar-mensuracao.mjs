/**
 * Testa a mensuração PRÓPRIA, depois da remoção de Meta e TikTok.
 *
 *   node scripts/testar-mensuracao.mjs
 *
 * Três perguntas, e nenhuma delas se responde lendo o código:
 *
 * 1. SAIU MESMO? Nenhum pedaço do funil pode falar com plataforma de anúncio.
 *    O teste sobe o app e confere que nenhuma requisição sai para facebook.com
 *    ou tiktok.com — inclusive na hora em que uma venda é confirmada, que era
 *    exatamente onde o Purchase saía.
 *
 * 2. A CONVERSÃO NASCE NA HORA CERTA? Só quando o gateway confirma. QR gerado
 *    não conta, PIX copiado não conta, checkout aberto não conta.
 *
 * 3. A REENTREGA DUPLICA? O webhook é reentregue por desenho. Duas entregas do
 *    mesmo pagamento não podem virar duas vendas no relatório.
 *
 * O CASO QUE PAGA A BATERIA é o 1 combinado com o 3: um sistema que parou de
 * mandar evento mas passou a contar a mesma venda duas vezes internamente
 * trocou um problema visível por um invisível.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_APP = 3342;
const PORTA_ESPIA = 3405;
const SENHA = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

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
/* PARTE 1 — o que foi para o navegador                                        */
/* ========================================================================== */

console.log('\n== O que o navegador baixa ==\n');

/*
 * Lido do BUILD, não do código-fonte.
 *
 * É a diferença entre "não achei no `src/`" e "não vai para o navegador". Um
 * import esquecido, uma dependência que injeta pixel sozinha ou um trecho que
 * o bundler puxa por outro caminho só aparecem aqui.
 */
const dist = path.join(raiz, 'dist');
if (!existsSync(dist)) {
  console.error('\nRode `npm run build` antes: esta bateria confere o BUNDLE, nao o codigo-fonte.\n');
  process.exit(1);
}

function tudoQueFoiPublicado() {
  const acumulado = [];
  const ler = (dir) => {
    for (const nome of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, nome.name);
      if (nome.isDirectory()) ler(caminho);
      else if (/\.(js|html|css|mjs)$/.test(nome.name)) acumulado.push(readFileSync(caminho, 'utf8'));
    }
  };
  ler(dist);
  return acumulado.join('\n');
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const publicado = tudoQueFoiPublicado();

for (const [rotulo, agulha] of [
  ['connect.facebook.net', 'connect.facebook.net'],
  ['fbevents.js', 'fbevents.js'],
  ['a chamada fbq(', 'fbq('],
  ['analytics.tiktok.com', 'analytics.tiktok.com'],
  ['a fila ttq', 'TiktokAnalyticsObject'],
  ['graph.facebook.com', 'graph.facebook.com'],
]) {
  checar(!publicado.includes(agulha), `o bundle NAO contem ${rotulo}`);
}

/* ========================================================================== */
/* PARTE 2 — o espião de rede                                                  */
/* ========================================================================== */

/*
 * Um servidor que finge ser o Meta e o TikTok.
 *
 * O app sobe com META_BASE_URL apontado para ele. Se qualquer coisa no servidor
 * ainda tentar mandar evento, a requisição cai aqui e o teste reprova — em vez
 * de sair de verdade para a internet, que é o que aconteceria em producao.
 */
const batidas = [];
const espia = http.createServer((req, res) => {
  batidas.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
});
await new Promise((ok) => espia.listen(PORTA_ESPIA, ok));

const ocupada = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`).then(() => true).catch(() => false);
if (ocupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada.\n`);
  espia.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'mensuracao-teste-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    MOCK_CONFIRM_DELAY_MS: '1500',
    /* Apontado para o espiao: se algo tentar mandar evento, a gente ve. */
    META_BASE_URL: `http://127.0.0.1:${PORTA_ESPIA}`,
    META_TRACKING_ENABLED: 'true',
    META_PIXEL_ID: '1234567890',
    META_CAPI_TOKEN: 'token-que-nao-deve-ser-usado',
    EMAIL_API_KEY: '',
    DISCORD_WEBHOOK_APROVADA: '',
    DISCORD_WEBHOOK_PENDENTE: '',
    UTMIFY_API_TOKEN: '',
    ADMIN_SENHA: SENHA,
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
  espia.close();
  process.exit(codigo);
}

if (!subiu) {
  console.error('\nO servidor nao subiu.\n' + erroDoApp.slice(-1200));
  encerrar(1);
}

const base = `http://127.0.0.1:${PORTA_APP}`;

/* ========================================================================== */
console.log('\n== A conversao nasce SO com pagamento confirmado ==\n');

const ATRIB = {
  bm: 'bm2',
  utm_source: 'FB',
  utm_campaign: 'CTV_TESTE',
  utm_medium: 'CONJ_A',
  utm_content: 'AD_07',
  utm_term: 'reels',
  utm_id: 'uid1',
  fb_campaign_id: '120249664661600055',
  fb_adset_id: '120249664661600056',
  fb_ad_id: '120249664661600057',
  fb_placement: 'feed',
  fbclid: 'fbclid-de-teste',
  gclid: 'gclid-de-teste',
  ttclid: 'ttclid-de-teste',
  tt_campaign_id: 'ttc1',
  tt_adgroup_id: 'ttg1',
  tt_ad_id: 'tta1',
  landing_url: 'https://exemplo.invalido/?x=1',
  referrer: 'https://www.facebook.com/',
};

const criado = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Maria Mensuracao', email: 'maria.m@gmail.com', phone: '11988887777', document: cpfDeTeste(proximoCpf++) },
    attrib: ATRIB,
  }),
}).then((r) => r.json());
checar(criado.success === true, 'o PIX e criado', JSON.stringify(criado).slice(0, 160));
const pedidoId = criado.data?.id;

const sessao = await fetch(`${base}/api/admin/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: SENHA }),
}).then((r) => r.json());
const token = sessao.data?.token ?? '';
checar(Boolean(token), 'entra no painel');
const comAdmin = { 'X-Admin-Sessao': token };

const csv = (t) => fetch(`${base}/api/admin/conversoes.csv`, { headers: comAdmin }).then((r) => r.text());

const antesDePagar = await csv();
checar(
  !antesDePagar.includes(pedidoId),
  'QR gerado NAO vira conversao — o CSV nao tem o pedido',
  antesDePagar.slice(0, 200),
);
checar(antesDePagar.split('\n')[0].startsWith('order_id,paid_at,value,currency'), 'o CSV tem cabecalho mesmo vazio');

/* O mock confirma em 1,5 s; a consulta de status e o que aplica o pagamento. */
await new Promise((ok) => setTimeout(ok, 2200));
await fetch(`${base}/api/orders/${pedidoId}`).then((r) => r.json());
await new Promise((ok) => setTimeout(ok, 400));

const depoisDePagar = await csv();
checar(depoisDePagar.includes(pedidoId), 'pagamento confirmado VIRA conversao', depoisDePagar.slice(0, 300));

const linha = depoisDePagar.split('\n').find((l) => l.includes(pedidoId)) ?? '';
checar(linha.includes('"47.00"'), 'o valor sai em REAIS, nao em centavos', linha.slice(0, 200));
checar(linha.includes('"BRL"'), 'a moeda vai');
checar(linha.includes('"fbclid-de-teste"'), 'o fbclid vai');
checar(linha.includes('"CTV_TESTE"'), 'a campanha vai');
checar(linha.includes('"120249664661600057"'), 'o fb_ad_id vai');
checar(linha.includes('"gclid-de-teste"') && linha.includes('"ttclid-de-teste"'), 'gclid e ttclid vao');

/* --------------------------------------------------------- privacidade ---- */
checar(!linha.includes('maria.m@gmail.com'), 'o e-mail do cliente NAO vai no CSV');
checar(!linha.includes('11988887777'), 'o telefone NAO vai no CSV');
checar(!/\d{11}/.test(linha.replace(/1202496\d+/g, '')), 'o CPF NAO vai no CSV', linha.slice(0, 240));

/* ========================================================================== */
console.log('\n== A reentrega do webhook nao duplica ==\n');

const quantasLinhas = (texto) => texto.split('\n').filter((l) => l.includes(pedidoId)).length;
checar(quantasLinhas(depoisDePagar) === 1, 'uma linha para o pedido pago');

/* Forca a reconciliacao mais duas vezes: e o mesmo caminho do webhook reentregue. */
await fetch(`${base}/api/orders/${pedidoId}`).then((r) => r.json());
await fetch(`${base}/api/orders/${pedidoId}/access`).then((r) => r.json());
await new Promise((ok) => setTimeout(ok, 400));

const depoisDeRepetir = await csv();
checar(
  quantasLinhas(depoisDeRepetir) === 1,
  `continua UMA linha depois de reconsultar (veio ${quantasLinhas(depoisDeRepetir)})`,
);

/* ========================================================================== */
console.log('\n== O texto do quiz nao e mais gravado ==\n');

await fetch(`${base}/api/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    evento: 'EtapaDoFunil',
    session_id: 's-quiz-' + crypto.randomBytes(3).toString('hex'),
    step: 4,
    attrib: ATRIB,
    /* O funil NAO manda mais isto; o teste manda de proposito, para provar que
     * mesmo que alguem volte a mandar, nada disso vai para a exportacao. */
    resposta: { pergunta: 'Voce teme pela seguranca de alguem que ama?', escolha: 'Sim, todos os dias' },
  }),
});
await new Promise((ok) => setTimeout(ok, 300));

const csvComQuiz = await csv();
checar(
  !csvComQuiz.includes('teme pela seguranca') && !csvComQuiz.includes('todos os dias'),
  'nenhum texto de resposta de quiz aparece na exportacao',
);

/* ========================================================================== */
console.log('\n== Nada saiu para plataforma de anuncio ==\n');

checar(
  batidas.length === 0,
  `NENHUMA requisicao para o Meta durante o teste inteiro (foram ${batidas.length})`,
  batidas.slice(0, 5).join(' | '),
);

/* ========================================================================== */
console.log('\n== A injecao de formula no CSV ==\n');

const perigoso = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { name: 'Formula', email: 'formula@gmail.com', phone: '11955554444', document: cpfDeTeste(proximoCpf++) },
    attrib: { ...ATRIB, utm_content: '=HYPERLINK("http://mau","clique")', utm_campaign: 'com,virgula' },
  }),
}).then((r) => r.json());

await new Promise((ok) => setTimeout(ok, 2200));
await fetch(`${base}/api/orders/${perigoso.data.id}`).then((r) => r.json());
await new Promise((ok) => setTimeout(ok, 400));

const csvPerigoso = await csv();
const linhaPerigosa = csvPerigoso.split('\n').find((l) => l.includes(perigoso.data.id)) ?? '';
checar(
  linhaPerigosa.includes(`"'=HYPERLINK`),
  'campo que comeca com = ganha aspa simples: o Excel nao executa',
  linhaPerigosa.slice(0, 220),
);
checar(
  linhaPerigosa.includes('"com,virgula"'),
  'virgula dentro do campo nao quebra a coluna',
  linhaPerigosa.slice(0, 220),
);

/* ========================================================================== */
console.log('\n== A exportacao para o Meta ==\n');

const metaCsv = (qs = '') => fetch(`${base}/api/admin/conversoes-meta.csv${qs}`, { headers: comAdmin });

const respMeta = await metaCsv();
const textoMeta = await respMeta.text();
const cabecalhoMeta = textoMeta.split('\n')[0].replace(/^\uFEFF/, '');

checar(
  cabecalhoMeta === 'event_name,event_time,value,currency,order_id,em,ph,fn,ln,country,external_id',
  'o cabecalho usa os nomes da documentacao da Meta',
  cabecalhoMeta,
);

const linhaMeta = textoMeta.split('\n').find((l) => l.includes(pedidoId)) ?? '';
checar(Boolean(linhaMeta), 'a venda confirmada esta no arquivo');
checar(linhaMeta.startsWith('"Purchase"'), 'o evento e Purchase', linhaMeta.slice(0, 80));

/* event_time em SEGUNDOS unix: 10 digitos ate 2286. Milissegundos teriam 13. */
const tempo = (linhaMeta.split(',')[1] ?? '').replace(/"/g, '');
checar(/^[0-9]{10}$/.test(tempo), `event_time em segundos unix, nao milissegundos (veio ${tempo})`);

/* ------------------------------------------------------ o hash de verdade -- */
const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase(), 'utf8').digest('hex');

checar(linhaMeta.includes(sha('maria.m@gmail.com')), 'o e-mail vai como SHA-256 do valor normalizado');
checar(!linhaMeta.includes('maria.m@gmail.com'), 'e o e-mail em texto puro NAO aparece');
checar(linhaMeta.includes(sha('5511988887777')), 'o telefone vai com o 55 na frente, hasheado');
checar(!linhaMeta.includes('11988887777'), 'e o telefone em texto puro NAO aparece');
checar(
  linhaMeta.includes(sha('maria')) && linhaMeta.includes(sha('mensuracao')),
  'nome e sobrenome hasheados separados',
);
checar(linhaMeta.includes(sha('br')), 'o pais vai hasheado');
checar(linhaMeta.includes(sha(pedidoId)), 'external_id e o hash do nosso id de pedido');
checar(linhaMeta.includes(`"${pedidoId}"`), 'o order_id vai em texto puro: e a chave de dedupe do Meta');

/* ---------------------------------------------- fbclid/ad_id NAO entram ---- */
checar(
  !cabecalhoMeta.includes('fbclid') && !cabecalhoMeta.includes('fb_ad_id') && !cabecalhoMeta.includes('utm'),
  'fbclid, fb_ad_id e utm NAO estao no arquivo: nao sao chave de correspondencia',
  cabecalhoMeta,
);
checar(!linhaMeta.includes('fbclid-de-teste'), 'e o valor do fbclid tambem nao vaza para o arquivo');

/* -------------------------------------------------------------- preview ---- */
const preview = await fetch(`${base}/api/admin/conversoes-meta/preview`, { headers: comAdmin })
  .then((r) => r.json());
checar(preview.success === true, 'o preview responde', JSON.stringify(preview).slice(0, 200));
checar(preview.data?.exportaveis > 0, 'o preview conta as exportaveis', JSON.stringify(preview.data));
checar(preview.data?.comEmail > 0 && preview.data?.comTelefone > 0, 'conta quantas tem e-mail e telefone');
checar(preview.data?.jaExportadas === 0, 'antes de confirmar, nada esta exportado');
checar(Boolean(preview.data?.periodo?.fuso), 'o preview diz o fuso do periodo');

const previewCru = JSON.stringify(preview);
checar(
  !previewCru.includes('maria.m@gmail.com') && !previewCru.includes('11988887777'),
  'o preview NAO devolve e-mail nem telefone em texto puro',
);

/* ------------------------------------------- baixar NAO marca como exportado */
const contarLinhas = (t) => t.split('\n').filter((l) => l.trim() && !l.includes('event_name')).length;

const novasAntes = await metaCsv('?novas=1').then((r) => r.text());
checar(contarLinhas(novasAntes) > 0, 'antes de confirmar, ha conversoes novas');

const download = await metaCsv('?novas=1');
const batchId = download.headers.get('X-Export-Batch-Id') ?? '';
checar(Boolean(batchId), `o download devolve o batch_id (veio ${batchId})`);
checar(
  Number(download.headers.get('X-Conversoes-Exportadas')) > 0,
  `e a contagem no cabecalho (veio ${download.headers.get('X-Conversoes-Exportadas')})`,
);
await download.text();

const aindaNovas = await metaCsv('?novas=1').then((r) => r.text());
checar(
  contarLinhas(aindaNovas) === contarLinhas(novasAntes),
  `BAIXAR NAO MARCA: novas=1 continua com as mesmas ${contarLinhas(novasAntes)} linha(s) (veio ${contarLinhas(aindaNovas)})`,
);

const previewAposDownload = await fetch(`${base}/api/admin/conversoes-meta/preview`, { headers: comAdmin })
  .then((r) => r.json());
checar(previewAposDownload.data?.jaExportadas === 0, 'e o preview tambem continua dizendo zero exportadas');

/* --------------------------------------------------- confirmacao do lote --- */
const marcar = (corpo) => fetch(`${base}/api/admin/conversoes-meta/marcar`, {
  method: 'POST',
  headers: { ...comAdmin, 'Content-Type': 'application/json' },
  body: JSON.stringify(corpo),
});

const inexistente = await marcar({ batchId: 'lote_que_nao_existe' });
checar(inexistente.status === 404, `lote inexistente devolve 404 (veio ${inexistente.status})`);

const semId = await marcar({});
checar(semId.status === 400, `sem batch_id devolve 400 (veio ${semId.status})`);

const primeira = await marcar({ batchId }).then((r) => r.json());
checar(primeira.success === true, 'confirmar o lote funciona', JSON.stringify(primeira).slice(0, 200));
checar(primeira.data?.jaEstavaConfirmado === false, 'a primeira confirmacao nao diz que ja estava');
const dataDaPrimeira = primeira.data?.confirmadoEm;
checar(Boolean(dataDaPrimeira), `e devolve a data (veio ${dataDaPrimeira})`);

const novasDepois = await metaCsv('?novas=1');
checar(novasDepois.status === 400, 'depois de confirmar, novas=1 nao tem mais o que exportar');

const tudoDepois = await metaCsv().then((r) => r.text());
checar(contarLinhas(tudoDepois) > 0, 'mas a exportacao por periodo continua trazendo tudo');

/* --------------------------------------------------------- idempotencia ---- */
await new Promise((ok) => setTimeout(ok, 1100));
const segunda = await marcar({ batch_id: batchId }).then((r) => r.json());
checar(segunda.success === true, 'confirmar de novo responde ok (aceita snake_case tambem)');
checar(segunda.data?.jaEstavaConfirmado === true, 'e avisa que ja estava confirmado');
checar(
  segunda.data?.confirmadoEm === dataDaPrimeira,
  `a data da PRIMEIRA confirmacao e preservada (${dataDaPrimeira} vs ${segunda.data?.confirmadoEm})`,
);

/* ------------------------------------------- so o lote, e nada fora dele ---- */
const previewFinal = await fetch(`${base}/api/admin/conversoes-meta/preview`, { headers: comAdmin })
  .then((r) => r.json());
checar(
  previewFinal.data?.jaExportadas === primeira.data?.quantidade,
  `marcou exatamente as ${primeira.data?.quantidade} do lote (preview diz ${previewFinal.data?.jaExportadas})`,
);

/* -------------------------------------------------------- periodo ---------- */
const foraDaJanela = await metaCsv('?desde=2020-01-01&ate=2020-01-02');
checar(foraDaJanela.status === 400, 'periodo sem venda devolve erro claro em vez de CSV vazio');
const motivo = await foraDaJanela.json().catch(() => ({}));
checar(
  String(motivo.message ?? '').toLowerCase().includes('nenhuma venda'),
  'com a mensagem em portugues',
  JSON.stringify(motivo).slice(0, 160),
);

/* ========================================================================== */
console.log('\n== A exportacao exige login ==\n');

const semLogin = await fetch(`${base}/api/admin/conversoes.csv`);
checar(semLogin.status === 401, `conversoes.csv sem sessao e recusada (veio ${semLogin.status})`);
const semLoginMeta = await fetch(`${base}/api/admin/conversoes-meta.csv`);
checar(semLoginMeta.status === 401, `conversoes-meta.csv sem sessao e recusada (veio ${semLoginMeta.status})`);

const previewSemLogin = await fetch(`${base}/api/admin/conversoes-meta/preview`);
checar(previewSemLogin.status === 401, `preview sem sessao e recusado (veio ${previewSemLogin.status})`);

const marcarSemLogin = await fetch(`${base}/api/admin/conversoes-meta/marcar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ batchId }),
});
checar(marcarSemLogin.status === 401, `marcar sem sessao e recusado (veio ${marcarSemLogin.status})`);

/* ========================================================================== */

console.log('');
if (tudoOk) console.log('TODOS OS TESTES PASSARAM');
else console.log('HOUVE FALHAS');
encerrar(tudoOk ? 0 : 1);
