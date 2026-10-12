/**
 * Fotografa o FLUXO DIRETO (`/pedido`): tela do pedido com o anjo atrás ->
 * análise -> VSL, no celular. Saída em .data/fotos/direto-*.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await (async () => {
  const fora = process.env.PLAYWRIGHT_DIR;
  if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
  return await import('playwright');
})();

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PASTA = path.resolve('.data/fotos');
fs.mkdirSync(PASTA, { recursive: true });

const navegador = await chromium.launch();
const cel = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
const p = await cel.newPage();

await p.goto(`${BASE}/pedido`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
await p.screenshot({ path: path.join(PASTA, 'direto-1-primeira-tela.png') });
await p.screenshot({ path: path.join(PASTA, 'direto-1b-primeira-tela-inteira.png'), fullPage: true });

const ehPedido = await p.getByPlaceholder('Seu nome').count();
console.log('primeira tela é o pedido (sem capa):', ehPedido > 0);

await p.getByPlaceholder('Seu nome').fill('Maria Aparecida');
await p.getByPlaceholder('Seu e-mail').fill('maria.direto@gmail.com');
await p.getByPlaceholder('Seu WhatsApp com DDD').fill('11988887777');
await p.getByPlaceholder(/Escreva aqui/).fill('Peço a Miguel pela saúde da minha família e por prosperidade na minha casa.');
await p.getByRole('button', { name: /entregar meu pedido/i }).click();
await p.waitForTimeout(700);
await p.screenshot({ path: path.join(PASTA, 'direto-2-analise.png') });
const textoAnalise = await p.textContent('body');
console.log('foi para a análise com o nome:', /Merecimento de Maria/i.test(textoAnalise || ''));

await p.waitForTimeout(6500);
await p.screenshot({ path: path.join(PASTA, 'direto-3-vsl.png') });
const textoVsl = await p.textContent('body');
console.log('chegou na VSL com "Parabéns, Maria":', /Parabéns, Maria/i.test(textoVsl || ''));

// Refresh: não pede de novo, vai para análise/VSL.
await p.goto(`${BASE}/pedido`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
const dep = await p.getByPlaceholder('Seu nome').count();
console.log('refresh NÃO pede de novo:', dep === 0);

await cel.close();
await navegador.close();
console.log('fotos em', PASTA);
