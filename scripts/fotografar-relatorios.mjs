/**
 * Fotografa a aba Relatórios (fechamento diário) no painel local.
 * Pressupõe backend em :3333 (mock) já semeado por scripts/semear-relatorios.mjs.
 * Saída: .data/fotos/relatorios-*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await (async () => {
  try {
    const fora = process.env.PLAYWRIGHT_DIR;
    if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
    return await import('playwright');
  } catch {
    console.error('playwright nao encontrado');
    process.exit(1);
  }
})();

const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const SENHA = process.env.ADMIN_SENHA_LOCAL ?? 'painel-local-2026';
const PASTA = path.resolve('.data/fotos');
fs.mkdirSync(PASTA, { recursive: true });

const navegador = await chromium.launch();
const desk = await navegador.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'pt-BR' });
const a = await desk.newPage();
const errosJs = [];
a.on('pageerror', (e) => errosJs.push(String(e)));
a.on('console', (m) => { if (m.type() === 'error') errosJs.push(m.text()); });

await a.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await a.fill('#senha', SENHA);
await a.click('#botaoEntrar');
await a.waitForSelector('#painel:not([hidden])', { timeout: 15000 });
await a.click('.abas button[data-aba="relatorios"]');
await a.waitForSelector('#corpoRelatorios tr', { timeout: 15000 });
await a.waitForTimeout(600);
await a.screenshot({ path: path.join(PASTA, 'relatorios-1-hoje.png'), fullPage: true });

// Clica no total do período e confere que o foco muda.
await a.click('#rodapeRelatorios tr[data-dia="periodo"]');
await a.waitForTimeout(400);
const titulo = await a.textContent('#tituloFechamento');
console.log('titulo apos clicar no periodo:', titulo);
await a.screenshot({ path: path.join(PASTA, 'relatorios-2-periodo.png'), fullPage: true });

// Copiar resumo (o botão deve mudar para "Copiado ✓")
await desk.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
await a.click('#copiarFechamento');
await a.waitForTimeout(300);
console.log('botao copiar:', await a.textContent('#copiarFechamento'));

// Troca para 30 dias
await a.selectOption('#periodoRelatorios', '30');
await a.waitForTimeout(1200);
console.log('linhas com 30 dias:', await a.$$eval('#corpoRelatorios tr', (l) => l.length));

// Modo claro
await a.click('#botaoTema');
await a.waitForTimeout(300);
await a.screenshot({ path: path.join(PASTA, 'relatorios-3-claro.png'), fullPage: false });

console.log('erros de JS:', errosJs.length ? errosJs : 'nenhum');
await navegador.close();
console.log('fotos em', PASTA);
