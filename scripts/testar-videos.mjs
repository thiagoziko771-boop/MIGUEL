/**
 * Garante que os vídeos carregam TARDE, mas carregam.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-videos.mjs
 *
 * Os quatro scripts da Wistia (o runtime do player e um arquivo por vídeo)
 * ficavam no <head> e baixavam na TELA 0 — 60 kB e quatro conexões com um
 * domínio de terceiro antes da primeira pergunta, sendo que o primeiro vídeo
 * só aparece na tela 11. Agora src/lib/wistia.ts os injeta quando a pessoa sai
 * do hero.
 *
 * Esta bateria protege os dois lados da mudança, que quebram de jeitos opostos
 * e igualmente silenciosos:
 *
 *   - alguém devolve as tags ao <head> "para garantir", e a tela 0 volta a
 *     pagar por vídeo que ninguém vai ver;
 *   - o adiamento fica tarde demais ou o módulo deixa de ser chamado, e a VSL
 *     não monta — a página abre, o quiz funciona, e a tela onde a venda
 *     acontece fica com um retângulo parado.
 *
 * O segundo caso não derruba nada, não aparece em log e não quebra teste de
 * servidor. Só aparece no faturamento.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const PORTA = 3371;
const base = `http://localhost:${PORTA}`;

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

/*
 * O Playwright vive FORA do projeto, para não entrar no build da Vercel.
 * Ver o caminho no CLAUDE.md.
 */
const pastaPlaywright = (process.env.PLAYWRIGHT_DIR ?? '').trim();
const modulo = pastaPlaywright
  ? path.join(pastaPlaywright.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? '~'), 'node_modules/playwright/index.mjs')
  : 'playwright';

let chromium;
try {
  ({ chromium } = await import(modulo.startsWith('playwright') ? modulo : `file:///${modulo.replace(/\\/g, '/')}`));
} catch {
  console.error(
    '\nPlaywright não encontrado. Ele fica fora do projeto de propósito:\n' +
    '  mkdir ~/teste-funil && cd ~/teste-funil && npm i playwright && npx playwright install chromium\n' +
    '  PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-videos.mjs\n',
  );
  process.exit(1);
}

let tudoOk = true;
const checar = (ok, descricao) => {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}`);
  if (!ok) tudoOk = false;
};

const ocupada = await fetch(base).then(() => true).catch(() => false);
if (ocupada) {
  console.error(`\nA porta ${PORTA} já está ocupada. Encerre o processo e rode de novo.\n`);
  process.exit(1);
}

const vite = spawn('npx', ['vite', '--port', String(PORTA), '--strictPort'], {
  cwd: raiz,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});

/* Mata a árvore: no Windows, matar o npx deixa o vite vivo segurando a porta. */
function derrubar() {
  if (vite.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* já morreu */ }
    return;
  }
  try { vite.kill(); } catch { /* já morreu */ }
}
process.on('exit', derrubar);

for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(base)).ok) break; } catch { /* subindo */ }
  await new Promise((ok) => setTimeout(ok, 500));
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 390, height: 844 } });

const erros = [];
/** Abre uma aba já sem rastreamento: evento de teste não pode sujar o funil. */
async function abrir(caminho) {
  const pagina = await contexto.newPage();
  pagina.on('pageerror', (e) => erros.push(String(e)));
  await pagina.route('**/api/track', (rota) => rota.abort());
  await pagina.goto(`${base}${caminho}`, { waitUntil: 'networkidle' });
  return pagina;
}

console.log('\n== O vídeo carrega tarde, mas carrega ==\n');

/* -------------------------------------------------------------------------- */
/* A tela 0 não paga por vídeo nenhum                                          */
/* -------------------------------------------------------------------------- */

const scripts = [];
const hero = await contexto.newPage();
hero.on('pageerror', (e) => erros.push(String(e)));
hero.on('request', (r) => { if (r.url().includes('wistia') && r.url().endsWith('.js')) scripts.push(r.url()); });
await hero.route('**/api/track', (rota) => rota.abort());
await hero.goto(base, { waitUntil: 'networkidle' });
await hero.waitForTimeout(2500);

checar(scripts.length === 0, `a tela 0 nao baixa script de video (baixou ${scripts.length})`);

/* -------------------------------------------------------------------------- */
/* Sair do hero começa a baixar, com folga de sobra até o primeiro vídeo       */
/* -------------------------------------------------------------------------- */

await hero.click('button:has-text("Descobrir")').catch(() => {});
await hero.waitForTimeout(3500);
checar(
  scripts.length >= 4,
  `ao entrar no quiz, baixa o player e os 3 videos (baixou ${scripts.length})`,
);

/* -------------------------------------------------------------------------- */
/* A VSL monta — é a tela onde a venda acontece                                */
/* -------------------------------------------------------------------------- */

const oferta = await abrir('/?tela=13&cta=1');
await oferta.waitForTimeout(7000);

checar(
  (await oferta.getAttribute('wistia-player', 'media-id')) === 'a78m863q0a',
  'a VSL aponta para o media-id do video em uso',
);
checar(
  await oferta.evaluate(() => Boolean(customElements.get('wistia-player'))),
  'o player MONTA na tela da oferta',
);
const altura = await oferta.evaluate(
  () => document.querySelector('wistia-player')?.getBoundingClientRect().height ?? 0,
);
checar(altura > 300, `o video ocupa espaco de verdade na tela (${Math.round(altura)} px)`);

/* -------------------------------------------------------------------------- */
/* Os depoimentos também                                                       */
/* -------------------------------------------------------------------------- */

const depoimentos = await abrir('/?tela=11');
await depoimentos.waitForTimeout(7000);
const players = await depoimentos.locator('wistia-player').count();
checar(players >= 2, `os depoimentos em video aparecem (${players} players)`);

checar(erros.length === 0, `sem erro de console${erros.length ? ': ' + erros.join(' | ') : ''}`);

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
await navegador.close();
derrubar();
process.exit(tudoOk ? 0 : 1);
