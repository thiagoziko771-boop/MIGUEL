/**
 * A conta do lucro, centavo por centavo.
 *
 * Todo número esperado aqui foi calculado à mão e está escrito na conta ao lado
 * da asserção. É proposital: um teste de dinheiro que confere o código contra o
 * próprio código passa igual quando os dois estão errados, e o erro que este
 * módulo persegue — lucro inflado — é exatamente do tipo que ninguém percebe
 * olhando, porque o número continua parecendo um número.
 *
 * Roda com: npx tsx scripts/testar-custos.mjs
 */
import {
  CUSTOS_ZERADOS,
  despesasDaJanela,
  paraPercentual,
  repartir,
  roasDeEquilibrio,
} from '../server/custos.ts';
import { montarResumo } from '../server/resumo.ts';

let falhas = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok   ', msg);
  else { falhas += 1; console.log('  FALHA', msg); }
}
function igual(obtido, esperado, msg) {
  ok(obtido === esperado, `${msg} — esperado ${esperado}, obtido ${obtido}`);
}
function perto(obtido, esperado, msg) {
  ok(Math.abs(obtido - esperado) < 0.0001, `${msg} — esperado ~${esperado}, obtido ${obtido}`);
}

const CUSTOS = {
  gatewayPercentual: 5,
  gatewayFixoCentavos: 100,
  impostoSobreVendaPercentual: 6,
  impostoMetaAdsPercentual: 10,
  custoPorVendaCentavos: 0,
  configurado: true,
};

/* ==================================================== leitura de percentual */
console.log('\n== PERCENTUAL DIGITADO POR GENTE ==');
igual(paraPercentual('4,99'), 4.99, 'vírgula vira ponto');
igual(paraPercentual('4.99'), 4.99, 'ponto continua ponto');
igual(paraPercentual('5%'), 5, 'o símbolo de porcento é ignorado');
igual(paraPercentual('0'), 0, 'zero é um valor legítimo, não ausência');
igual(paraPercentual(''), null, 'campo em branco não vira zero');
igual(paraPercentual('abc'), null, 'texto não vira zero');
igual(paraPercentual('101'), null, 'acima de 100 é dedo errado');
igual(paraPercentual('-1'), null, 'negativo é recusado');

/* ============================================================= a repartição */
console.log('\n== A CONTA DO LUCRO ==');
const r = repartir(
  {
    receitaBrutaCentavos: 100000, // R$ 1.000 que ficaram
    vendas: 20,
    devolvidoCentavos: 10000, // R$ 100 devolvidos
    devolucoes: 2,
    investimentoCentavos: 50000, // R$ 500 no leilão
    despesasCentavos: 3000, // R$ 30
  },
  CUSTOS,
);

// liquidado = 100000 + 10000 = 110000 · liquidações = 22
// taxa = 110000 × 5% + 22 × 100 = 5500 + 2200
igual(r.taxasCentavos, 7700, 'taxa incide sobre o devolvido também');
// 100000 × 6% (o devolvido NÃO paga imposto: não é faturamento)
igual(r.impostoSobreVendasCentavos, 6000, 'imposto só sobre o que ficou');
igual(r.custosProdutoCentavos, 0, 'produto digital não tem custo por venda');
// 50000 × 10%
igual(r.impostoMetaAdsCentavos, 5000, 'imposto do anúncio é % sobre o leilão');
igual(r.gastoTotalCentavos, 55000, 'gasto total = leilão + imposto do leilão');
igual(r.impostoTotalCentavos, 11000, 'imposto total = venda + anúncio');
// 100000 − 7700 − 6000 − 0
igual(r.receitaLiquidaCentavos, 86300, 'líquido = bruto − taxa − imposto − produto');
// 86300 − 55000 − 3000
igual(r.lucroCentavos, 28300, 'lucro = líquido − gasto total − despesas');
perto(r.roas, 2, 'ROAS usa o leilão (100000 ÷ 50000), como o Gerenciador');
perto(r.roi, 28300 / 55000, 'ROI usa o gasto total, imposto incluído');
perto(r.margem, 0.283, 'margem = lucro ÷ bruto');

/* ============================================== o que existia antes de tudo */
console.log('\n== SEM CUSTOS CONFIGURADOS ==');
const zerado = repartir(
  { receitaBrutaCentavos: 100000, vendas: 20, devolvidoCentavos: 0, devolucoes: 0, investimentoCentavos: 50000, despesasCentavos: 0 },
  CUSTOS_ZERADOS,
);
// Sem modelo preenchido a conta tem de reproduzir EXATAMENTE o painel antigo:
// quem ainda não configurou não pode ver o número mudar sozinho.
igual(zerado.lucroCentavos, 50000, 'sem custos, lucro volta a ser receita − anúncio');
igual(zerado.taxasCentavos, 0, 'sem custos, taxa é zero');

/* =================================================== o ponto de equilíbrio */
console.log('\n== ROAS DE EQUILÍBRIO ==');
// sobra por real = 1 − 5% − 6% − 100/5000 = 0,87 · (1 + 10%) ÷ 0,87
const equilibrio = roasDeEquilibrio(CUSTOS, 5000);
perto(equilibrio, 1.1 / 0.87, 'empate = (1 + imposto do anúncio) ÷ sobra por real');

/*
 * A prova real: no ROAS de equilíbrio, o lucro tem de dar zero. É o que garante
 * que o número da tela e a conta do lucro falam da MESMA coisa — se as duas
 * usassem bases diferentes, a tela diria "empata em 1,26x" com o anúncio no
 * prejuízo a 1,26x, e o dono escalaria confiando nela.
 */
const receita = 100000;
const investimentoQueEmpata = Math.round(receita / equilibrio);
const prova = repartir(
  { receitaBrutaCentavos: receita, vendas: 20, devolvidoCentavos: 0, devolucoes: 0, investimentoCentavos: investimentoQueEmpata, despesasCentavos: 0 },
  CUSTOS,
);
ok(Math.abs(prova.lucroCentavos) <= 2, `no ROAS de equilíbrio o lucro é zero — obtido ${prova.lucroCentavos} centavos`);

// Ticket que não cobre nem a taxa fixa: não existe ROAS que salve.
igual(roasDeEquilibrio({ ...CUSTOS, gatewayFixoCentavos: 999999 }, 5000), null, 'ticket menor que a taxa fixa não tem empate');

/* ==================================================== despesas na janela --- */
console.log('\n== DESPESAS NA JANELA ==');
const despesas = [
  { id: '1', dia: '2026-08-10', descricao: 'copy', centavos: 5000, mensal: false },
  { id: '2', dia: '2026-08-01', descricao: 'fora da janela', centavos: 9900, mensal: false },
  { id: '3', dia: '2026-01-01', descricao: 'ferramenta', centavos: 30000, mensal: true },
  { id: '4', dia: '2026-09-01', descricao: 'assinatura futura', centavos: 60000, mensal: true },
];
// 5000 (única, dentro) + 30000÷30×7 (mensal rateada) = 5000 + 7000
igual(despesasDaJanela(despesas, '2026-08-08', '2026-08-14'), 12000, 'única na janela + mensal rateada por dia');
igual(despesasDaJanela([despesas[1]], '2026-08-08', '2026-08-14'), 0, 'despesa fora da janela não entra');
igual(despesasDaJanela([despesas[3]], '2026-08-08', '2026-08-14'), 0, 'assinatura que só passa a valer depois não cobra o passado');
// A mesma mensal numa janela de 1 dia: 30000÷30×1
igual(despesasDaJanela([despesas[2]], '2026-08-14', '2026-08-14'), 1000, 'mensal num dia só é 1/30, não o mês inteiro');

/* ========================================================= o resumo inteiro */
console.log('\n== O RESUMO ==');
const pedido = (id, { centavos, status, pai = null, fonte = null, gateway = null }) => ({
  id, createdAt: '2026-08-12T12:00:00Z', updatedAt: '2026-08-12T12:00:00Z',
  offer: pai ? 'upsell' : 'main', itemIds: ['main'], amountCents: centavos, status,
  customer: { name: 'x', email: 'x@x', phone: '', document: '0' },
  parentOrderId: pai, paymentId: null, qrCode: null, qrImageUrl: null, expiresAt: null,
  paidAt: status === 'completed' ? '2026-08-12T12:00:00Z' : null,
  lastStatusCheckAt: null, processedWebhooks: [], clientIp: null,
  statusGateway: gateway, atribuicao: fonte ? { utm_source: fonte } : {},
});

const resumo = montarResumo({
  pedidos: [
    pedido('a', { centavos: 4700, status: 'completed', fonte: 'facebook' }),
    pedido('b', { centavos: 4700, status: 'completed', fonte: 'facebook' }),
    pedido('c', { centavos: 4700, status: 'completed' }), // sem carimbo -> direto
    pedido('a-up', { centavos: 1990, status: 'completed', pai: 'a', fonte: 'facebook' }),
    pedido('d', { centavos: 4700, status: 'pending' }),
    pedido('e', { centavos: 4700, status: 'pending' }),
    pedido('f', { centavos: 4700, status: 'refunded', gateway: 'refunded' }),
    pedido('g', { centavos: 4700, status: 'refunded', gateway: 'chargeback' }),
    pedido('h', { centavos: 4700, status: 'expired' }),
  ],
  investimentos: [{ dia: '2026-08-12', chave: 'c1', centavos: 50000 }],
  despesasCentavos: 0,
  custos: CUSTOS,
});

igual(resumo.vendas, 4, '3 principais + 1 upsell pagos');
igual(resumo.receitaBrutaCentavos, 16090, '4700×3 + 1990');
igual(resumo.pendentes, 2, 'dois PIX esperando');
igual(resumo.pendenteCentavos, 9400, 'o valor que está esperando');
igual(resumo.devolucoes, 2, 'reembolso e chargeback contam como devolução');
igual(resumo.contestacoes, 1, 'só o chargeback é contestação');
igual(resumo.contestadoCentavos, 4700, 'o valor contestado');

// 3 completos + 2 pendentes + 2 devolvidos + 1 expirado (o upsell NÃO conta)
igual(resumo.pixGerados, 8, 'só os principais entram na taxa de aprovação');
perto(resumo.taxaDeAprovacao, 3 / 8, '3 dos 8 PIX gerados foram pagos');
// base = liquidações (4 vendas + 2 devoluções), não as vendas que sobraram
perto(resumo.reembolsoPercentual, 2 / 6, 'reembolso sobre o que foi liquidado');
perto(resumo.chargebackPercentual, 1 / 6, 'chargeback tem número próprio');
igual(resumo.ticketCentavos, 4023, '16090 ÷ 4, arredondado');

const facebook = resumo.vendasPorFonte.find((f) => f.chave === 'facebook');
const direto = resumo.vendasPorFonte.find((f) => f.chave === 'direto');
igual(facebook.centavos, 11390, 'facebook: 4700×2 + 1990 do upsell');
igual(facebook.vendas, 3, 'facebook: três cobranças pagas');
igual(direto.centavos, 4700, 'sem carimbo vira "direto", não some');
igual(resumo.formasDePagamento[0].chave, 'pix', 'pedido sem `metodo` é PIX');
igual(resumo.formasDePagamento[0].centavos, 16090, 'todo o faturamento veio por PIX');

// A repartição, conferida à mão sobre estes pedidos:
// liquidado = 16090 + 9400 = 25490 · liquidações = 6
// taxa = 25490 × 5% + 6 × 100 = 1274,5 + 600 = 1874,5 -> 1875
igual(resumo.custos.taxasCentavos, 1875, 'taxa sobre o liquidado do período');
igual(resumo.custos.impostoSobreVendasCentavos, 965, '16090 × 6% = 965,4 -> 965');
igual(resumo.custos.receitaLiquidaCentavos, 13250, '16090 − 1875 − 965');
igual(resumo.custos.lucroCentavos, -41750, '13250 − 55000: o período deu prejuízo');
ok(resumo.custosConfigurados === true, 'a tela sabe que os custos foram preenchidos');
ok(resumo.temInvestimento === true, 'houve gasto registrado');

const semCusto = montarResumo({ pedidos: [], investimentos: [], despesasCentavos: 0, custos: CUSTOS_ZERADOS });
ok(semCusto.custosConfigurados === false, 'sem modelo preenchido, a tela precisa avisar');
igual(semCusto.taxaDeAprovacao, null, 'sem PIX gerado, taxa de aprovação é "não sei", não zero');
igual(semCusto.roasDeEquilibrio, undefined, 'o resumo não inventa campo que não é dele');

console.log(falhas === 0
  ? '\nPASSOU — a conta do lucro fecha centavo a centavo.'
  : `\nREPROVOU: ${falhas} verificação(ões).`);
process.exit(falhas === 0 ? 0 : 1);
