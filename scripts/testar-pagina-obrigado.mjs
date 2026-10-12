/**
 * Testa a página de obrigado (/obg) num navegador de verdade.
 *
 * Ela é o endereço que o Google Ads conta como conversão de compra. Duas coisas
 * precisam valer ao mesmo tempo, e as duas quebram calada:
 *
 *   1. o cliente TEM de chegar em /obg ao terminar o checkout — sem a ida, a
 *      campanha mede zero venda e otimiza no escuro;
 *   2. os acessos precisam aparecer lá — saindo do checkout, é em /obg que o
 *      cliente vê o que comprou, e uma página bonita sem os links é uma venda
 *      seguida de um chamado no WhatsApp.
 *
 * Precisa do backend em modo mock (nenhuma cobrança real) e do front apontado
 * para ele:
 *
 *   BITFLOW_MODE=mock PORT=3334 npx tsx server/index.ts
 *   PORT=3334 npx vite --port=4300 --strictPort
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pagina-obrigado.mjs http://localhost:4300
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await (async () => {
  const fora = process.env.PLAYWRIGHT_DIR;
  try {
    if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
    return await import('playwright');
  } catch {
    console.error(
      '\nplaywright nao encontrado.\n' +
      '  npm i playwright && npx playwright install chromium   (numa pasta fora do projeto)\n' +
      '  PLAYWRIGHT_DIR=<essa pasta> node scripts/testar-pagina-obrigado.mjs <url>\n'
    );
    process.exit(1);
  }
})();

const BASE = process.argv[2] ?? 'http://localhost:4300';
const BOTAO_VSL = 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA';

/*
 * TRAVA CONTRA COBRANÇA REAL.
 *
 * O caso 2 deste arquivo compra de verdade: preenche o formulário e aperta o
 * botão que gera o PIX. Contra um servidor em modo mock isso é grátis e a
 * cobrança se confirma sozinha. Contra PRODUÇÃO, onde `PIX_MODE` é `live`, cada
 * execução cria uma cobrança de verdade na PixGo e um pedido de mentira no banco
 * — e o teste ainda assim trava, porque em live nada se confirma sozinho.
 *
 * Isso aconteceu em 10/08/2026: a suíte inteira foi rodada contra
 * https://rezassagradas.site logo depois de um deploy, e este arquivo criou uma
 * cobrança de R$ 74,00 em nome de "Teste Obrigado". Ninguém pagou, então nenhum
 * dinheiro se moveu, mas ficou lixo no banco de pedidos de produção.
 *
 * O aviso no cabeçalho não bastou: quem roda a bateria toda passa a URL uma vez
 * e não relê seis cabeçalhos. Por isso a trava é código, não texto. Só localhost
 * passa direto; para qualquer outro endereço é preciso dizer, por extenso, que
 * do outro lado há um servidor em modo mock.
 */
const ehLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(BASE);
const assumiuORisco = process.env.EU_SEI_QUE_E_MOCK === 'sim';
if (!ehLocal && !assumiuORisco) {
  console.error(
    `\nRECUSADO: ${BASE} não é localhost.\n\n` +
    'Este teste COMPRA DE VERDADE. Num servidor com PIX_MODE=live (produção),\n' +
    'ele cria uma cobrança real na PixGo e um pedido falso no banco.\n\n' +
    'Se o alvo é mesmo um servidor em modo mock, diga isso na mão:\n' +
    `  EU_SEI_QUE_E_MOCK=sim PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-pagina-obrigado.mjs ${BASE}\n`
  );
  process.exit(1);
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 420, height: 900 } });

const erros = [];
let tudoOk = true;

function checar(ok, descricao) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}`);
  if (!ok) tudoOk = false;
}

console.log(`\nPagina de obrigado em ${BASE}\n`);

// 1. A pagina existe no mesmo endereco que vai no Google Ads.
{
  const pagina = await contexto.newPage();
  const resposta = await pagina.goto(`${BASE}/obg`, { waitUntil: 'domcontentloaded' });
  checar(resposta?.status() === 200, `/obg responde 200 (recebido: ${resposta?.status()})`);
  checar(
    await pagina.getByText('Pagamento confirmado').isVisible().catch(() => false),
    '/obg mostra a confirmacao',
  );
  // Sem pedido guardado a pagina nao pode quebrar: quem colou o link ou trocou
  // de aparelho precisa de uma saida, nao de um erro.
  checar(
    await pagina.getByText('enviados por e-mail', { exact: false }).isVisible().catch(() => false),
    'sem pedido guardado, oferece a saida por e-mail em vez de erro',
  );
  await pagina.close();
}

// 2. O caminho de verdade: comprar, pagar e terminar o checkout.
{
  const pagina = await contexto.newPage();
  pagina.on('pageerror', (e) => erros.push(e.message));
  await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });
  await pagina.getByRole('button', { name: BOTAO_VSL }).click();
  await pagina.waitForTimeout(600);

  await pagina.getByPlaceholder('Seu nome completo').fill('Teste Obrigado');
  await pagina.getByPlaceholder('Seu melhor e-mail', { exact: false }).fill('obrigado@exemplo.com');
  await pagina.getByPlaceholder('WhatsApp com DDD', { exact: false }).fill('71999999999');
  await pagina.getByPlaceholder('CPF de quem vai pagar (000.000.000-00)').fill('529.982.247-25');
  await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).click();

  // No modo mock a cobranca se confirma sozinha depois de alguns segundos.
  await pagina.getByRole('button', { name: /SIM! ADICIONAR O APLICATIVO|Não, obrigado/ })
    .first()
    .waitFor({ timeout: 60000 });
  checar(true, 'pagamento confirmado leva ao upsell (o upsell nao foi pulado)');

  // Recusa upsell e downsell ate o fim do fluxo.
  for (let volta = 0; volta < 4; volta += 1) {
    if (pagina.url().includes('/obg')) break;
    const recusar = pagina.getByRole('button', { name: /Não, obrigado|Não quero|Finalizar|Concluir/ }).first();
    if (await recusar.isVisible().catch(() => false)) {
      await recusar.click();
      await pagina.waitForTimeout(1200);
    } else {
      break;
    }
  }

  await pagina.waitForURL(/\/obg/, { timeout: 20000 }).catch(() => {});
  checar(pagina.url().includes('/obg'), `terminar o checkout leva para /obg (url: ${pagina.url()})`);

  if (pagina.url().includes('/obg')) {
    /*
     * Localizador por id, e não por texto: "Seus acessos" aparece tanto no
     * título da lista quanto dentro do aviso "Seus acessos foram enviados por
     * e-mail", e o casamento duplo derruba a checagem mesmo com a página certa.
     */
    await pagina.waitForTimeout(2500);
    const secao = (id) => pagina.locator(id).evaluate((el) => el.offsetParent !== null).catch(() => false);

    const temAcessos = await secao('#acessos');
    const temEmail = await secao('#semAcessos');
    checar(temAcessos || temEmail, 'a pagina mostra os acessos ou a saida por e-mail, nunca um vazio');
    checar(!(await secao('#carregando')), 'nao fica preso em "buscando..."');

    if (temAcessos) {
      const cartoes = await pagina.locator('#listaAcessos .cartao').count();
      checar(cartoes > 0, `lista os produtos comprados (${cartoes} item(ns))`);
    }
  }
  await pagina.close();
}

if (erros.length > 0) {
  console.log('\n  erros de javascript na pagina:');
  for (const e of erros) console.log('    ' + e);
  tudoOk = false;
}

await navegador.close();
console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
process.exit(tudoOk ? 0 : 1);
