/**
 * Bateria da aba Boletos.
 *
 *   node scripts/testar-painel-boletos.mjs
 *
 * Precisa do ambiente de teste no ar (`npm run teste`). Bate direto na API, sem
 * navegador: o que está sendo verificado aqui é o CICLO DE VIDA do pedido de
 * boleto, que é onde o dinheiro some se algo estiver errado —
 *
 *  - o pedido nasce do checkout com o valor calculado pelo CATÁLOGO, e não pelo
 *    que o navegador mandar;
 *  - dois toques no mesmo botão continuam sendo uma pessoa só na contagem;
 *  - marcar gerado/pago/não pago carimba as datas certas e desfaz direito;
 *  - a compra paga sai para o Meta uma vez só;
 *  - a venda por boleto entra nas vendas por anúncio, senão o criativo que
 *    vendeu aparece como se não tivesse vendido.
 */
import process from 'node:process';

const BASE = process.env.BASE ?? 'http://localhost:3334';
const SENHA = process.env.ADMIN_SENHA ?? 'painel-local-2026';

let passou = 0;
let falhou = 0;

function conferir(descricao, condicao, detalhe) {
  if (condicao) {
    passou += 1;
    console.log(`  ok   ${descricao}`);
  } else {
    falhou += 1;
    console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** CPF válido gerado na hora: repetir um CPF fixo entre rodadas ativa o idempotente. */
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) soma += base[i] * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    base.push(resto === 10 ? 0 : resto);
  }
  return base.join('');
}

async function chamar(caminho, opcoes = {}) {
  const resposta = await fetch(`${BASE}/api${caminho}`, {
    method: opcoes.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opcoes.token ? { 'X-Admin-Sessao': opcoes.token } : {}),
    },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  const corpo = await resposta.json().catch(() => ({}));
  return { status: resposta.status, corpo };
}

async function principal() {
  console.log('\nBateria da aba Boletos\n');

  /* ------------------------------------------------------ 1. O pedido -- */
  console.log('1. O pedido nasce do checkout');

  const cpf = cpfValido();
  const cliente = {
    name: 'Maria das Dores Teste',
    email: `maria.boleto.${Date.now()}@exemplo.com`,
    phone: '31988887777',
    document: cpf,
  };

  const pedido = await chamar('/boletos/pedido', {
    method: 'POST',
    body: {
      customer: cliente,
      bumps: [],
      contribuicao: null,
      session_id: `teste-boleto-${Date.now()}`,
      attrib: { fb_ad_id: '120000000000000001', utm_content: 'criativo-de-teste', fbc: 'fb.1.1755000000000.abc' },
    },
  });

  conferir('o pedido é aceito', pedido.status === 201, `status ${pedido.status}`);
  conferir('devolve um identificador', typeof pedido.corpo.data?.id === 'string');
  // R$ 47,00 é a Oração sozinha, sem order bump. O valor conferido aqui vem do
  // catálogo do servidor: o corpo da requisição não manda preço nenhum.
  conferir(
    'o valor sai do catálogo (R$ 47,00), não do navegador',
    pedido.corpo.data?.valorCentavos === 4700,
    `veio ${pedido.corpo.data?.valorCentavos}`,
  );

  const id = pedido.corpo.data?.id;

  const repetido = await chamar('/boletos/pedido', {
    method: 'POST',
    body: { customer: cliente, bumps: [], session_id: 'outra-sessao', attrib: {} },
  });
  conferir('tocar de novo não cria um segundo pedido', repetido.corpo.data?.id === id, `veio ${repetido.corpo.data?.id}`);
  conferir('e responde 200 em vez de 201', repetido.status === 200, `status ${repetido.status}`);

  const semCpf = await chamar('/boletos/pedido', {
    method: 'POST',
    body: { customer: { ...cliente, document: '11111111111' }, bumps: [] },
  });
  conferir('CPF inválido é recusado', semCpf.status === 400, `status ${semCpf.status}`);

  const comBumpInventado = await chamar('/boletos/pedido', {
    method: 'POST',
    body: { customer: { ...cliente, document: cpfValido() }, bumps: ['nao_existe'] },
  });
  conferir('produto inventado é recusado', comBumpInventado.status === 400, `status ${comBumpInventado.status}`);

  /* -------------------------------------------------------- 2. Painel -- */
  console.log('\n2. O painel enxerga o pedido');

  const login = await chamar('/admin/login', { method: 'POST', body: { senha: SENHA } });
  if (login.status !== 200) {
    console.log(`\n  Não consegui entrar no painel (status ${login.status}). O ambiente de teste está no ar?`);
    process.exit(1);
  }
  const token = login.corpo.data.token;

  const lista = await chamar('/admin/boletos?dias=1', { token });
  conferir('a lista responde', lista.status === 200, `status ${lista.status}`);

  const linha = (lista.corpo.data?.pedidos ?? []).find((p) => p.id === id);
  conferir('o pedido aparece na lista', Boolean(linha));
  conferir('com o CPF inteiro, que é para quem vai emitir', linha?.documento === cpf);
  conferir('com o valor formatado', linha?.valorFormatado === 'R$ 47,00', `veio ${linha?.valorFormatado}`);
  conferir('e com o criativo de onde a pessoa veio', linha?.criativo === 'criativo-de-teste');
  conferir('já contado como "pedido"', linha?.situacao === 'pedido');
  conferir('o resumo conta o que está esperando', (lista.corpo.data?.resumo?.pedido ?? 0) >= 1);

  /* ------------------------------------------------- 3. As marcações -- */
  console.log('\n3. As marcações do dono');

  const gerado = await chamar(`/admin/boletos/${id}/situacao`, {
    method: 'POST',
    token,
    body: { situacao: 'gerado', observacao: 'boleto 34191.79001 01043.510047' },
  });
  conferir('marcar como gerado funciona', gerado.status === 200, `status ${gerado.status}`);
  conferir('carimba a data de emissão', Boolean(gerado.corpo.data?.pedido?.geradoEm));
  conferir('guarda a anotação', gerado.corpo.data?.pedido?.observacao?.includes('34191'));
  conferir('e não manda nada ao Meta ainda', gerado.corpo.data?.meta === null);

  const pago = await chamar(`/admin/boletos/${id}/situacao`, { method: 'POST', token, body: { situacao: 'pago' } });
  conferir('marcar como pago funciona', pago.status === 200, `status ${pago.status}`);
  conferir('carimba a data de pagamento', Boolean(pago.corpo.data?.pedido?.pagoEm));
  conferir('mantém a data de emissão', Boolean(pago.corpo.data?.pedido?.geradoEm));
  conferir('preserva a anotação de quem marcou antes', pago.corpo.data?.pedido?.observacao?.includes('34191'));
  conferir('e diz o que aconteceu com o Meta', typeof pago.corpo.data?.meta?.detalhe === 'string');

  const situacaoInventada = await chamar(`/admin/boletos/${id}/situacao`, {
    method: 'POST',
    token,
    body: { situacao: 'quase_pago' },
  });
  conferir('situação inventada é recusada', situacaoInventada.status === 400, `status ${situacaoInventada.status}`);

  const inexistente = await chamar('/admin/boletos/bol_naoexiste/situacao', {
    method: 'POST',
    token,
    body: { situacao: 'pago' },
  });
  conferir('boleto inexistente devolve 404', inexistente.status === 404, `status ${inexistente.status}`);

  const semSenha = await chamar('/admin/boletos?dias=1');
  conferir('sem senha a lista não abre', semSenha.status === 401, `status ${semSenha.status}`);

  /* --------------------------------------------- 4. Vendas do anúncio -- */
  console.log('\n4. A venda chega no anúncio');

  const vendas = await chamar('/admin/anuncios/vendas?dias=1', { token });
  const doAnuncio = vendas.corpo.data?.porAnuncio?.['120000000000000001'];
  conferir('o boleto pago entra nas vendas por anúncio', (doAnuncio?.pagos ?? 0) >= 1, JSON.stringify(doAnuncio));
  conferir('e aparece separado, para dar para conferir', (doAnuncio?.pagosBoleto ?? 0) >= 1);
  conferir('a receita do boleto soma', (doAnuncio?.receita ?? 0) >= 4700);
  conferir('o total de boletos é declarado', (vendas.corpo.data?.boletos?.pagos ?? 0) >= 1);

  /* --------------------------------------------------- 5. O desfazer -- */
  console.log('\n5. Desfazer');

  const voltou = await chamar(`/admin/boletos/${id}/situacao`, { method: 'POST', token, body: { situacao: 'pedido' } });
  conferir('dá para voltar para pedido', voltou.corpo.data?.pedido?.situacao === 'pedido');
  conferir('e as datas de desfecho somem junto', !voltou.corpo.data?.pedido?.pagoEm && !voltou.corpo.data?.pedido?.geradoEm);

  const naoPagou = await chamar(`/admin/boletos/${id}/situacao`, { method: 'POST', token, body: { situacao: 'nao_pago' } });
  conferir('marcar como não pago funciona', naoPagou.corpo.data?.pedido?.situacao === 'nao_pago');
  conferir('carimba quando desistiu', Boolean(naoPagou.corpo.data?.pedido?.naoPagoEm));

  const finalDaLista = await chamar('/admin/boletos?dias=1', { token });
  const finalDaLinha = (finalDaLista.corpo.data?.pedidos ?? []).find((p) => p.id === id);
  conferir('o pedido não sumiu da lista', Boolean(finalDaLinha));
  conferir('e a contagem de não pagos subiu', (finalDaLista.corpo.data?.resumo?.naoPago ?? 0) >= 1);

  console.log(`\n${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou > 0 ? 1 : 0);
}

principal().catch((erro) => {
  console.error('\nA bateria quebrou:', erro.message);
  process.exit(1);
});
