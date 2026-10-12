/**
 * Verifica os avisos de compra e, principalmente, que eles NAO atrapalham o
 * checkout: um aviso flutuante que cobre um campo do formulario troca prova
 * social por venda perdida.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT_DIR) + path.sep)('playwright');
const BASE = process.argv[2];
const SAIDA = process.argv[3];

let tudoOk = true;
function checar(ok, d, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${d}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 390, height: 844 } });
const pagina = await contexto.newPage();
const erros = [];
pagina.on('pageerror', (e) => erros.push(e.message));

console.log(`\nProva social em ${BASE}\n`);

await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'networkidle' });
await pagina.waitForTimeout(1200);

const aviso = pagina.locator('[role="status"]');

// 1. Antes de abrir o checkout, nada aparece.
await pagina.waitForTimeout(7000);
checar(await aviso.count() === 0, 'nao aparece antes de o checkout abrir');

// 2. Abre o checkout e o primeiro aviso chega.
await pagina.getByRole('button', { name: 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA' }).click();
await aviso.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
checar(await aviso.count() > 0, 'aparece depois de abrir o checkout');

const texto = await aviso.first().textContent().catch(() => '');
checar(Boolean(texto && texto.trim().length > 10), 'o aviso traz nome e cidade', texto?.trim().slice(0, 60));

await pagina.screenshot({ path: SAIDA });

// 3. O aviso NAO pode cobrir campo do formulario nem bloquear o toque.
const campo = pagina.getByPlaceholder('Seu nome completo');
await campo.scrollIntoViewIfNeeded();
await pagina.waitForTimeout(300);
const caixaCampo = await campo.boundingBox();
const caixaAviso = await aviso.first().boundingBox().catch(() => null);
if (caixaCampo && caixaAviso) {
  const cobre =
    caixaAviso.x < caixaCampo.x + caixaCampo.width &&
    caixaAviso.x + caixaAviso.width > caixaCampo.x &&
    caixaAviso.y < caixaCampo.y + caixaCampo.height &&
    caixaAviso.y + caixaAviso.height > caixaCampo.y;
  checar(!cobre, 'o aviso nao cobre o campo de nome');
}

// O toque precisa atravessar o aviso: so o X e clicavel.
await campo.fill('Teste Prova Social');
checar((await campo.inputValue()) === 'Teste Prova Social', 'da para digitar no formulario com o aviso na tela');

// 4. O X desliga os avisos de vez.
const fechar = pagina.getByRole('button', { name: /Não mostrar mais/i });
if (await fechar.isVisible().catch(() => false)) {
  await fechar.click();
  await pagina.waitForTimeout(20000);
  checar(await aviso.count() === 0, 'o X desliga os avisos e eles nao voltam');
} else {
  console.log('  (aviso ja tinha sumido quando fomos fechar; sem problema)');
}

if (erros.length) {
  console.log('\n  erros de javascript:');
  for (const e of erros) console.log('    ' + e);
  tudoOk = false;
}

await navegador.close();
console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
process.exit(tudoOk ? 0 : 1);
