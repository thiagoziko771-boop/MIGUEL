/**
 * A aba Boletos do painel, no navegador.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-aba-boletos.mjs http://localhost:4300
 *
 * A bateria irmã (testar-painel-boletos.mjs) prova que a API faz a coisa certa.
 * Esta prova a outra metade, que é a que o dono usa: que os cartões aparecem,
 * que os botões movem o estado NA TELA, e que o aviso de compra fora do Meta
 * some quando o problema é resolvido.
 *
 * Só o painel é aberto — o pedido de boleto é criado pela API, porque o que
 * está sendo medido aqui é a tela de quem administra, não a de quem compra.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await (async () => {
  const fora = process.env.PLAYWRIGHT_DIR;
  try {
    if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
    return await import('playwright');
  } catch {
    console.error('\nplaywright nao encontrado. Use PLAYWRIGHT_DIR=<pasta com playwright>\n');
    process.exit(1);
  }
})();

const BASE = process.argv[2] ?? 'http://localhost:4300';
const SENHA = process.env.ADMIN_SENHA ?? 'painel-local-2026';

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

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

/* Uma pessoa que pediu boleto, criada pela API antes de a tela abrir. */
const nome = `Bateria Boleto ${Date.now().toString().slice(-5)}`;
const criacao = await fetch(`${BASE}/api/boletos/pedido`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    customer: { name: nome, email: `bateria.${Date.now()}@exemplo.com`, phone: '31977776666', document: cpfValido() },
    bumps: ['salmos_150'],
    attrib: { fb_ad_id: '120000000000000009', utm_content: 'criativo-da-bateria' },
    session_id: `bateria-tela-${Date.now()}`,
  }),
});
if (!criacao.ok) {
  console.error(`\nNão consegui criar o pedido de boleto (status ${criacao.status}). O ambiente de teste está no ar?\n`);
  process.exit(1);
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
const pagina = await contexto.newPage();

const errosDoConsole = [];
pagina.on('pageerror', (erro) => errosDoConsole.push(erro.message));

try {
  console.log('\nAba Boletos no navegador\n');

  await pagina.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await pagina.fill('#senha', SENHA);
  await pagina.click('#botaoEntrar');
  await pagina.waitForSelector('#painel:not([hidden])', { timeout: 10_000 });

  const abaExiste = await pagina.locator('.abas button[data-aba="boletos"]').count();
  checar(abaExiste === 1, 'a aba Boletos existe na navegação');

  await pagina.click('.abas button[data-aba="boletos"]');
  await pagina.waitForSelector('#abaBoletos:not([hidden])', { timeout: 5_000 });
  await pagina.waitForSelector('.boleto', { timeout: 10_000 });

  const cartao = pagina.locator('.boleto').filter({ hasText: nome }).first();
  checar(await cartao.count() > 0, 'o pedido recém-criado aparece como cartão');

  const textoDoCartao = await cartao.innerText();
  checar(/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(textoDoCartao), 'o CPF aparece formatado, pronto para copiar');
  checar(textoDoCartao.includes('R$ 74,00'), 'o valor com o order bump está certo', textoDoCartao.slice(0, 200));
  checar(textoDoCartao.includes('criativo-da-bateria'), 'a tela diz de qual criativo a pessoa veio');
  checar(textoDoCartao.includes('Pediu boleto'), 'a situação começa em "Pediu boleto"');

  /* Os KPIs do topo: a pergunta "quantas pessoas pediram" tem de estar respondida. */
  const kpis = await pagina.locator('#kpisBoletos').innerText();
  checar(kpis.includes('Pediram boleto'), 'o topo conta quantas pessoas pediram boleto');
  checar(kpis.includes('Esperando'), 'o topo mostra quanto ainda pode entrar');

  /* Marcar como gerado. */
  await cartao.locator('button[data-situacao="gerado"]').click();
  await pagina.waitForFunction(
    (quem) => {
      const cartoes = Array.from(document.querySelectorAll('.boleto'));
      const alvo = cartoes.find((c) => c.innerText.includes(quem));
      return alvo && alvo.innerText.includes('Boleto gerado') && alvo.querySelector('.badge.aguardando');
    },
    nome,
    { timeout: 10_000 },
  );
  checar(true, 'marcar como gerado muda a etiqueta na tela');

  /* Marcar como pago: é aqui que a venda offline vira crédito do anúncio. */
  pagina.once('dialog', (d) => d.accept());
  await pagina.locator('.boleto').filter({ hasText: nome }).first().locator('button[data-situacao="pago"]').click();
  await pagina.waitForFunction(
    (quem) => {
      const cartoes = Array.from(document.querySelectorAll('.boleto'));
      const alvo = cartoes.find((c) => c.innerText.includes(quem));
      return alvo && alvo.querySelector('.badge.pago');
    },
    nome,
    { timeout: 10_000 },
  );
  checar(true, 'marcar como pago pinta a etiqueta de pago');

  /*
   * O ambiente de teste sobe com o Meta DESLIGADO, então a compra não sai — e é
   * exatamente esse o caso que precisa gritar na tela. Um pago sem envio é um
   * anúncio sem crédito pela venda que ele fez.
   */
  const pago = pagina.locator('.boleto').filter({ hasText: nome }).first();
  const avisoDoMeta = await pago.locator('.meta-boleto').count();
  checar(avisoDoMeta === 1, 'a linha do Meta aparece no cartão pago');
  const textoDoMeta = await pago.locator('.meta-boleto').innerText();
  checar(
    textoDoMeta.includes('não chegou ao Meta'),
    'e avisa em voz alta quando a compra não chegou ao Meta',
    textoDoMeta,
  );
  checar(await pago.locator('button[data-meta]').count() === 1, 'com o botão de enviar ao Meta à mão');

  /* O filtro de situação. */
  await pagina.click('#chipsSituacaoBoletos button[data-situacao="pedido"]');
  await pagina.waitForTimeout(200);
  const aposFiltro = await pagina.locator('.boleto').filter({ hasText: nome }).count();
  checar(aposFiltro === 0, 'filtrar por "Pediram" esconde quem já pagou');

  await pagina.click('#chipsSituacaoBoletos button[data-situacao="pago"]');
  await pagina.waitForTimeout(200);
  checar(
    await pagina.locator('.boleto').filter({ hasText: nome }).count() === 1,
    'e filtrar por "Pagaram" traz de volta',
  );

  /* A busca, que é como se acha alguém que ligou perguntando do boleto. */
  await pagina.click('#chipsSituacaoBoletos button[data-situacao=""]');
  await pagina.fill('#buscaBoletos', nome.split(' ')[2] ?? nome);
  await pagina.waitForTimeout(200);
  checar(await pagina.locator('.boleto').count() >= 1, 'a busca por nome encontra a pessoa');

  await pagina.fill('#buscaBoletos', 'zzzz-nao-existe');
  await pagina.waitForTimeout(200);
  checar(await pagina.locator('#vazioBoletos').isVisible(), 'busca sem resultado mostra o aviso de vazio');

  checar(errosDoConsole.length === 0, 'nenhum erro de JavaScript na tela', errosDoConsole.join(' | '));

  // Junto das fotos das outras baterias, e fora do repositório: a tela mostra
  // CPF e contato, ainda que de gente inventada.
  const foto = path.join('.data-teste', 'fotos', 'aba-boletos.png');
  await pagina.screenshot({ path: foto });
  console.log(`\n  (tela salva em ${foto})`);
} catch (erro) {
  checar(false, 'a bateria chegou ao fim', erro.message);
} finally {
  await navegador.close();
}

console.log(`\n${tudoOk ? 'Tudo certo.' : 'Há falhas acima.'}\n`);
process.exit(tudoOk ? 0 : 1);
