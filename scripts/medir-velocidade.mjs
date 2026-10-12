/**
 * Quanto tempo o lead espera olhando o nada, no celular ruim dele.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/medir-velocidade.mjs [url]
 *
 * Mede com a rede e o processador ESTRANGULADOS, porque o público desta oferta
 * não usa iPhone no wi-fi: é 4G instável e aparelho de entrada. Medir na
 * máquina de quem programa responde uma pergunta que ninguém fez — a página
 * sempre parece rápida ali.
 *
 * O número que decide é o FCP (quando aparece qualquer coisa) e o LCP (quando
 * aparece a coisa principal). Entre o clique no anúncio e o primeiro pixel, o
 * lead está olhando uma tela branca com o dedo perto do botão de voltar.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const URL_ALVO = process.argv[2] || 'https://migueltechama.vercel.app';
const RODADAS = Number(process.argv[3] || 3);

const { chromium, devices } = await import(
  pathToFileURL(resolve(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'index.mjs')).href
);

/*
 * "Slow 4G" do DevTools, e 4x de lentidão no processador.
 *
 * Não é pessimismo: é a mediana do tráfego pago em celular no Brasil. Um Moto
 * G de entrada com 4G num ônibus está PIOR do que isto.
 */
const REDE = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1,6 Mbps
  uploadThroughput: (750 * 1024) / 8,
  latency: 150, // ms de ida e volta
};
const CPU = 4;

async function medir(nav) {
  const contexto = await nav.newContext({ ...devices['Galaxy S5'] });

  /*
   * Os observadores TÊM de ser registrados antes de a página existir.
   *
   * `getEntriesByType('largest-contentful-paint')` devolve vazio: o LCP e as
   * tarefas longas não ficam no buffer padrão do navegador, só chegam por
   * PerformanceObserver. Consultá-los depois devolve `null` — que se lê como
   * "está rápido" quando na verdade quer dizer "não medi". Foi o que a primeira
   * versão deste script fez.
   */
  await contexto.addInitScript(() => {
    window.__metricas = { lcp: 0, tbt: 0 };
    try {
      new PerformanceObserver((lista) => {
        for (const e of lista.getEntries()) window.__metricas.lcp = Math.round(e.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((lista) => {
        for (const e of lista.getEntries()) window.__metricas.tbt += Math.max(0, Math.round(e.duration - 50));
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* navegador sem suporte: fica zero e o relatório diz */ }
  });

  const pg = await contexto.newPage();
  const cdp = await contexto.newCDPSession(pg);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', REDE);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  const bytes = { total: 0, js: 0, css: 0, imagem: 0, fonte: 0, outro: 0 };
  pg.on('response', async (r) => {
    try {
      const tam = Number((await r.allHeaders())['content-length'] ?? 0);
      if (!tam) return;
      bytes.total += tam;
      const tipo = r.request().resourceType();
      if (tipo === 'script') bytes.js += tam;
      else if (tipo === 'stylesheet') bytes.css += tam;
      else if (tipo === 'image') bytes.imagem += tam;
      else if (tipo === 'font') bytes.fonte += tam;
      else bytes.outro += tam;
    } catch { /* resposta já foi embora */ }
  });

  const inicio = Date.now();
  await pg.goto(URL_ALVO, { waitUntil: 'load', timeout: 120000 });

  // Deixa o LCP assentar: ele só é definitivo depois que a página para de mudar.
  await pg.waitForTimeout(4000);

  const marcas = await pg.evaluate(() => new Promise((ok) => {
    const saida = { fcp: null, lcp: null, dcl: null, load: null, tbt: null };
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      saida.dcl = Math.round(nav.domContentLoadedEventEnd);
      saida.load = Math.round(nav.loadEventEnd);
    }
    for (const e of performance.getEntriesByType('paint')) {
      if (e.name === 'first-contentful-paint') saida.fcp = Math.round(e.startTime);
    }
    // Vêm dos observadores instalados antes da página existir.
    saida.lcp = window.__metricas?.lcp || null;
    // Tarefas longas: é o que trava o toque do dedo enquanto a página "já apareceu".
    saida.tbt = window.__metricas?.tbt ?? null;
    ok(saida);
  }));

  const total = Date.now() - inicio;
  await contexto.close();
  return { ...marcas, total, bytes };
}

const nav = await chromium.launch();
const rodadas = [];
for (let i = 0; i < RODADAS; i += 1) {
  process.stdout.write(`  rodada ${i + 1}/${RODADAS}…\r`);
  rodadas.push(await medir(nav));
}
await nav.close();

const mediana = (chave) => {
  const v = rodadas.map((r) => r[chave]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const kb = (n) => `${(n / 1024).toFixed(0)} kB`;

console.log(`\n=== ${URL_ALVO} ===`);
console.log(`    Galaxy S5 · 1,6 Mbps · 150 ms de latência · CPU 4x mais lenta`);
console.log(`    mediana de ${RODADAS} rodadas\n`);
console.log(`  FCP  (aparece algo)      ${mediana('fcp')} ms`);
console.log(`  LCP  (aparece o principal) ${mediana('lcp')} ms`);
console.log(`  DCL                       ${mediana('dcl')} ms`);
console.log(`  load                      ${mediana('load')} ms`);
console.log(`  travamento (TBT)          ${mediana('tbt')} ms`);

const b = rodadas[rodadas.length - 1].bytes;
console.log(`\n  baixado: ${kb(b.total)} — js ${kb(b.js)} · css ${kb(b.css)} · img ${kb(b.imagem)} · fonte ${kb(b.fonte)} · outro ${kb(b.outro)}`);

const lcp = mediana('lcp');
console.log(`\n  ${lcp <= 2500 ? 'BOM' : lcp <= 4000 ? 'PRECISA MELHORAR' : 'RUIM'} — o Google considera bom até 2500 ms`);
