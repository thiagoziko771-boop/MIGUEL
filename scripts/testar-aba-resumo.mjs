/**
 * A aba Resumo, de ponta a ponta: venda de verdade, custo de verdade, tela.
 *
 *   node scripts/testar-aba-resumo.mjs
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-aba-resumo.mjs   # + a tela
 *
 * O que esta bateria persegue não é a tela quebrar — é ela mentir. Um "Lucro"
 * que ignora a taxa do gateway continua sendo um número bonito, e é justamente
 * essa aparência de normalidade que faz o dono triplicar o orçamento de um
 * anúncio que está empatando. Por isso cada valor esperado abaixo vem com a
 * conta escrita ao lado.
 *
 * Nada aqui toca dinheiro: sobe uma PixGo falsa local, o servidor roda numa
 * pasta temporária e o banco fica em arquivo.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_PIXGO = 3396;
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
const perto = (a, b) => a !== null && a !== undefined && Math.abs(a - b) < 0.005;

/* ========================================================================== */
/* PixGo falsa                                                                 */
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
  console.error(`\nA porta ${PORTA_APP} já está ocupada — encerre o servidor órfão antes de rodar.\n`);
  pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'resumo-app-'));

/*
 * O painel copiado para dentro da pasta temporária.
 *
 * O servidor roda com `cwd` numa pasta vazia de propósito — server/config.ts
 * carrega o .env.local do diretório atual com `override: true`, e rodar na raiz
 * faria esta bateria falar com a PixGo DE VERDADE e criar cobrança de dinheiro
 * real. Mas `app.ts` resolve o `dist` contra o mesmo `cwd`, então /admin não
 * existiria e a parte da tela morreria esperando o campo de senha.
 *
 * Copiar só os arquivos do painel (não o funil inteiro) resolve os dois: a
 * pasta continua sem .env.local e a tela sobe. São ~200 kB de HTML/CSS/JS sem
 * build, porque o painel é justamente isso.
 */
const distOrigem = path.join(raiz, 'dist');
if (process.env.PLAYWRIGHT_DIR) {
  if (!existsSync(path.join(distOrigem, 'admin.html'))) {
    console.error('\nRode `npm run build` antes: a parte da tela precisa do dist/ gerado.\n');
    pixgoFalsa.close();
    process.exit(1);
  }
  const distDestino = path.join(dataDir, 'dist');
  mkdirSync(distDestino, { recursive: true });
  for (const arquivo of readdirSync(distOrigem)) {
    // `admin.*`, e não `admin[.-].*\.`: o segundo exigiria dois pontos no nome e
    // deixaria de fora justamente admin.html, admin.css e admin.js.
    if (/^admin.*\.(html|css|js)$/.test(arquivo) || arquivo === 'index.html') {
      copyFileSync(path.join(distOrigem, arquivo), path.join(distDestino, arquivo));
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
    STATUS_POLL_MIN_INTERVAL_MS: '0',
    // Sem isto o servidor só responde /api: fora de produção o estático fica
    // desligado, e a parte da tela morreria esperando o campo de senha.
    SERVE_STATIC: process.env.PLAYWRIGHT_DIR ? 'true' : 'false',
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

/** Mata o servidor E os filhos: no Windows `kill` derruba só o npx. */
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

/** `Connection: close`: sem isso o fetch seguinte estoura ECONNRESET no meio. */
async function pedir(caminho, opcoes) {
  opcoes = opcoes || {};
  const r = await fetch(`${base}${caminho}`, { ...opcoes, headers: { Connection: 'close', ...(opcoes.headers ?? {}) } });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

const sessao = await pedir('/api/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: senhaPainel }),
});
const token = sessao.data?.token ?? '';
const cab = { 'X-Admin-Sessao': token, 'Content-Type': 'application/json' };
checar(Boolean(token), 'entra no painel');

/* ========================================================================== */
/* PARTE 1 — o resumo antes de qualquer custo configurado                      */
/* ========================================================================== */

console.log('\n== Antes de configurar custos ==\n');

const carimbo = { utm_source: 'facebook', utm_campaign: 'RS_video01', fb_campaign_id: '120200' };

async function criarPedido(atrib) {
  return pedir('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      customer: { name: 'Maria de Teste', email: 'maria@exemplo.com', phone: '11912345678', document: '52998224725' },
      attrib: atrib, session_id: 'sessao-' + crypto.randomBytes(3).toString('hex'),
    }),
  });
}

async function confirmar(idCobranca) {
  cobrancas.get(idCobranca).status = 'completed';
  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
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

// Duas vendas com carimbo, uma sem (vira "direto"), e um PIX que fica esperando.
await criarPedido(carimbo);
await confirmar([...cobrancas.keys()].at(-1));
await criarPedido(carimbo);
await confirmar([...cobrancas.keys()].at(-1));
await criarPedido({});
await confirmar([...cobrancas.keys()].at(-1));
await criarPedido(carimbo); // fica pendente

const precoDaOferta = 4700; // server/catalog.ts, offer `main`
const brutoEsperado = precoDaOferta * 3;

const hoje = (await pedir('/api/admin/anuncios?dias=1', { headers: cab })).data?.periodo?.diaDeHoje;
await pedir('/api/admin/investimento', {
  method: 'POST', headers: cab,
  body: JSON.stringify({ chave: carimbo.fb_campaign_id, dia: hoje, valor: '50,00' }),
});

let r = (await pedir('/api/admin/resumo?dias=1', { headers: cab })).data;

checar(r?.custosConfigurados === false, 'a tela sabe que ninguém preencheu os custos ainda');
checar(r.receitaBrutaCentavos === brutoEsperado, `bruto = 3 × R$ 47,00 (veio ${r.receitaBrutaCentavos})`);
checar(r.vendas === 3, `três cobranças pagas (veio ${r.vendas})`);
checar(r.pendentes === 1 && r.pendenteCentavos === precoDaOferta, 'um PIX esperando, com o valor certo');
checar(r.investimentoCentavos === 5000, `gasto anotado = R$ 50,00 (veio ${r.investimentoCentavos})`);
checar(r.custos.taxasCentavos === 0, 'sem modelo, a taxa é zero');
/*
 * Sem custos configurados, a conta tem de reproduzir EXATAMENTE o painel de
 * antes. Quem ainda não preencheu não pode ver o próprio lucro mudar sozinho
 * por causa de um deploy.
 */
checar(
  r.custos.lucroCentavos === brutoEsperado - 5000,
  `sem modelo, lucro volta a ser receita − anúncio (veio ${r.custos.lucroCentavos})`,
);
checar(perto(r.taxaDeAprovacao, 3 / 4), `3 dos 4 PIX gerados pagaram (veio ${r.taxaDeAprovacao})`);

const fb = r.vendasPorFonte.find((f) => f.chave === 'facebook');
const direto = r.vendasPorFonte.find((f) => f.chave === 'direto');
checar(fb?.vendas === 2 && fb?.centavos === precoDaOferta * 2, 'duas vendas vieram do facebook');
checar(direto?.vendas === 1, 'a venda sem carimbo aparece como "direto", em vez de sumir');
checar(r.formasDePagamento[0]?.chave === 'pix', 'as vendas foram por PIX');

/* ========================================================================== */
/* PARTE 2 — com o modelo de custo preenchido                                  */
/* ========================================================================== */

console.log('\n== Depois de preencher os custos ==\n');

const salvou = await pedir('/api/admin/custos', {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    gatewayPercentual: '5',
    gatewayFixoCentavos: 100,
    impostoSobreVendaPercentual: '6',
    impostoMetaAdsPercentual: '10',
    custoPorVendaCentavos: 0,
  }),
});
checar(salvou.success === true, 'grava o modelo de custo', JSON.stringify(salvou).slice(0, 200));

// Campo em branco NÃO pode virar zero: apagaria a taxa em silêncio.
const recusa = await pedir('/api/admin/custos', {
  method: 'POST', headers: cab, body: JSON.stringify({ gatewayPercentual: 'abc' }),
});
checar(recusa.status === 400, `percentual inválido é recusado, não vira zero (veio ${recusa.status})`);
const aindaLa = (await pedir('/api/admin/custos', { headers: cab })).data?.custos;
checar(aindaLa?.gatewayPercentual === 5, `a taxa continua 5% depois da recusa (veio ${aindaLa?.gatewayPercentual})`);

r = (await pedir('/api/admin/resumo?dias=1', { headers: cab })).data;

// bruto = 14100 · vendas = 3 · devolvido = 0 · leilão = 5000
// taxa   = 14100 × 5% + 3 × 100 = 705 + 300 = 1005
// imposto da venda = 14100 × 6% = 846
// imposto do anúncio = 5000 × 10% = 500 · gasto total = 5500
// líquido = 14100 − 1005 − 846 = 12249 · lucro = 12249 − 5500 = 6749
checar(r.custosConfigurados === true, 'a tela para de avisar depois de preenchido');
checar(r.custos.taxasCentavos === 1005, `taxa = 14100×5% + 3×R$1 (veio ${r.custos.taxasCentavos})`);
checar(r.custos.impostoSobreVendasCentavos === 846, `imposto da venda (veio ${r.custos.impostoSobreVendasCentavos})`);
checar(r.custos.impostoMetaAdsCentavos === 500, `imposto do anúncio (veio ${r.custos.impostoMetaAdsCentavos})`);
checar(r.custos.gastoTotalCentavos === 5500, `gasto total = leilão + imposto (veio ${r.custos.gastoTotalCentavos})`);
checar(r.custos.receitaLiquidaCentavos === 12249, `líquido (veio ${r.custos.receitaLiquidaCentavos})`);
checar(r.custos.lucroCentavos === 6749, `lucro (veio ${r.custos.lucroCentavos})`);
/*
 * A prova de que o modelo importa: sem ele o painel diria R$ 91,00 de lucro
 * nestes mesmos pedidos, e o certo é R$ 67,49.
 *
 * A diferença — R$ 23,51, que é taxa (1005) + imposto da venda (846) + imposto
 * do anúncio (500) — vale 16,7% do faturamento do período. Num negócio que
 * escala com ROAS 2x, errar 16,7% para cima é a distância entre lucrar e
 * financiar o leilão do Meta com dinheiro próprio.
 */
checar(
  brutoEsperado - 5000 - r.custos.lucroCentavos === 2351,
  `o modelo derruba o lucro em R$ 23,51 sobre R$ 141,00 — o tamanho do erro antigo (veio ${brutoEsperado - 5000 - r.custos.lucroCentavos})`,
);
checar(perto(r.custos.roas, 14100 / 5000), `ROAS usa o leilão, como o Gerenciador (veio ${r.custos.roas})`);
checar(perto(r.custos.roi, 6749 / 5500), `ROI usa o gasto total (veio ${r.custos.roi})`);
checar(r.roasDeEquilibrio !== null && r.roasDeEquilibrio > 1, `a tela sabe onde o anúncio empata (veio ${r.roasDeEquilibrio})`);

/* ========================================================================== */
/* PARTE 3 — despesas                                                          */
/* ========================================================================== */

console.log('\n== Despesas ==\n');

const desp = await pedir('/api/admin/despesas', {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    despesas: [
      { dia: hoje, descricao: 'copy do criativo', centavos: 15000, mensal: false },
      { dia: hoje, descricao: 'ferramenta', centavos: 30000, mensal: true },
      // Lixo: precisa cair fora sem derrubar as boas.
      { dia: 'ontem', descricao: 'data inválida', centavos: 100 },
      { dia: hoje, descricao: '', centavos: 500 },
    ],
  }),
});
checar(desp.data?.despesas?.length === 2, `só as 2 válidas entram (veio ${desp.data?.despesas?.length})`);

r = (await pedir('/api/admin/resumo?dias=1', { headers: cab })).data;
// única 15000 + mensal 30000÷30×1 = 1000
checar(r.despesasCentavos === 16000, `única inteira + mensal rateada por dia (veio ${r.despesasCentavos})`);
checar(r.custos.lucroCentavos === 6749 - 16000, `a despesa entra no lucro (veio ${r.custos.lucroCentavos})`);

// Na janela de 30 dias a mensal vale o mês inteiro, a única continua uma só.
const trinta = (await pedir('/api/admin/resumo?dias=30', { headers: cab })).data;
checar(trinta.despesasCentavos === 45000, `em 30 dias a mensal vale o mês (veio ${trinta.despesasCentavos})`);

/* ========================================================================== */
/* PARTE 4 — a tela                                                            */
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

  checar((await pg.locator('.abas [data-aba="resumo"]').count()) === 1, 'a aba Resumo existe');
  await pg.click('.abas [data-aba="resumo"]');
  await pg.waitForTimeout(2500);
  checar(await pg.locator('#abaResumo').isVisible(), 'a seção abre');

  const cartoes = await pg.locator('#kpisResumo .kpi').count();
  checar(cartoes >= 16, `os cartões aparecem (veio ${cartoes})`);

  const texto = await pg.locator('#kpisResumo').innerText();
  checar(texto.includes('Lucro'), 'o cartão de Lucro está na tela');
  checar(texto.includes('Chargeback'), 'chargeback tem cartão próprio, separado do reembolso');
  checar(texto.includes('Taxa de aprovação'), 'a taxa de aprovação virou manchete');

  // Custos preenchidos: o aviso tem de estar escondido.
  checar(await pg.locator('#avisoCustos').isHidden(), 'sem aviso quando os custos estão preenchidos');
  checar(
    (await pg.locator('#custoGatewayPercentual').inputValue()) === '5',
    'o formulário volta preenchido com o que foi salvo',
  );

  const linhasDespesa = await pg.locator('#corpoDespesas tr[data-linha]').count();
  checar(linhasDespesa === 2, `as despesas viram linhas editáveis (veio ${linhasDespesa})`);

  await pg.click('#novaDespesa');
  checar(
    (await pg.locator('#corpoDespesas tr[data-linha]').count()) === 3,
    'adicionar linha não apaga as que já estavam',
  );

  checar(erros.length === 0, 'nenhum erro de JavaScript', erros.slice(0, 3).join(' | '));
  await nav.close();
}

console.log(tudoOk
  ? '\nPASSOU — o Resumo conta a verdade sobre o que sobrou.'
  : '\nREPROVOU: veja as linhas FALHOU acima.');
encerrar(tudoOk ? 0 : 1);
