/**
 * Cada BM gasta o SEU dinheiro — e o painel sabe de quem é.
 *
 *   node scripts/testar-gasto-por-bm.mjs
 *
 * O defeito que esta bateria persegue não derruba tela nenhuma: é o gasto de
 * uma conta entrar na linha de outra. O total continua certo, os números
 * continuam plausíveis, e a tela passa a mostrar a BM boa com ROAS de 0,3 e a
 * ruim com ROAS de 4 — mandando desligar exatamente a que estava pagando.
 *
 * Por isso o Graph falso responde valores DIFERENTES por conta e exige o token
 * certo de cada uma: qualquer troca aparece como número trocado, e não como
 * erro. Nada sai para o Meta de verdade e nenhum token real é usado.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_GRAPH = 3398;
const PORTA_PIXGO = 3397;
const PORTA_APP = 3343;
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
const perto = (a, b) => a !== null && a !== undefined && Math.abs(a - b) < 0.01;

/* ========================================================================== */
/* Graph falso: cada conta tem gasto próprio e exige o token próprio           */
/* ========================================================================== */

/* Reais por dia, no nível campanha. Valores distintos de propósito: trocar duas
   contas de lugar tem de aparecer como número trocado. */
const CONTAS = {
  act_111: { token: 'T-ALPHA', gasto: '100.00', campanha: 'c-alpha' },
  act_222: { token: 'T-BETA', gasto: '20.00', campanha: 'c-beta' },
  // A terceira recusa o token: é o caso "uma conta cai e as outras seguem".
  act_333: { token: 'NENHUM', gasto: '999.00', campanha: 'c-gama' },
};

const chamadas = [];

const graphFalso = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA_GRAPH}`);
  const conta = (url.pathname.match(/\/(act_\d+)\//) ?? [])[1] ?? '';
  const token = url.searchParams.get('access_token') ?? '';
  const colecao = url.pathname.split('/').pop();

  chamadas.push({ conta, token, colecao, nivel: url.searchParams.get('level') });

  const responder = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const cadastrada = CONTAS[conta];
  if (!cadastrada) return responder(400, { error: { message: 'Conta inexistente', code: 100 } });
  if (token !== cadastrada.token) {
    return responder(401, { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } });
  }

  // O cadastro (nome/situação) não interessa aqui: lista vazia é resposta válida.
  if (['campaigns', 'adsets', 'ads'].includes(colecao)) return responder(200, { data: [] });

  /*
   * O dia vem do `until` do próprio pedido: assim a linha cai SEMPRE dentro da
   * janela que o painel pediu, sem este script precisar adivinhar qual é o dia
   * em São Paulo — que é o erro que faz a bateria falhar às 21 h e passar às 10 h.
   */
  let dia = new Date().toISOString().slice(0, 10);
  try { dia = JSON.parse(url.searchParams.get('time_range') ?? '{}').until ?? dia; } catch { /* fica o padrão */ }

  const nivel = url.searchParams.get('level');
  const campo = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }[nivel];
  if (!campo) return responder(200, { data: [] });

  responder(200, {
    data: [{
      date_start: dia,
      spend: cadastrada.gasto,
      impressions: '1000',
      clicks: '25',
      [campo]: `${cadastrada.campanha}-${nivel}`,
    }],
  });
});
await new Promise((ok) => graphFalso.listen(PORTA_GRAPH, ok));

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
  console.error(`\nA porta ${PORTA_APP} já está ocupada — encerre o servidor órfão.\n`);
  graphFalso.close(); pixgoFalsa.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'gastobm-'));

/* O painel copiado para a pasta temporária: o servidor roda com `cwd` vazio de
   propósito (senão leria o .env.local da raiz e falaria com a PixGo de verdade),
   e app.ts resolve o dist contra esse mesmo cwd. Ver testar-aba-resumo.mjs. */
const distOrigem = path.join(raiz, 'dist');
if (process.env.PLAYWRIGHT_DIR) {
  if (!existsSync(path.join(distOrigem, 'admin.html'))) {
    console.error('\nRode `npm run build` antes: a parte da tela precisa do dist/ gerado.\n');
    graphFalso.close(); pixgoFalsa.close();
    process.exit(1);
  }
  const distDestino = path.join(dataDir, 'dist');
  mkdirSync(distDestino, { recursive: true });
  for (const arquivo of readdirSync(distOrigem)) {
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
    META_BASE_URL: `http://localhost:${PORTA_GRAPH}`,
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: senhaPainel,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    STATUS_POLL_MIN_INTERVAL_MS: '0',
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

function matarArvore() {
  if (app.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já morreu */ }
    return;
  }
  try { app.kill(); } catch { /* já morreu */ }
}
function encerrar(codigo) { matarArvore(); graphFalso.close(); pixgoFalsa.close(); process.exit(codigo); }
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
const token = sessao.data?.token ?? '';
const cab = { 'X-Admin-Sessao': token, 'Content-Type': 'application/json' };
checar(Boolean(token), 'entra no painel');

/* ========================================================================== */
/* Três BMs, três contas, três tokens                                          */
/* ========================================================================== */

console.log('\n== Cadastro dos três gerenciadores ==\n');

const cadastro = await pedir('/api/admin/bms', {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    bms: [
      { slug: 'alpha', nome: 'BM Alpha', pixelId: '111111111111111', contaAds: 'act_111', ativa: true },
      { slug: 'beta', nome: 'BM Beta', pixelId: '222222222222222', contaAds: 'act_222', ativa: true },
      { slug: 'gama', nome: 'BM Gama', pixelId: '333333333333333', contaAds: 'act_333', ativa: true },
    ],
    /*
     * `tokens` é o da API de CONVERSÕES e `tokensAds` é o de LEITURA — e aqui
     * eles são DIFERENTES de propósito.
     *
     * É o único jeito de provar que o painel não os confunde. Se a importação
     * de gasto usasse o de Conversões, o Graph falso recusaria e a alpha
     * falharia; se o rastreamento usasse o de leitura, o pixel receberia a
     * credencial errada. Com valores iguais, os dois defeitos passariam.
     */
    tokens: { alpha: 'CAPI-ALPHA', beta: 'CAPI-BETA', gama: 'CAPI-GAMA' },
    tokensAds: { alpha: 'T-ALPHA', beta: 'T-BETA', gama: 'TOKEN-VENCIDO' },
  }),
});
checar(cadastro.success === true, 'grava as três BMs', JSON.stringify(cadastro).slice(0, 160));

/* ========================================================================== */
/* Vendas com carimbo de BM                                                    */
/* ========================================================================== */

console.log('\n== Vendas carimbadas ==\n');

async function venderPara(bm) {
  await pedir('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      customer: { name: 'Maria', email: 'maria@exemplo.com', phone: '11912345678', document: '52998224725' },
      attrib: { bm, utm_source: 'facebook', fb_campaign_id: `c-${bm}` },
      session_id: `s-${bm}-${crypto.randomBytes(3).toString('hex')}`,
    }),
  });
  const id = [...cobrancas.keys()].at(-1);
  cobrancas.get(id).status = 'completed';
  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: id, status: 'completed' });
  const seg = Math.floor(Date.now() / 1000);
  await pedir('/api/webhooks/pix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Timestamp': String(seg),
      'X-Webhook-Signature': crypto.createHmac('sha256', SEGREDO_PIX).update(`${seg}.${corpo}`).digest('hex'),
    },
    body: corpo,
  });
}

const PRECO = 4700; // server/catalog.ts, offer `main`
await venderPara('alpha');
await venderPara('alpha');
await venderPara('beta');

/* ========================================================================== */
/* A importação do gasto, conta por conta                                      */
/* ========================================================================== */

console.log('\n== Importação por conta ==\n');

const imp = await pedir('/api/admin/bms/importar-gasto', {
  method: 'POST', headers: cab, body: JSON.stringify({ dias: 1 }),
});
checar(imp.success === true, 'a importação responde', JSON.stringify(imp).slice(0, 200));

const porBm = Object.fromEntries((imp.data?.contas ?? []).map((c) => [c.bm, c]));
checar(porBm.alpha?.ok === true, 'alpha importou', JSON.stringify(porBm.alpha));
checar(porBm.beta?.ok === true, 'beta importou', JSON.stringify(porBm.beta));
/*
 * O caso que mais importa: a conta com token vencido falha SOZINHA. Se ela
 * derrubasse a importação inteira, o dono veria a tela zerada e concluiria que
 * ninguém vendeu — no dia em que mais precisa decidir.
 */
checar(porBm.gama?.ok === false, 'gama falhou', JSON.stringify(porBm.gama));
checar(
  Boolean(porBm.gama?.erro),
  'a falha da gama vem com motivo escrito',
  String(porBm.gama?.erro),
);
checar(
  String(imp.data?.mensagem ?? '').includes('BM Gama'),
  'a mensagem nomeia a conta que falhou',
  String(imp.data?.mensagem).slice(0, 140),
);

// R$ 100,00 e R$ 20,00, só o nível campanha.
checar(porBm.alpha?.totalCentavos === 10000, `alpha gastou R$ 100 (veio ${porBm.alpha?.totalCentavos})`);
checar(porBm.beta?.totalCentavos === 2000, `beta gastou R$ 20 (veio ${porBm.beta?.totalCentavos})`);

/* Cada conta foi lida com o token DELA. Sem isto, o gasto de uma entraria na
   linha da outra e nenhum erro apareceria. */
const pares = chamadas.filter((c) => c.colecao === 'insights').map((c) => `${c.conta}:${c.token}`);
checar(pares.includes('act_111:T-ALPHA'), 'act_111 foi lida com o token da alpha');
checar(pares.includes('act_222:T-BETA'), 'act_222 foi lida com o token da beta');
checar(
  !pares.some((p) => p === 'act_111:T-BETA' || p === 'act_222:T-ALPHA'),
  'nenhuma conta foi lida com o token da outra',
  pares.join(' '),
);
/*
 * O token de CONVERSÕES nunca é usado para ler a conta de anúncios.
 *
 * São credenciais de escopos diferentes: o de Conversões sai do Gerenciador de
 * Eventos e não tem `ads_read`. Confundi-los faz o rastreamento funcionar e a
 * importação de gasto falhar com um erro que não menciona campo nenhum — foi
 * exatamente o defeito que existiu entre 19 e 20/08/2026.
 */
checar(
  !pares.some((p) => p.includes('CAPI-')),
  'o token de Conversões nunca é usado para ler o gasto',
  pares.join(' '),
);

const salvasNoPainel = (await pedir('/api/admin/bms?dias=1', { headers: cab })).data?.bms ?? [];
const alphaSalva = salvasNoPainel.find((b) => b.slug === 'alpha');
checar(
  Boolean(alphaSalva?.tokenMascarado) && Boolean(alphaSalva?.tokenAdsMascarado),
  'os dois tokens voltam mascarados, cada um no seu campo',
  JSON.stringify(alphaSalva).slice(0, 160),
);
checar(
  alphaSalva?.tokenMascarado !== alphaSalva?.tokenAdsMascarado,
  'as duas máscaras são de tokens diferentes, e não do mesmo repetido',
);
checar(
  !JSON.stringify(salvasNoPainel).includes('T-ALPHA')
  && !JSON.stringify(salvasNoPainel).includes('CAPI-ALPHA'),
  'nenhum token inteiro volta para o navegador',
);

/* ========================================================================== */
/* A aba BMs                                                                   */
/* ========================================================================== */

console.log('\n== A tabela de BMs ==\n');

const bms = (await pedir('/api/admin/bms?dias=1', { headers: cab })).data;
const de = (slug) => (bms?.bms ?? []).find((b) => b.slug === slug);

checar(bms?.temInvestimentoPorBm === true, 'a tela sabe que agora há gasto carimbado');
checar(de('alpha')?.investimentoCentavos === 10000, `alpha: gasto na linha certa (veio ${de('alpha')?.investimentoCentavos})`);
checar(de('beta')?.investimentoCentavos === 2000, `beta: gasto na linha certa (veio ${de('beta')?.investimentoCentavos})`);
checar(de('gama')?.investimentoCentavos === 0, `gama falhou, então fica sem gasto (veio ${de('gama')?.investimentoCentavos})`);

checar(de('alpha')?.receitaCentavos === PRECO * 2, `alpha vendeu duas (veio ${de('alpha')?.receitaCentavos})`);
checar(de('beta')?.receitaCentavos === PRECO, `beta vendeu uma (veio ${de('beta')?.receitaCentavos})`);

// 9400 ÷ 10000 = 0,94 · 4700 ÷ 2000 = 2,35
checar(perto(de('alpha')?.roas, 0.94), `ROAS da alpha (veio ${de('alpha')?.roas})`);
checar(perto(de('beta')?.roas, 2.35), `ROAS da beta (veio ${de('beta')?.roas})`);
/*
 * A prova de que a separação vale a pena: juntas, as duas dariam ROAS 1,175 e
 * pareceriam um negócio só, mediano. Separadas, uma está queimando caixa e a
 * outra pagando — e são decisões OPOSTAS sobre a verba de amanhã.
 */
checar(
  de('alpha').roas < 1 && de('beta').roas > 2,
  'as duas contas contam histórias opostas, como devem',
);

// Sem modelo de custo, lucro = receita − anúncio, igual ao painel antigo.
checar(de('alpha')?.lucroCentavos === 9400 - 10000, `lucro da alpha (veio ${de('alpha')?.lucroCentavos})`);
checar(de('beta')?.lucroCentavos === 4700 - 2000, `lucro da beta (veio ${de('beta')?.lucroCentavos})`);

/* ========================================================================== */
/* O Resumo filtrado por BM                                                    */
/* ========================================================================== */

console.log('\n== Resumo por BM ==\n');

const geral = (await pedir('/api/admin/resumo?dias=1', { headers: cab })).data;
checar(geral.receitaBrutaCentavos === PRECO * 3, `geral soma as três vendas (veio ${geral.receitaBrutaCentavos})`);
checar(geral.investimentoCentavos === 12000, `geral soma os dois gastos (veio ${geral.investimentoCentavos})`);

const soAlpha = (await pedir('/api/admin/resumo?dias=1&bm=alpha', { headers: cab })).data;
checar(soAlpha.bm === 'alpha', 'o resumo assume o filtro');
checar(soAlpha.receitaBrutaCentavos === PRECO * 2, `receita só da alpha (veio ${soAlpha.receitaBrutaCentavos})`);
/*
 * O ponto inteiro do filtro: o gasto tem de encolher JUNTO com a receita. Se
 * ficasse os R$ 120 do total, a alpha apareceria com prejuízo que não é dela.
 */
checar(soAlpha.investimentoCentavos === 10000, `gasto só da alpha (veio ${soAlpha.investimentoCentavos})`);
checar(soAlpha.investimentoDaBmDisponivel === true, 'a alpha tem gasto importado');

const soGama = (await pedir('/api/admin/resumo?dias=1&bm=gama', { headers: cab })).data;
checar(soGama.investimentoDaBmDisponivel === false, 'a gama avisa que não tem gasto importado');

const forjada = (await pedir("/api/admin/resumo?dias=1&bm=' OR 1=1--", { headers: cab }));
checar(forjada.success === true, 'BM forjada não quebra a rota', String(forjada.status));
checar(forjada.data?.bm === null, 'BM forjada é descartada, e o resumo volta geral', String(forjada.data?.bm));

/* ========================================================================== */
/* Gasto digitado a mao, herdando a BM da tela                                 */
/* ========================================================================== */

console.log('\n== Gasto digitado a mão ==\n');

/*
 * O caminho de quem AINDA nao tem token de leitura: copia o gasto do
 * Gerenciador de Anuncios e digita no painel com a BM filtrada. Sem isto, o
 * dono das tres contas so veria ROAS por BM depois de resolver a burocracia do
 * usuario do sistema -- que pode levar dias.
 */
/*
 * O dia vem do SERVIDOR, não do relógio deste processo. Entre 21 h e a
 * meia-noite o UTC já virou e `toISOString()` devolveria o dia seguinte — o
 * gasto entraria num dia que a janela não cobre e a bateria acusaria falha no
 * lugar errado.
 */
const hoje = (await pedir('/api/admin/anuncios?dias=1', { headers: cab })).data?.periodo?.diaDeHoje;

const aMao = await pedir('/api/admin/investimento', {
  method: 'POST', headers: cab,
  body: JSON.stringify({ chave: 'camp-digitada', dia: hoje, nivel: 'campanha', valor: '33,00', bm: 'beta' }),
});
checar(aMao.success === true, 'grava gasto digitado a mao', JSON.stringify(aMao).slice(0, 160));
checar(aMao.data?.bm === 'beta', `o gasto herda a BM filtrada (veio "${aMao.data?.bm}")`);

const semFiltro = await pedir('/api/admin/investimento', {
  method: 'POST', headers: cab,
  body: JSON.stringify({ chave: 'camp-sem-dono', dia: hoje, nivel: 'campanha', valor: '11,00' }),
});
checar(
  semFiltro.data?.bm === '',
  `sem filtro, grava sem carimbo em vez de chutar (veio "${semFiltro.data?.bm}")`,
);

const forjadoNoGasto = await pedir('/api/admin/investimento', {
  method: 'POST', headers: cab,
  body: JSON.stringify({ chave: 'camp-forjada', dia: hoje, nivel: 'campanha', valor: '1,00', bm: "' OR 1=1--" }),
});
checar(forjadoNoGasto.data?.bm === '', 'BM forjada no gasto e descartada');

const depoisDeDigitar = (await pedir('/api/admin/bms?dias=1', { headers: cab })).data;
const beta2 = (depoisDeDigitar?.bms ?? []).find((b) => b.slug === 'beta');
// 2000 que veio do Meta + 3300 digitados
checar(
  beta2?.investimentoCentavos === 5300,
  `o digitado soma com o importado na linha da beta (veio ${beta2?.investimentoCentavos})`,
);

/* ========================================================================== */
/* A tela                                                                      */
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
  const errosDeTela = [];
  pg.on('pageerror', (e) => errosDeTela.push(String(e).slice(0, 160)));

  await pg.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await pg.fill('#senha', senhaPainel);
  await pg.click('#botaoEntrar');
  await pg.waitForSelector('#painel:not([hidden])', { timeout: 15000 });
  await pg.click('.abas [data-aba="bms"]');
  await pg.waitForTimeout(2500);

  /*
   * Cabeçalho, corpo e rodapé têm de ter o MESMO número de colunas.
   *
   * As três colunas de dinheiro foram acrescentadas em três lugares diferentes
   * do desenho da tabela. Esquecer um deles não dá erro nenhum: a tabela apenas
   * sai torta, com o valor de uma coluna aparecendo sob o título de outra — e
   * quem lê "Lucro" embaixo do título "ROAS" decide errado com toda a confiança.
   */
  const nCabecalho = await pg.locator('#cabecalhoBms th').count();
  const nLinha = await pg.locator('#corpoBms tr[data-bm]').first().locator('td').count();
  const nRodape = await pg.locator('#rodapeBms th').count();
  checar(
    nCabecalho === nLinha && nLinha === nRodape,
    `cabeçalho, linha e rodapé têm o mesmo número de colunas (${nCabecalho}/${nLinha}/${nRodape})`,
  );

  /*
   * Comparação em maiúsculas: o CSS da tabela aplica `text-transform`, então o
   * texto lido da tela volta como "INVESTIDO" mesmo escrito "Investido" no
   * código. Comparar com a caixa do código reprova uma coluna que está lá.
   */
  const titulos = (await pg.locator('#cabecalhoBms th').allInnerTexts()).map((t) => t.trim().toUpperCase());
  checar(titulos.includes('INVESTIDO'), 'a coluna Investido aparece', titulos.join('|'));
  checar(titulos.includes('ROAS'), 'a coluna ROAS aparece', titulos.join('|'));
  checar(titulos.includes('LUCRO'), 'a coluna Lucro aparece', titulos.join('|'));

  const textoAlpha = await pg.locator('#corpoBms tr[data-bm="alpha"]').innerText();
  checar(textoAlpha.includes('0,94x'), 'o ROAS da alpha está na linha dela', textoAlpha.replace(/\n/g, ' '));
  checar(
    (await pg.locator('#corpoBms tr[data-bm="alpha"] .num.ruim').count()) >= 1,
    'ROAS abaixo da meta e lucro negativo saem marcados',
  );

  checar((await pg.locator('#importarGastoBms').count()) === 1, 'o botão de importar gasto existe');

  /*
   * O chip "Hoje" tem de pedir 1 dia, não 0.
   *
   * `recortePedido` exige `dias > 0` e, com 0, cai no padrão de SETE dias: a
   * aba mostrava a semana inteira com o botão "Hoje" aceso. Nada quebrava e
   * nada aparecia no console — só um número alto demais, que quem está
   * decidindo verba naquele dia lê como sendo do dia. Foi assim que passou
   * despercebido até o dono estranhar o total.
   */
  const diasDoHoje = await pg.locator('#chipsPeriodoBms button', { hasText: /^Hoje$/ }).getAttribute('data-dias');
  checar(diasDoHoje === '1', `o chip "Hoje" pede 1 dia, não 0 (veio ${diasDoHoje})`);

  await pg.locator('#chipsPeriodoBms button', { hasText: /^Hoje$/ }).click();
  await pg.waitForTimeout(2500);
  const janela = await pg.evaluate(() => window.estado?.bms?.periodo ?? null);
  checar(
    Boolean(janela) && janela.diaInicial === janela.diaFinal,
    `clicando "Hoje", a janela é de um dia só (veio ${JSON.stringify(janela)})`,
  );
  checar(errosDeTela.length === 0, 'nenhum erro de JavaScript', errosDeTela.slice(0, 3).join(' | '));
  await nav.close();
}

console.log(tudoOk
  ? '\nPASSOU — cada BM gasta o seu dinheiro, e o painel sabe de quem é.'
  : '\nREPROVOU: veja as linhas FALHOU acima.');
encerrar(tudoOk ? 0 : 1);
