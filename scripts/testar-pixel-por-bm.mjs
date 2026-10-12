/**
 * Cada BM recebe o SEU pixel?
 *
 * É a verificação que impede o pior defeito silencioso deste painel: cinco
 * gerenciadores mandando evento para o mesmo pixel. Nada quebra, nada aparece
 * no log, e cada conta passa a otimizar com as conversões que as outras quatro
 * compraram — pior do que não rastrear, porque parece certo.
 *
 *   node scripts/testar-pixel-por-bm.mjs [url]
 */
const BASE = process.argv[2] || 'http://localhost:3343';
const SENHA = process.argv[3] || 'painel-local-2026';

const falhas = [];
const ok = (nome, cond, det) => {
  console.log(`  ${cond ? 'ok   ' : 'FALHA'} ${nome}${det ? ' — ' + det : ''}`);
  if (!cond) falhas.push(nome);
};

const pixelPara = async (bm) => {
  const r = await fetch(`${BASE}/api/rastreamento/pixel${bm ? `?bm=${encodeURIComponent(bm)}` : ''}`);
  return (await r.json())?.data?.pixelId ?? '';
};

const entrada = await (await fetch(`${BASE}/api/admin/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA }),
})).json();
if (!entrada?.success) { console.error('login recusado'); process.exit(2); }
const cab = { 'X-Admin-Sessao': entrada.data.token, 'Content-Type': 'application/json' };

/* Um pixel geral, para a queda ter para onde cair. */
await fetch(`${BASE}/api/admin/meta/credenciais`, {
  method: 'POST', headers: cab,
  body: JSON.stringify({ pixelId: '111111111111111', ligado: true }),
});

await fetch(`${BASE}/api/admin/bms`, {
  method: 'POST', headers: cab,
  body: JSON.stringify({
    bms: [
      { slug: 'alpha', nome: 'Alpha', pixelId: '222222222222222', contaAds: '', ativa: true },
      { slug: 'beta', nome: 'Beta', pixelId: '333333333333333', contaAds: '', ativa: true },
      // Sem pixel próprio: precisa cair no geral, não ficar sem pixel.
      { slug: 'semPixel'.toLowerCase(), nome: 'Sem pixel', pixelId: '', contaAds: '', ativa: true },
      // Desligada: precisa cair no geral também.
      { slug: 'parada', nome: 'Parada', pixelId: '444444444444444', contaAds: '', ativa: false },
    ],
  }),
});

console.log('\n== QUAL PIXEL CADA UM RECEBE ==');
const geral = await pixelPara('');
const alpha = await pixelPara('alpha');
const beta = await pixelPara('beta');
const semPixel = await pixelPara('sempixel');
const parada = await pixelPara('parada');
const desconhecida = await pixelPara('naoexiste');
const forjada = await pixelPara("' OR 1=1--");

for (const [rotulo, valor] of [['sem BM', geral], ['alpha', alpha], ['beta', beta],
  ['sem pixel', semPixel], ['parada', parada], ['desconhecida', desconhecida]]) {
  console.log(`  ${rotulo.padEnd(14)} ${valor}`);
}

ok('sem BM usa o pixel geral', geral === '111111111111111', geral);
ok('alpha usa o PRÓPRIO pixel', alpha === '222222222222222', alpha);
ok('beta usa o PRÓPRIO pixel', beta === '333333333333333', beta);
ok('alpha e beta são DIFERENTES', alpha !== beta);
ok('BM sem pixel próprio cai no geral', semPixel === '111111111111111', semPixel);
ok('BM desativada cai no geral', parada === '111111111111111', parada);
ok('BM desconhecida cai no geral', desconhecida === '111111111111111', desconhecida);
ok('BM forjada cai no geral, não quebra', forjada === '111111111111111', forjada);

console.log(`\n${falhas.length ? 'REPROVOU: ' + falhas.join(', ') : 'PASSOU — cada BM recebe o seu pixel, e a queda para o geral funciona.'}`);
process.exit(falhas.length ? 1 : 0);
