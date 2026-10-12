/**
 * Testa o fechamento diário (server/fechamento.ts) com relógio fixo.
 * Roda com: npx tsx scripts/testar-fechamento.mjs
 */
import { montarFechamento, textoDoFechamento } from '../server/fechamento.ts';
import { criarRepositorioEmMemoria } from '../server/painel/repositorio.ts';

let falhas = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { falhas += 1; console.log('  ✗', msg); }
}

// Sexta 15/08/2026 15:00 em São Paulo = 18:00Z
const agoraMs = Date.parse('2026-08-15T18:00:00Z');

const pedido = (id, { criadoEm, status, centavos, pai = null }) => ({
  id, createdAt: criadoEm, updatedAt: criadoEm, offer: 'main', itemIds: ['main'], amountCents: centavos,
  status, customer: { name: 'x', email: 'x@x', document: '0' }, parentOrderId: pai, paymentId: null,
  qrCode: null, qrImageUrl: null, expiresAt: null, paidAt: status === 'completed' ? criadoEm : null,
  lastStatusCheckAt: null, processedWebhooks: [], clientIp: null, trackId: null, atribuicao: {},
});

const pedidos = [
  // hoje: 2 PIX, 1 pago 47, 1 pendente
  pedido('a', { criadoEm: '2026-08-15T12:00:00Z', status: 'completed', centavos: 4700 }),
  pedido('b', { criadoEm: '2026-08-15T13:00:00Z', status: 'pending', centavos: 4700 }),
  // upsell pago hoje, filho do 'a'
  pedido('a-up', { criadoEm: '2026-08-15T12:10:00Z', status: 'completed', centavos: 1990, pai: 'a' }),
  // ontem: 3 PIX, 2 pagos (47 + 74), 1 expirado
  pedido('c', { criadoEm: '2026-08-14T10:00:00Z', status: 'completed', centavos: 4700 }),
  pedido('d', { criadoEm: '2026-08-14T11:00:00Z', status: 'completed', centavos: 7400 }),
  pedido('e', { criadoEm: '2026-08-14T12:00:00Z', status: 'expired', centavos: 4700 }),
  // 14/08 às 23:50 SP = 15/08 02:50Z → tem de cair em ONTEM (14/08)
  pedido('f', { criadoEm: '2026-08-15T02:50:00Z', status: 'completed', centavos: 4700 }),
  // fora da janela de 3 dias
  pedido('g', { criadoEm: '2026-08-01T12:00:00Z', status: 'completed', centavos: 4700 }),
];

const funil = [
  { dia: '2026-08-15', visitas: 40, quiz: 20, vsl: 10, checkout: 4 },
  { dia: '2026-08-14', visitas: 100, quiz: 50, vsl: 25, checkout: 8 },
];
const investimentos = [
  { chave: 'X', dia: '2026-08-15', nivel: 'campanha', centavos: 3000, impressoes: 0, cliques: 0 },
  { chave: 'X', dia: '2026-08-14', nivel: 'campanha', centavos: 6000, impressoes: 0, cliques: 0 },
  { chave: 'Y', dia: '2026-08-14', nivel: 'campanha', centavos: 4000, impressoes: 0, cliques: 0 },
];

console.log('montarFechamento');
const f = montarFechamento({ dias: 3, agoraMs, pedidos, funil, investimentos });
ok(f.hoje === '2026-08-15', 'hoje é 15/08 em SP');
ok(f.dias.length === 3 && f.dias[0].dia === '2026-08-15' && f.dias[2].dia === '2026-08-13', 'três linhas, mais recente primeiro, com o dia vazio');

const hoje = f.dias[0], ontem = f.dias[1], anteontem = f.dias[2];
ok(hoje.parcial && !ontem.parcial, 'só hoje é parcial');
ok(hoje.pixGerados === 2 && hoje.vendas === 1 && hoje.pendentes === 1 && hoje.upsellsPagos === 1, 'hoje: 2 PIX, 1 venda, 1 pendente, 1 upsell');
ok(hoje.receitaCentavos === 6690, 'hoje receita 47 + 19,90 = 66,90');
ok(hoje.investidoCentavos === 3000 && hoje.lucroCentavos === 3690, 'hoje investido 30 → lucro 36,90');
ok(Math.abs(hoje.roas - 2.23) < 0.01, 'hoje ROAS 2,23x');
ok(hoje.cpaCentavos === 3000 && hoje.ticketCentavos === 6690, 'CPA 30, ticket 66,90');
ok(hoje.visitas === 40 && hoje.taxaPix === 0.05 && hoje.taxaPagamento === 0.5, 'visita→PIX 5%, PIX→pago 50%');

ok(ontem.pixGerados === 4 && ontem.vendas === 3, 'ontem: 4 PIX (inclui o das 23h50) e 3 vendas');
ok(ontem.receitaCentavos === 16800, 'ontem receita 47+74+47 = 168');
ok(ontem.investidoCentavos === 10000 && ontem.temInvestimento, 'ontem investido 100 (duas campanhas somadas)');
ok(ontem.lucroCentavos === 6800 && ontem.roas === 1.68, 'ontem lucro 68, ROAS 1,68x');
ok(ontem.pendentes === 0, 'expirado não é pendente');

ok(anteontem.visitas === 0 && !anteontem.temInvestimento && anteontem.roas === null && anteontem.lucroCentavos === 0, 'dia vazio: zeros e derivados nulos');

ok(f.totais.vendas === 4 && f.totais.receitaCentavos === 23490 && f.totais.investidoCentavos === 13000, 'totais: 4 vendas, 234,90, 130 investidos');
ok(f.totaisFechados.vendas === 3 && f.totaisFechados.receitaCentavos === 16800, 'totais fechados excluem hoje');
ok(f.melhorDia === '2026-08-14', 'melhor dia fechado é ontem');
ok(!pedidos.some((p) => p.id === 'g' && f.dias.some((d) => d.dia === '2026-08-01')), 'pedido fora da janela ignorado');

console.log('\ntextoDoFechamento');
const txt = textoDoFechamento(hoje);
ok(txt.includes('15/08/2026 (parcial)'), 'cabeçalho com data e "parcial"');
ok(/R\$\s66,90/.test(txt) && txt.includes('1 venda (+1 upsell)'), 'receita e vendas');
ok(txt.includes('ROAS 2,23x'), 'ROAS com vírgula');
ok(txt.includes('1 PIX ainda aguardando'), 'pendentes');
console.log('\n' + txt.split('\n').map((l) => '    ' + l).join('\n'));

console.log('\nfunilPorDia (memória)');
const repo = criarRepositorioEmMemoria();
const evento = (sessionId, evento) => ({ sessionId, evento, atribuicao: {}, step: null, pedidoId: null });
await repo.registrarEventoDoFunil(evento('s1', 'PageView'));
await repo.registrarEventoDoFunil(evento('s1', 'CompleteRegistration'));
await repo.registrarEventoDoFunil(evento('s2', 'PageView'));
const porDia = await repo.funilPorDia({ desde: '2000-01-01T00:00:00Z', ate: '2999-01-01T00:00:00Z' });
ok(porDia.length === 1 && porDia[0].visitas === 2 && porDia[0].quiz === 1 && porDia[0].vsl === 0, 'duas sessões hoje, uma no quiz');

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo verde.');
process.exit(falhas ? 1 : 0);
