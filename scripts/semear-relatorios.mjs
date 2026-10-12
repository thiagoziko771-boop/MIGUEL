/**
 * Semeia o backend LOCAL (memória, PIX mock) com visitas e pedidos de hoje e
 * confere a rota /admin/relatorios. Só para olhar a aba Relatórios rodando.
 *
 * Uso: PIX_MODE=mock npx tsx server/index.ts   (em outro terminal)
 *      node scripts/semear-relatorios.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const SENHA = process.env.ADMIN_SENHA_LOCAL ?? 'painel-local-2026';
const ATT = { utm_source: 'facebook', utm_campaign: 'TESTE-RELATORIOS', fb_campaign_id: '777', fb_ad_id: '999' };
const stamp = Date.now();

async function post(caminho, corpo, token) {
  const r = await fetch(BASE + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Sessao': token } : {}) },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function get(caminho, token) {
  const r = await fetch(BASE + caminho, { headers: { 'X-Admin-Sessao': token } });
  return r.json();
}

const login = await post('/api/admin/login', { senha: SENHA });
const token = login.json?.data?.token;
if (!token) { console.error('login falhou', login); process.exit(1); }

// 12 visitas: 8 iniciam o quiz, 5 chegam à VSL, 3 abrem checkout, 3 geram PIX, 2 pagam.
const cpfs = ['13909081436', '52998224725', '11144477735'];
for (let i = 0; i < 12; i += 1) {
  const sid = `rel-${stamp}-${i}`;
  await post('/api/track', { evento: 'PageView', session_id: sid, event_id: `pv-${sid}`, step: 0, attrib: ATT });
  if (i < 8) await post('/api/track', { evento: 'CompleteRegistration', session_id: sid, event_id: `cr-${sid}`, step: 12, attrib: ATT });
  if (i < 5) await post('/api/track', { evento: 'ViewContent', session_id: sid, event_id: `vc-${sid}`, step: 13, attrib: ATT, content_ids: ['main'] });
  if (i < 3) {
    await post('/api/track', { evento: 'InitiateCheckout', session_id: sid, event_id: `ic-${sid}`, step: 13, attrib: ATT });
    const pedido = await post('/api/orders', {
      offer: 'main', bumps: i === 0 ? ['salmos_150'] : [], attrib: ATT, session_id: sid,
      customer: { name: `Pessoa ${i}`, email: `pessoa${i}.${stamp}@gmail.com`, phone: '1199999000' + i, document: cpfs[i] },
    });
    const id = pedido.json?.data?.id;
    if (i < 2 && id) await post(`/api/admin/pedidos/${id}/marcar-pago`, {}, token);
  }
}

// Gasto de hoje: R$ 45,00 na campanha, nível campanha.
const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const inv = await post('/api/admin/investimento', { chave: '777', dia: hoje, valor: '45,00', nivel: 'campanha' }, token);
console.log('investimento:', inv.status, inv.json?.message ?? '');

const r = await get('/api/admin/relatorios?dias=7', token);
console.log(JSON.stringify(r.data?.dias?.[0], null, 2));
console.log('\n' + r.data?.textos?.hoje);
