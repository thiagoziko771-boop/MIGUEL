/**
 * Bateria do CRM e do fluxo de pedido de oração (15/08/2026).
 *
 * Sobe contra um backend local já rodando (PIX_MODE=mock, porta 3333) e
 * prova as regras que o dono definiu:
 *
 *   1. quem PEDIU e parou (não gerou PIX)  -> segmento "pediu e parou", destino reciprocidade
 *   2. quem PEDIU e COMPROU                -> CLIENTE, destino fluxo-normal, e SOME da fila de reciprocidade
 *   3. quem PEDIU e gerou PIX sem pagar    -> RECUPERAÇÃO DE COBRANÇA (não reciprocidade) enquanto < 24 h
 *   4. o pedido de oração aparece no perfil, com nome/e-mail/WhatsApp e as respostas do quiz
 *   5. nota interna e "marcar contatado" funcionam
 *
 * Uso: PIX_MODE=mock npx tsx server/index.ts   (em outro terminal)
 *      node scripts/testar-crm.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3333';
const SENHA = process.env.ADMIN_SENHA_LOCAL ?? 'painel-local-2026';

let falhas = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? 'PASSOU' : 'FALHOU'}  ${msg}`);
  if (!cond) falhas++;
}

async function post(caminho, corpo, token) {
  const r = await fetch(BASE + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Sessao': token } : {}) },
    body: JSON.stringify(corpo),
  });
  const texto = await r.text();
  try { return { status: r.status, json: JSON.parse(texto) }; } catch { return { status: r.status, json: null }; }
}
async function get(caminho, token) {
  const r = await fetch(BASE + caminho, { headers: { 'X-Admin-Sessao': token } });
  return r.json();
}

const ATT = { utm_source: 'facebook', utm_content: 'A-TESTE-PEDIDO-4x5 [Claude 2026-08-15]', fb_ad_id: '999' };
const stamp = Date.now();

async function pedirOracao(sid, nome, email, tel, pedido) {
  await post('/api/track', { evento: 'PageView', session_id: sid, event_id: `pv-${sid}`, step: 0, attrib: ATT, resposta: { pergunta: 'Capa', escolha: 'pedido' } });
  await post('/api/track', { evento: 'Lead', session_id: sid, event_id: `ld-${sid}`, step: 1, attrib: ATT, contato: { nome, email, telefone: tel } });
  await post('/api/track', {
    evento: 'EtapaDoFunil', session_id: sid, event_id: `po-${sid}`, step: 1, attrib: ATT,
    resposta: { pergunta: 'Pedido de oração', escolha: JSON.stringify({ nome, email, tel, pedido }) },
  });
  await post('/api/track', { evento: 'EtapaDoFunil', session_id: sid, event_id: `tr-${sid}`, step: 1, attrib: ATT, resposta: { pergunta: 'Tela', escolha: 'transicao_bencaos' } });
}
async function responderQuiz(sid) {
  await post('/api/track', { evento: 'EtapaDoFunil', session_id: sid, event_id: `q1-${sid}`, step: 1, attrib: ATT, resposta: { pergunta: 'Se você pudesse pedir uma intervenção urgente do Arcanjo Miguel hoje, para qual área seria?', escolha: 'Proteção para minha família' } });
  await post('/api/track', { evento: 'EtapaDoFunil', session_id: sid, event_id: `q2-${sid}`, step: 2, attrib: ATT, resposta: { pergunta: 'Como está sua relação com o dinheiro hoje?', escolha: 'O dinheiro entra e sai mas nunca sobra nada..' } });
  await post('/api/track', { evento: 'CompleteRegistration', session_id: sid, event_id: `cr-${sid}`, step: 12, attrib: ATT });
  await post('/api/track', { evento: 'ViewContent', session_id: sid, event_id: `vc-${sid}`, step: 13, attrib: ATT, content_ids: ['main'] });
}
async function gerarPix(sid, nome, email, tel, cpf = '13909081436') {
  const r = await post('/api/orders', {
    offer: 'main', bumps: [], attrib: ATT, session_id: sid,
    customer: { name: nome, email, phone: tel, document: cpf },
  });
  return r.json?.data ?? null;
}

async function main() {
  console.log('\n== CRM: bateria ponta a ponta (backend local em mock) ==\n');
  const login = await post('/api/admin/login', { senha: SENHA });
  const token = login.json?.data?.token;
  ok(Boolean(token), 'login no painel local');
  if (!token) process.exit(1);

  const A = `crm-A-${stamp}`; // pediu e parou
  const B = `crm-B-${stamp}`; // pediu e comprou
  const C = `crm-C-${stamp}`; // pediu, gerou PIX, não pagou

  await pedirOracao(A, 'Maria Parou', `maria.parou.${stamp}@gmail.com`, '11999990001', 'Peço por saúde do meu filho e por um emprego para meu marido');
  await responderQuiz(A);

  await pedirOracao(B, 'José Comprador', `jose.comprador.${stamp}@gmail.com`, '11999990002', 'Peço prosperidade e paz na minha casa');
  await responderQuiz(B);
  const pedidoB = await gerarPix(B, 'José Comprador', `jose.comprador.${stamp}@gmail.com`, '11999990002');
  ok(Boolean(pedidoB?.id), 'B gerou PIX (mock)');

  await pedirOracao(C, 'Ana Pendente', `ana.pendente.${stamp}@gmail.com`, '11999990003', 'Peço proteção contra a inveja');
  await responderQuiz(C);
  // CPF diferente do B: mesmo CPF + mesmos itens reaproveita a cobrança viva (regra do checkout).
  const pedidoC = await gerarPix(C, 'Ana Pendente', `ana.pendente.${stamp}@gmail.com`, '11999990003', '52998224725');
  ok(Boolean(pedidoC?.id), 'C gerou PIX (mock)');

  // O mock confirma o pagamento sozinho depois de alguns segundos. Marcamos B
  // como pago pelo painel (rota que já existe) para não depender do relógio, e
  // deixamos C pendente de propósito.
  const marcar = await post(`/api/admin/pedidos/${pedidoB.id}/marcar-pago`, {}, token);
  ok(marcar.status === 200, 'B marcado como pago (rota do painel)');

  await new Promise((r) => setTimeout(r, 800));

  const resumo = await get('/api/admin/crm/resumo?dias=1', token);
  ok(resumo.success, 'resumo do CRM responde');
  const c = resumo.data.cards;
  console.log(`      cards: pessoas=${c.totalDeLeads} pedidos=${c.pedidosDeOracao} oferta=${c.ofertaVisualizada} pix=${c.pixGerado} compradores=${c.compradores} reciprocidade=${c.emReciprocidade} recuperacao=${c.emRecuperacao} receita=${c.receitaCentavos}`);
  ok(c.pedidosDeOracao >= 3, 'os 3 pedidos de oração foram contados');
  ok(c.compradores >= 1, 'pelo menos 1 comprador');

  const lista = await get('/api/admin/crm/leads?dias=1&soComPedido=1', token);
  const porSessao = Object.fromEntries(lista.data.leads.map((l) => [l.sessionId, l]));
  const la = porSessao[A], lb = porSessao[B], lc = porSessao[C];
  ok(Boolean(la && lb && lc), 'os 3 leads aparecem na lista com filtro "só quem pediu"');
  if (la) {
    ok(la.contato.nome === 'Maria Parou' && la.contato.telefone === '11999990001', 'A: nome e WhatsApp lidos do pedido');
    ok(la.pedidoDeOracao?.includes('saúde do meu filho'), 'A: texto do pedido preservado com acento');
    ok(la.segmento === 'RECUPERACAO_DE_INTERESSE' && la.destino === 'reciprocidade', `A: pediu e parou -> ${la.segmento} / ${la.destino}`);
    ok(la.pagou === false && la.gerouPix === false, 'A: sem PIX, sem compra');
  }
  if (lb) {
    ok(lb.pagou === true, 'B: pagou');
    ok(lb.segmento === 'CLIENTE' && lb.destino === 'fluxo-normal', `B: comprador -> ${lb.segmento} / ${lb.destino}`);
    ok(lb.status === 'pago', 'B: status pago');
  }
  if (lc) {
    ok(lc.gerouPix === true && lc.pagou === false, 'C: gerou PIX e não pagou');
    ok(lc.segmento === 'RECUPERACAO_DE_COBRANCA' && lc.destino === 'recuperacao', `C: PIX pendente -> ${lc.segmento} (NÃO reciprocidade)`);
  }

  const fila = await get('/api/admin/crm/reciprocidade?dias=1', token);
  const naFila = new Set(fila.data.fila.map((l) => l.sessionId));
  ok(naFila.has(A), 'reciprocidade: A (pediu e parou) está na fila');
  ok(!naFila.has(B), 'reciprocidade: B (comprou) NÃO está na fila');
  ok(!naFila.has(C), 'reciprocidade: C (PIX pendente < 24 h) NÃO está na fila ainda');

  const perfil = await get(`/api/admin/crm/lead/${A}`, token);
  ok(perfil.success, 'perfil de A abre');
  const p = perfil.data;
  ok(p.pedidoDeOracao?.includes('emprego'), 'perfil: pedido de oração em destaque');
  ok(p.respostas.length === 2, `perfil: 2 respostas do quiz (${p.respostas.length})`);
  ok(p.respostas.some((r) => r.resposta.includes('Proteção')), 'perfil: resposta com acento íntegra');
  ok(p.timeline.some((t) => /Pedido de oração enviado/.test(t.texto)), 'perfil: timeline tem "Pedido de oração enviado"');
  ok(p.timeline.some((t) => /Oferta visualizada/.test(t.texto)), 'perfil: timeline tem "Oferta visualizada"');
  ok(p.origem.anuncio?.startsWith('A-TESTE-PEDIDO'), 'perfil: origem do anúncio preservada');
  ok(p.origem.capa === 'pedido', 'perfil: capa registrada');

  const nota = await post(`/api/admin/crm/lead/${A}/nota`, { texto: 'Liguei, vai pagar amanhã' }, token);
  ok(nota.status === 200, 'nota interna salva');
  const marcado = await post(`/api/admin/crm/lead/${A}/marcar`, { contatado: true }, token);
  ok(marcado.status === 200 && marcado.json?.data?.contatadoEm, 'marcar contatado grava a hora');
  const perfil2 = await get(`/api/admin/crm/lead/${A}`, token);
  ok(perfil2.data.notas.length === 1 && perfil2.data.ultimoContatoEm !== null, 'perfil reflete nota e último contato');

  const optout = await post(`/api/admin/crm/lead/${A}/marcar`, { optOut: true }, token);
  ok(optout.json?.data?.optOut === true, 'opt-out grava');
  const perfil3 = await get(`/api/admin/crm/lead/${A}`, token);
  ok(perfil3.data.segmento === 'NAO_CONTATAR' && perfil3.data.status === 'opt_out', 'opt-out muda segmento para NÃO CONTATAR');
  const fila2 = await get('/api/admin/crm/reciprocidade?dias=1', token);
  ok(!fila2.data.fila.some((l) => l.sessionId === A), 'opt-out some da fila de reciprocidade');

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : falhas + ' FALHA(S)'}\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
