/**
 * A aba BMs: cadastra, mede e leva às campanhas.
 *
 * Semeia tráfego de três gerenciadores pelo /api/track e confere que cada um
 * aparece com os SEUS números. O erro que este teste persegue é o que não dá
 * para ver olhando a tela: uma BM somando o tráfego da outra. Uma tabela assim
 * parece perfeita e leva o dono a desligar a conta que estava dando certo.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3342';
const SENHA = 'painel-local-2026';

const falhas = [];
const ok = (nome, cond, det) => {
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${det ? ' — ' + det : ''}`);
  if (!cond) falhas.push(nome);
};

async function semear(bm, visitas, checkouts) {
  for (let i = 0; i < visitas; i += 1) {
    const sessao = `s-${bm}-${i}-${Math.random().toString(16).slice(2)}`;
    const eventos = ['PageView', 'CompleteRegistration', 'ViewContent'];
    if (i < checkouts) eventos.push('InitiateCheckout');
    for (const evento of eventos) {
      await fetch(`${BASE}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento,
          event_id: `${sessao}-${evento}`,
          session_id: sessao,
          url: `${BASE}/?bm=${bm}`,
          attrib: { bm, utm_source: 'facebook', fb_campaign_id: `camp-${bm}` },
        }),
      });
    }
  }
}

console.log('\nSemeando três gerenciadores...');
await semear('escala', 10, 4);
await semear('teste', 6, 1);
await semear('organica', 3, 0);
await new Promise((r) => setTimeout(r, 1000));

const entrada = await (await fetch(`${BASE}/api/admin/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA }),
})).json();
const cab = { 'X-Admin-Sessao': entrada.data.token, 'Content-Type': 'application/json' };

console.log('\n== MÉTRICAS POR BM ==');
let d = (await (await fetch(`${BASE}/api/admin/bms?dias=7`, { headers: cab })).json()).data;
const de = (slug) => d.bms.find((b) => b.slug === slug);
for (const b of d.bms) console.log(`  ${(b.slug || '(sem BM)').padEnd(10)} visitas ${String(b.visitas).padStart(3)}  checkout ${String(b.checkout).padStart(3)}`);

ok('escala tem 10 visitas', de('escala')?.visitas === 10, String(de('escala')?.visitas));
ok('teste tem 6 visitas', de('teste')?.visitas === 6, String(de('teste')?.visitas));
ok('organica tem 3 visitas', de('organica')?.visitas === 3, String(de('organica')?.visitas));
ok('escala tem 4 checkouts', de('escala')?.checkout === 4, String(de('escala')?.checkout));
ok('organica tem 0 checkout', de('organica')?.checkout === 0, String(de('organica')?.checkout));
ok('o total bate com a soma', d.totais.visitas === 19, `${d.totais.visitas} (esperado 19)`);
ok('nenhuma está cadastrada ainda', d.bms.every((b) => !b.cadastrada));
ok('a tela avisa que não há investimento por BM', d.temInvestimentoPorBm === false);

console.log('\n== CADASTRO ==');
await fetch(`${BASE}/api/admin/bms`, {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    bms: [
      { slug: 'escala', nome: 'BM de Escala', pixelId: '1234567890', contaAds: 'act_999', ativa: true },
      { slug: 'teste', nome: 'BM de Teste', pixelId: '', contaAds: '', ativa: false },
      // Lixo: precisa ser descartado sem derrubar o resto.
      { slug: '<script>alert(1)</script>', nome: 'ruim' },
      { slug: '', nome: 'sem slug' },
    ],
    tokens: { escala: 'EAAtoken-de-teste-nao-serve-em-producao' },
  }),
});

d = (await (await fetch(`${BASE}/api/admin/bms?dias=7`, { headers: cab })).json()).data;
ok('só as 2 BMs válidas foram gravadas', d.bms.filter((b) => b.cadastrada).length === 2,
  String(d.bms.filter((b) => b.cadastrada).length));
ok('o slug forjado foi descartado', !d.bms.some((b) => b.slug.includes('script')));
ok('o nome cadastrado aparece', de('escala')?.nome === 'BM de Escala', de('escala')?.nome);
ok('o pixel foi guardado', de('escala')?.pixelId === '1234567890', de('escala')?.pixelId);
ok('act_ virou só dígitos', de('escala')?.contaAds === '999', de('escala')?.contaAds);
ok('a BM inativa continua na lista', de('teste')?.ativa === false, String(de('teste')?.ativa));
ok('o token volta MASCARADO, nunca inteiro',
  Boolean(de('escala')?.tokenMascarado) && !de('escala').tokenMascarado.includes('nao-serve'),
  de('escala')?.tokenMascarado);
ok('os números seguem certos depois do cadastro', de('escala')?.visitas === 10, String(de('escala')?.visitas));

console.log('\n== TELA ==');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright', 'index.mjs')).href);
const nav = await chromium.launch();
const pg = await nav.newPage();
const erros = [];
pg.on('pageerror', (e) => erros.push(String(e).slice(0, 160)));

await pg.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await pg.fill('#senha', SENHA);
await pg.click('#botaoEntrar');
await pg.waitForSelector('#painel:not([hidden])', { timeout: 15000 });

ok('a aba BMs existe', (await pg.locator('.abas [data-aba="bms"]').count()) === 1);
await pg.click('.abas [data-aba="bms"]');
await pg.waitForTimeout(2500);
ok('a seção abre', await pg.locator('#abaBms').isVisible());

const linhas = await pg.locator('#corpoBms tr[data-bm]').count();
ok('as 3 BMs viram linhas', linhas === 3, `${linhas} linhas`);
const cadastro = await pg.locator('#corpoCadastroBms input[data-campo="slug"]').count();
ok('o cadastro mostra as 2 salvas', cadastro === 2, `${cadastro}`);

const url = (await pg.locator('#urlDaBm').textContent()) || '';
ok('a URL traz o bm= da BM escolhida', url.startsWith('bm=escala') || url.startsWith('bm=teste'), url.slice(0, 30));
ok('a URL usa a sintaxe do Meta', url.includes('{{campaign.id}}'));
ok('a URL não usa a sintaxe do TikTok', !url.includes('__CID__'));

// Clicar na linha leva para Anúncios já filtrado.
await pg.click('#corpoBms tr[data-bm="escala"]');
await pg.waitForTimeout(2500);
ok('clicar leva para a aba Anúncios', await pg.locator('#abaAnuncios').isVisible());
const chipAceso = await pg.locator('#chipsBm button[data-bm="escala"]').getAttribute('aria-pressed').catch(() => null);
ok('já chega filtrado naquela BM', chipAceso === 'true', String(chipAceso));

ok('nenhum erro de JavaScript', erros.length === 0, erros.slice(0, 3).join(' | '));
await nav.close();

console.log(`\n${falhas.length ? 'REPROVOU: ' + falhas.join(', ') : 'PASSOU — a aba BMs mede, cadastra e navega.'}`);
process.exit(falhas.length ? 1 : 0);
