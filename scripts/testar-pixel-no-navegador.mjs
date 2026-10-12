/**
 * Qual pixel o NAVEGADOR realmente inicializa, com carimbo de BM e sem ele.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pixel-no-navegador.mjs
 *
 * POR QUE ESTA BATERIA EXISTE. Havia um teste que conferia o ENDPOINT
 * (`testar-pixel-por-bm.mjs`, 8/8 passando) e ele nunca pegou o defeito: o
 * servidor devolvia o pixel certo para cada BM, e o navegador ignorava a
 * resposta. `iniciarPixel` via `VITE_META_PIXEL_ID` preenchido, injetava o pixel
 * do build e retornava ANTES de perguntar — então as três BMs mandavam conversão
 * para o mesmo lugar, cada conta otimizando com o tráfego que as outras
 * compraram. Não havia erro no console e o painel continuava separando certo,
 * porque a separação de lá vem do carimbo, não do pixel.
 *
 * Por isso este teste roda o SITE DE VERDADE com `VITE_META_PIXEL_ID` definido —
 * a condição de produção. Sem essa variável, o defeito não acontece e o teste
 * passaria testando um caminho que ninguém usa.
 */
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_APP = 3345;
const PIXEL_DO_BUILD = '900000000000001';
const PIXEL_DA_BM2 = '900000000000002';
const PIXEL_GERAL_DO_PAINEL = '900000000000003';

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

if (!process.env.PLAYWRIGHT_DIR) {
  console.error('\nPrecisa do PLAYWRIGHT_DIR: esta bateria mede o navegador.\n');
  process.exit(1);
}

/* ========================================================================== */
/* Build com a variável do Vite preenchida — a condição de produção            */
/* ========================================================================== */

console.log('\nGerando o site com VITE_META_PIXEL_ID definido…');
const build = spawnSync('npm', ['run', 'build'], {
  cwd: raiz,
  shell: process.platform === 'win32',
  encoding: 'utf8',
  env: { ...process.env, VITE_META_PIXEL_ID: PIXEL_DO_BUILD },
});
if (build.status !== 0) {
  console.error('O build falhou:', (build.stderr ?? '').slice(0, 400));
  process.exit(1);
}

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} já está ocupada — encerre o servidor órfão.\n`);
  process.exit(1);
}

const senhaPainel = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');
const dataDir = mkdtempSync(path.join(tmpdir(), 'pixelnav-'));

/*
 * `cwd` na RAIZ, ao contrário das outras baterias, porque aqui o servidor
 * precisa servir o `dist` recém-gerado. É seguro neste caso: `PIX_MODE=mock` e
 * as chaves de gateway ficam de fora, então nenhuma cobrança pode ser criada
 * mesmo que o .env.local da raiz seja lido.
 */
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: raiz,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: senhaPainel,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    SERVE_STATIC: 'true',
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
function encerrar(codigo) { matarArvore(); process.exit(codigo); }
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

/*
 * Os três pixels são DIFERENTES de propósito: o do build, o do painel e o da
 * BM. Com dois iguais, a troca entre eles passaria despercebida.
 */
await pedir('/api/admin/meta/credenciais', {
  method: 'POST', headers: cab,
  body: JSON.stringify({ pixelId: PIXEL_GERAL_DO_PAINEL, ligado: true }),
});
await pedir('/api/admin/bms', {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    bms: [{ slug: 'bm2', nome: 'Segunda', pixelId: PIXEL_DA_BM2, contaAds: '', ativa: true }],
  }),
});

/* ========================================================================== */
/* O navegador                                                                 */
/* ========================================================================== */

const { chromium } = await import(
  pathToFileURL(path.resolve(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'index.mjs')).href
);
const nav = await chromium.launch();

/** Quais pixels o `fbq` tem de pé depois de a página assentar. */
async function pixelsDe(url) {
  const pg = await nav.newPage({ viewport: { width: 420, height: 900 } });
  const erros = [];
  pg.on('pageerror', (e) => erros.push(String(e).slice(0, 160)));
  await pg.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // O caminho com carimbo espera uma resposta do servidor: dá tempo a ela.
  await pg.waitForTimeout(4000);
  const achados = await pg.evaluate(() => {
    const f = window.fbq;
    if (!f || !f.instance || !f.instance.pixelsByID) return [];
    return Object.keys(f.instance.pixelsByID);
  });
  await pg.close();
  return { pixels: achados, erros };
}

console.log('\n== Qual pixel o navegador sobe ==\n');

const carimbado = await pixelsDe(`${base}/?bm=bm2`);
const semCarimbo = await pixelsDe(`${base}/`);

console.log(`  com bm=bm2 -> ${carimbado.pixels.join(', ') || '(nenhum)'}`);
console.log(`  sem bm     -> ${semCarimbo.pixels.join(', ') || '(nenhum)'}\n`);

/*
 * A checagem central. Antes da correção, este era o resultado: o carimbado
 * subia o pixel DO BUILD, porque `iniciarPixel` retornava antes de perguntar.
 */
checar(
  carimbado.pixels.includes(PIXEL_DA_BM2),
  'quem chega com bm=bm2 sobe o pixel DA BM2',
  carimbado.pixels.join(',') || 'nenhum',
);
checar(
  !carimbado.pixels.includes(PIXEL_DO_BUILD),
  'o pixel do build NÃO atropela o da BM',
  carimbado.pixels.join(','),
);
checar(
  !carimbado.pixels.includes(PIXEL_GERAL_DO_PAINEL),
  'nem o geral do painel atropela o da BM',
  carimbado.pixels.join(','),
);

/*
 * Sem carimbo o valor do build continua valendo, e isso é uma decisão: é o
 * caminho instantâneo, sem ida ao servidor, do tráfego orgânico. Perder essa
 * rapidez para todo mundo por causa da minoria carimbada seria a troca errada.
 */
checar(
  semCarimbo.pixels.includes(PIXEL_DO_BUILD),
  'sem carimbo, o pixel do build sobe na hora (sem ida ao servidor)',
  semCarimbo.pixels.join(',') || 'nenhum',
);

checar(
  carimbado.erros.length === 0 && semCarimbo.erros.length === 0,
  'nenhum erro de JavaScript',
  [...carimbado.erros, ...semCarimbo.erros].slice(0, 2).join(' | '),
);

await nav.close();

console.log(tudoOk
  ? '\nPASSOU — o carimbo da BM manda no pixel do navegador.'
  : '\nREPROVOU: veja as linhas FALHOU acima.');
encerrar(tudoOk ? 0 : 1);
