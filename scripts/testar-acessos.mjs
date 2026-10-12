/**
 * Bateria da aba Acessos (auditoria + histórico de entregas), contra o backend
 * local em mock (porta 3333).
 * Uso: node scripts/testar-acessos.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const SENHA = process.env.ADMIN_SENHA_LOCAL ?? 'painel-local-2026';
let falhas = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASSOU' : 'FALHOU'}  ${m}`); if (!c) falhas++; };
async function post(caminho, corpo, token) {
  const r = await fetch(BASE + caminho, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Sessao': token } : {}) }, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const get = async (c, t) => (await fetch(BASE + c, { headers: { 'X-Admin-Sessao': t } })).json();

console.log('\n== Acessos: auditoria + entregas ==\n');
const errada = await post('/api/admin/login', { senha: 'errada-de-proposito' });
ok(errada.status === 401, 'senha errada devolve 401');
const login = await post('/api/admin/login', { senha: SENHA });
const token = login.json?.data?.token;
ok(Boolean(token), 'login certo');

// Uma venda: gera PIX, marca pago, gera link de entrega e abre a página (cliente).
const sid = `ac-${Date.now()}`;
const pedido = await post('/api/orders', { offer: 'main', bumps: [], attrib: {}, session_id: sid, customer: { name: 'Cliente Acesso', email: `acesso.${Date.now()}@gmail.com`, phone: '11988887777', document: '39053344705' } });
const id = pedido.json?.data?.id;
ok(Boolean(id), 'PIX gerado');
const pago = await post(`/api/admin/pedidos/${id}/marcar-pago`, {}, token);
ok(pago.status === 200, 'marcado como pago');
const link = await post(`/api/admin/pedidos/${id}/link`, {}, token);
const url = link.json?.data?.url;
ok(Boolean(url), 'link de entrega gerado');
const pagina = await fetch(url.replace(/^https?:\/\/[^/]+/, BASE));
ok(pagina.status === 200, 'cliente abriu a página de entrega');
const escolha = await post(`/api/admin/pedidos/${id}/link-escolha`, {}, token);
ok(escolha.status === 200 || escolha.status === 409 || escolha.status === 400, 'link de escolha respondeu (' + escolha.status + ')');

await new Promise((r) => setTimeout(r, 500));
const a = await get('/api/admin/acessos?dias=1', token);
ok(a.success, 'rota /admin/acessos responde');
const d = a.data;
console.log(`      resumo: logins=${d.resumo.loginsOk} erradas=${d.resumo.senhasErradas} acoes=${d.resumo.acoesNoPainel} pagos=${d.resumo.pagos} abertas=${d.resumo.entregasAbertas} semAbrir=${d.resumo.pagosSemAbrir}`);
ok(d.resumo.loginsOk >= 1 && d.resumo.senhasErradas >= 1, 'login certo e senha errada aparecem');
ok(d.logins.some((l) => l.acao === 'login.senha-errada' && l.ip), 'senha errada tem IP');
ok(d.acoes.some((x) => x.acao === 'POST /admin/pedidos/:id/marcar-pago' && x.alvo === id && x.rotulo === 'Marcou pedido como pago'), 'marcar-pago auditado com alvo e rótulo');
ok(d.acoes.some((x) => x.acao === 'POST /admin/pedidos/:id/link' && x.alvo === id), 'link de entrega auditado');
ok(d.clientes.some((x) => x.acao === 'entrega.aberta' && x.alvo === id), 'abertura da entrega pelo cliente auditada');
const e = d.entregas.find((x) => x.id === id);
ok(e && e.aberturas === 1 && e.ultimaAberturaEm, 'entrega do pedido mostra 1 abertura');
ok(!d.acoes.some((x) => x.acao.startsWith('GET ')), 'leituras não entram na auditoria');

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo verde.');
process.exit(falhas ? 1 : 0);
