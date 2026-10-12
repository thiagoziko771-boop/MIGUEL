/**
 * Prova que a retenção da VSL é medida de verdade.
 *
 *   PIX_MODE=mock PORT=3388 SERVE_STATIC=true npx tsx server/index.ts
 *   PLAYWRIGHT_DIR=~/pw node scripts/testar-retencao-vsl.mjs http://localhost:3388
 *
 * O DEFEITO QUE ISTO PEGA É MUDO: se o evento parar de sair — porque o nome do
 * evento do player mudou, porque o elemento não é mais encontrado, porque o
 * servidor passou a recusar o evento —, a tela do painel continua desenhando,
 * só que vazia. E "ninguém assiste o vídeo" é indistinguível de "a medição
 * quebrou" quando se olha só o resultado.
 *
 * A maior perda do funil acontece nesta tela: 87% de quem chega na oferta não
 * gera PIX. Sem esta medição não dá para saber se a pessoa desiste nos
 * primeiros segundos (problema de gancho) ou já perto do preço (problema de
 * oferta) — e os dois pedem consertos opostos.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? 'http://localhost:3388';
const require = createRequire(path.resolve(process.env.PLAYWRIGHT_DIR ?? '.') + path.sep);
const { chromium } = require('playwright');

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

console.log(`\nRetencao da VSL em ${BASE}\n`);

const navegador = await chromium.launch();
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const pagina = await contexto.newPage();

/* Os eventos que o navegador manda ao servidor, capturados no caminho. */
const marcos = [];
await pagina.route('**/api/track', async (rota) => {
  try {
    const corpo = JSON.parse(rota.request().postData() ?? '{}');
    if (corpo.evento === 'MarcoDaVSL') marcos.push(corpo);
  } catch { /* ignora */ }
  await rota.continue();
});

await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });

const player = pagina.locator('wistia-player');
await player.waitFor({ timeout: 30000 });
checar(true, 'a tela da oferta abre com o player');

/*
 * O play vem da API do player, e não de um clique no botão: o botão é desenhado
 * dentro do shadow DOM da Wistia e muda de lugar entre versões.
 */
const tocou = await pagina.evaluate(async () => {
  const el = document.querySelector('wistia-player');
  if (!el) return false;
  for (let i = 0; i < 40 && typeof el.play !== 'function'; i += 1) {
    await new Promise((ok) => setTimeout(ok, 500));
  }
  if (typeof el.play !== 'function') return false;
  try {
    el.muted = true;
    await el.play();
    return true;
  } catch {
    return false;
  }
});
checar(tocou, 'o video comeca a tocar');

if (tocou) {
  // Onze segundos de vídeo cobrem o primeiro marco (10 s) com folga.
  await pagina.waitForTimeout(15000);

  checar(marcos.length > 0, `o navegador avisa o servidor (${marcos.length} marco(s))`);

  const dez = marcos.find((m) => m.resposta?.escolha === '10');
  checar(Boolean(dez), 'o marco de 10 s foi registrado');
  checar(dez?.resposta?.pergunta === 'VSL', 'identificado como VSL, e nao como pergunta do quiz');
  checar(dez?.step === 13, 'na etapa da oferta');

  const repetidos = marcos.filter((m) => m.resposta?.escolha === '10').length;
  checar(repetidos === 1, `cada marco sai UMA vez, nao a cada segundo (veio ${repetidos})`);
}

await navegador.close();

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
process.exit(tudoOk ? 0 : 1);
