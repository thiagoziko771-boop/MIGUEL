/**
 * Fotografa o fluxo do pedido de oração (celular) e a aba CRM (desktop) no
 * ambiente local, para conferência visual antes de o dono aprovar.
 *
 * Pressupõe: Vite em :3000 (proxy /api -> :3333) e backend em :3333 (mock).
 * Saída: .data/fotos/*.png
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

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const SENHA = process.env.ADMIN_SENHA_LOCAL ?? 'painel-local-2026';
const PASTA = path.resolve('.data/fotos');
fs.mkdirSync(PASTA, { recursive: true });

const navegador = await chromium.launch();

/* ---------- Funil: celular ---------- */
const cel = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
const p = await cel.newPage();
await p.goto(`${BASE}/?capa=pedido`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.screenshot({ path: path.join(PASTA, '1-capa-pedido.png') });

await p.getByRole('button', { name: /fazer o meu pedido/i }).click();
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(PASTA, '2-tela-pedido-vazia.png'), fullPage: true });

await p.getByPlaceholder('Seu nome').fill('Maria Aparecida');
await p.getByPlaceholder('Seu e-mail').fill('maria.aparecida.foto@gmail.com');
await p.getByPlaceholder('Seu WhatsApp com DDD').fill('11988887777');
await p.getByPlaceholder(/Escreva aqui/).fill('Peço a Miguel pela saúde do meu filho João e por um emprego para meu marido. Estamos passando dificuldade e preciso de proteção na minha casa.');
await p.screenshot({ path: path.join(PASTA, '3-tela-pedido-preenchida.png'), fullPage: true });

await p.getByRole('button', { name: /entregar meu pedido/i }).click();
await p.waitForTimeout(800);
await p.screenshot({ path: path.join(PASTA, '4-transicao-bencaos.png') });

await p.getByRole('button', { name: /continuar para receber/i }).click();
await p.waitForTimeout(600);
await p.screenshot({ path: path.join(PASTA, '5-quiz-pergunta-1.png') });

// Refresh na capa: não pode pedir de novo — deve cair na transição.
await p.goto(`${BASE}/?capa=pedido`, { waitUntil: 'networkidle' });
await p.getByRole('button', { name: /fazer o meu pedido/i }).click();
await p.waitForTimeout(600);
const textoTransicao = await p.textContent('body');
console.log('refresh na capa cai na transição (sem pedir de novo):', /pedido foi enviado/i.test(textoTransicao || ''));
await cel.close();

/* ---------- Painel: desktop ---------- */
const desk = await navegador.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'pt-BR' });
const a = await desk.newPage();
await a.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await a.fill('#senha', SENHA);
await a.click('#botaoEntrar');
await a.waitForSelector('#painel:not([hidden])', { timeout: 15000 });
await a.click('.abas button[data-aba="crm"]');
await a.waitForTimeout(1500);
await a.screenshot({ path: path.join(PASTA, '6-crm-visao-geral.png'), fullPage: true });

await a.click('#chipsSecaoCrm button[data-secao="leads"]');
await a.waitForTimeout(1200);
await a.screenshot({ path: path.join(PASTA, '7-crm-pessoas.png'), fullPage: true });

const primeiraLinha = await a.$('#corpoCrm tr[data-sessao]');
if (primeiraLinha) {
  await primeiraLinha.click();
  await a.waitForSelector('#fundoModal', { timeout: 8000 });
  await a.waitForTimeout(600);
  await a.screenshot({ path: path.join(PASTA, '8-crm-perfil.png'), fullPage: true });
  await a.click('#fecharModal');
}

await a.click('#chipsSecaoCrm button[data-secao="reciprocidade"]');
await a.waitForTimeout(1200);
await a.screenshot({ path: path.join(PASTA, '9-crm-reciprocidade.png'), fullPage: true });

await desk.close();
await navegador.close();
console.log('fotos em', PASTA);
