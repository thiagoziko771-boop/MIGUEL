/**
 * O separador de BM funciona de ponta a ponta?
 *
 * Semeia visitas de duas BMs pelo /api/track (rota publica, mesma porta de
 * entrada do funil de verdade) e confere que o filtro separa. O teste que
 * importa nao e "o endpoint respondeu 200": e se os numeros de uma BM excluem
 * os da outra. Filtro que soma tudo passa em qualquer teste superficial e leva
 * o dono a escalar a conta errada.
 */
const BASE = process.argv[2] || 'http://localhost:3339';

/*
 * Nomes de BM únicos por execução.
 *
 * Sem isto, rodar a bateria duas vezes contra o mesmo servidor soma as visitas
 * das duas rodadas e ela reprova um filtro que está certo — aconteceu em
 * 19/08/2026: alpha veio com 10 em vez de 5, e a soma continuou batendo,
 * provando que o defeito era do teste. Um teste que só passa na primeira
 * execução é um teste que ninguém roda de novo.
 */
const SELO = Math.random().toString(36).slice(2, 8);
const BM_A = 'alpha' + SELO;
const BM_B = 'beta' + SELO;
const SENHA = process.argv[3] || 'painel-local-2026';

const falhas = [];
const conferir = (nome, ok, detalhe) => {
  console.log(`  ${ok ? 'ok   ' : 'FALHA'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  if (!ok) falhas.push(nome);
};

async function json(caminho, opcoes = {}) {
  const r = await fetch(BASE + caminho, opcoes);
  return r.json().catch(() => ({}));
}

/* Semeia N visitas de uma BM, cada uma com sessao propria. */
async function semear(bm, quantas, campanha) {
  for (let i = 0; i < quantas; i += 1) {
    const sessao = `sess-${bm}-${i}-${Math.random().toString(16).slice(2)}`;
    for (const evento of ['PageView', 'ViewContent']) {
      await fetch(`${BASE}/api/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento,
          event_id: `${sessao}-${evento}`,
          session_id: sessao,
          step: evento === 'PageView' ? 0 : 12,
          url: `${BASE}/?bm=${bm}`,
          attrib: { bm, utm_source: 'facebook', utm_campaign: campanha, fb_campaign_id: campanha },
        }),
      });
    }
  }
}

console.log('\nSemeando visitas de duas BMs...');
await semear(BM_A, 5, 'camp-alpha');
await semear(BM_B, 3, 'camp-beta');
await new Promise((r) => setTimeout(r, 1200));

const entrada = await json('/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA }),
});
const token = entrada?.data?.token;
if (!token) {
  console.error('login recusado');
  process.exit(2);
}
const cab = { 'X-Admin-Sessao': token };

const visitasDe = (d) => (d?.linhas ?? []).reduce((t, l) => t + Number(l.visitas || 0), 0);

console.log('\n== SEM FILTRO ==');
const todas = (await json('/api/admin/anuncios?dias=7', { headers: cab })).data;
const totalTodas = visitasDe(todas);
console.log(`  visitas: ${totalTodas}`);
conferir('as duas BMs aparecem no seletor',
  (todas.bmsDisponiveis || []).includes(BM_A) && (todas.bmsDisponiveis || []).includes(BM_B),
  JSON.stringify(todas.bmsDisponiveis));
conferir('sem filtro, `bm` volta nulo', todas.bm === null, String(todas.bm));

console.log('\n== SÓ alpha ==');
const alpha = (await json('/api/admin/anuncios?dias=7&bm=' + BM_A, { headers: cab })).data;
const totalAlpha = visitasDe(alpha);
console.log(`  visitas: ${totalAlpha}`);
conferir('alpha tem 5 visitas', totalAlpha === 5, String(totalAlpha));
conferir('o servidor confirma o filtro', alpha.bm === BM_A, String(alpha.bm));

console.log('\n== SÓ beta ==');
const beta = (await json('/api/admin/anuncios?dias=7&bm=' + BM_B, { headers: cab })).data;
const totalBeta = visitasDe(beta);
console.log(`  visitas: ${totalBeta}`);
conferir('beta tem 3 visitas', totalBeta === 3, String(totalBeta));

console.log('\n== SOMA ==');
/* As duas BMs desta rodada precisam CABER no total sem filtro, e nao igualar:
   o servidor pode ter dados de rodadas anteriores, e exigir igualdade faria a
   bateria depender de um banco limpo -- dependencia que ninguem lembra de
   satisfazer e que transforma reprovacao em ruido. */
conferir('as duas cabem no total sem filtro', totalAlpha + totalBeta <= totalTodas,
  `${totalAlpha} + ${totalBeta} = ${totalAlpha + totalBeta} <= ${totalTodas}`);

console.log('\n== SANEAMENTO ==');
const forjada = (await json('/api/admin/anuncios?dias=7&bm=' + encodeURIComponent("' OR 1=1--"), { headers: cab })).data;
conferir('BM forjada é ignorada, não quebra', forjada && forjada.bm === null, String(forjada?.bm));
const inexistente = (await json('/api/admin/anuncios?dias=7&bm=naoexiste', { headers: cab })).data;
conferir('BM inexistente devolve zero, não tudo', visitasDe(inexistente) === 0, String(visitasDe(inexistente)));

console.log(`\n${falhas.length ? 'REPROVOU: ' + falhas.join(', ') : 'PASSOU — o filtro separa as BMs de verdade.'}`);
process.exit(falhas.length ? 1 : 0);
