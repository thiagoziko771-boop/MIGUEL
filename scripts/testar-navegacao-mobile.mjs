/**
 * O funil inteiro percorrido no celular, do anúncio ao acesso liberado.
 *
 *   npm run teste            (noutro terminal)
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-navegacao-mobile.mjs
 *
 * As outras baterias olham UMA tela cada. Esta olha o CAMINHO: se a pessoa
 * consegue ir do começo ao fim sem travar, sem precisar de gesto que ela não
 * sabe fazer e sem cair numa tela que não explica o que aconteceu.
 *
 * Por que só no celular: é de onde vem o tráfego pago deste funil, e é onde os
 * defeitos aparecem. Num monitor de 1280px cabe tudo e nada quebra — o
 * enquadramento errado, o botão fora da dobra e a rolagem horizontal só existem
 * na largura de 390px.
 *
 * DUAS ARMADILHAS DE MEDIÇÃO que custaram horas e estão resolvidas aqui:
 *
 *  - `fullPage: true` e `deviceScaleFactor` alto fazem o Playwright mexer no
 *    tamanho da janela, e isso remonta a árvore do React no meio da jornada: o
 *    checkout volta ao início sozinho e a bateria acusa "o PIX não aparece".
 *    Girar o aparelho DE VERDADE não tem esse efeito — foi medido à parte, e o
 *    formulário preenchido sobrevive à rotação.
 *  - Editar arquivos do projeto enquanto a bateria roda dispara o HMR do Vite,
 *    que troca o módulo e zera o estado pelo mesmo caminho. Rode com o código
 *    parado.
 *
 * ATENÇÃO ao editar este arquivo no Windows: `Out-File`/`Set-Content` do
 * PowerShell corrompem os acentos e os seletores deixam de casar.
 */
import fs from 'node:fs';
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
const FOTOS = process.env.SCREENSHOT_DIR ?? '.data-teste/fotos';
fs.mkdirSync(FOTOS, { recursive: true });

/**
 * Um CPF válido diferente a cada execução.
 *
 * O servidor reaproveita cobrança pendente idêntica (mesma pessoa, mesmo valor,
 * mesmos itens) dentro de uma janela de minutos. Repetindo o CPF, a segunda
 * rodada recebe de volta o pedido da primeira — e se o servidor tiver sido
 * reiniciado no meio, esse pedido aponta para uma cobrança simulada que o
 * processo novo não conhece e que nunca confirma.
 */
function cpfValido() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const digito = (base) => {
    const soma = base.reduce((total, valor, i) => total + valor * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(n);
  const d2 = digito([...n, d1]);
  return [...n, d1, d2].join('');
}

const CPF_DA_RODADA = cpfValido();
const EMAIL_DA_RODADA = `teste.mobile.${Date.now()}@exemplo.com`;

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: 'pt-BR',
  permissions: ['clipboard-read', 'clipboard-write'],
});
const pagina = await contexto.newPage();

const errosDeConsole = [];
pagina.on('console', (m) => { if (m.type() === 'error') errosDeConsole.push(m.text().slice(0, 160)); });
pagina.on('pageerror', (e) => errosDeConsole.push(String(e.message).slice(0, 160)));

/** Mede a etapa: rolagem lateral, alvos de toque e se existe ação à vista. */
async function auditarEtapa(nome) {
  await pagina.waitForTimeout(500);
  const medida = await pagina.evaluate(() => {
    const doc = document.documentElement;
    const excesso = Math.max(0, doc.scrollWidth - doc.clientWidth);

    const pequenos = [...document.querySelectorAll('button, a[href], input, [role="radio"]')]
      .filter((el) => {
        const c = el.getBoundingClientRect();
        const visivel = c.width > 0 && c.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        return visivel && c.height < 44;
      })
      .map((el) => (el.textContent || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 40));

    const acoes = [...document.querySelectorAll('button, a[href]')].filter((el) => {
      const c = el.getBoundingClientRect();
      return c.height > 0 && c.width > 0;
    }).length;

    return { excesso, pequenos, acoes, largura: doc.scrollWidth };
  });

  checar(medida.excesso === 0, `[${nome}] sem rolagem para o lado`, `sobra ${medida.excesso}px (largura ${medida.largura})`);
  checar(medida.pequenos.length === 0, `[${nome}] nenhum alvo de toque menor que 44px`, medida.pequenos.join(' | '));
  /*
   * A última tela é a exceção: ela é o fim do caminho, e o que precisa haver ali
   * é o ACESSO ao que foi comprado — medido adiante, com critério próprio.
   */
  if (nome !== '6-fim') {
    checar(medida.acoes > 0, `[${nome}] a tela tem ao menos uma acao visivel`);
  }

  await pagina.screenshot({ path: path.join(FOTOS, `mobile-${nome}.png`) });
}

console.log(`\nNavegacao completa no celular (390x844) em ${BASE}\n`);

/* ---------------------------------------------------------------- entrada -- */
await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(1500);
await auditarEtapa('1-oferta');

const cta = pagina.getByRole('button', { name: /EU QUERO A ORA/i });
checar(await cta.count() > 0, '[oferta] o botao de compra existe');
await cta.first().click();
await pagina.waitForTimeout(1200);
await auditarEtapa('2-checkout');

/* -------------------------------------------------------------- formulario -- */
const camposVisiveis = await pagina.evaluate(() =>
  [...document.querySelectorAll('input')].every((i) => {
    const c = i.getBoundingClientRect();
    return c.left >= 0 && c.right <= document.documentElement.clientWidth + 1;
  }));
checar(camposVisiveis, '[checkout] todos os campos cabem na largura da tela');

/*
 * 16px é o limite do Safari do iPhone: abaixo disso ele dá zoom sozinho quando o
 * campo recebe foco, e a tela inteira salta de lugar — no formulário de
 * pagamento, com a pessoa já decidida a comprar.
 */
const fontes = await pagina.evaluate(() =>
  [...document.querySelectorAll('input')].map((i) => parseFloat(getComputedStyle(i).fontSize)));
checar(fontes.every((f) => f >= 16), '[checkout] os campos tem fonte de 16px ou mais (iPhone nao da zoom)', fontes.join(','));

await pagina.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
await pagina.getByPlaceholder('Seu melhor e-mail (onde chega o acesso)').fill(EMAIL_DA_RODADA);
await pagina.getByPlaceholder(/WhatsApp com DDD/).fill('11912345678');
await pagina.getByPlaceholder(/CPF/).fill(CPF_DA_RODADA);

const semente = await pagina.evaluate(() => {
  const bs = [...document.querySelectorAll('button[aria-pressed]')];
  return { total: bs.length, marcados: bs.filter((b) => b.getAttribute('aria-pressed') === 'true').length };
});
checar(semente.total === 3, '[checkout] os tres valores de contribuir mais estao la', String(semente.total));
checar(semente.marcados === 0, '[checkout] nenhum acrescimo vem marcado sozinho');

/*
 * A criação do pedido é atrasada em 900ms DE PROPÓSITO, e só aqui.
 *
 * Em produção o gateway leva de 1 a 3 segundos, e a barra de carregamento fica à
 * vista o tempo todo. No modo mock a resposta é instantânea e ela pisca — que é
 * o comportamento certo (a barra mostra o tempo REAL da chamada, e não uma
 * animação de enfeite), mas torna impossível medi-la. O atraso reproduz a
 * condição real; sem ele, esta checagem acusaria defeito numa barra que
 * funciona.
 */
await pagina.route('**/api/orders', async (rota) => {
  await new Promise((r) => setTimeout(r, 900));
  await rota.continue();
}, { times: 1 });

const rolagemAntes = await pagina.evaluate(() => window.scrollY);
await pagina.getByRole('button', { name: /QUERO MINHA ORA/i }).click();

/* -------------------------------------------------------------------- pix -- */
await pagina.waitForTimeout(400);
const barra = await pagina.locator('[role="progressbar"]').count();
checar(barra > 0, '[espera] a barra de carregamento aparece ao gerar o PIX');

/*
 * Espera pela ÂNCORA da área, e não por um texto: "Pix Copia e Cola" aparece
 * também no tutorial, e casar por texto aqui já deu falso negativo. Falhando, a
 * bateria diz o que havia na tela em vez de só estourar o tempo.
 */
try {
  await pagina.waitForSelector('#area-de-pagamento-pix', { timeout: 25000 });
} catch (erro) {
  const estado = await pagina.evaluate(() => ({
    temFormulario: Boolean(document.querySelector('input[placeholder*="CPF"]')),
    voltouAoComeco: [...document.querySelectorAll('button')].some((b) => /EU QUERO A ORA/i.test(b.textContent || '')),
    aviso: (document.body.innerText.match(/[^\n]*(inválid|Informe|Confira|tentativas|não foi poss|expirou)[^\n]*/i) || ['(nenhum)'])[0],
    trecho: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
  }));
  console.log('\n  DIAGNOSTICO da falha:');
  console.log('   formulario ainda na tela: ' + estado.temFormulario);
  console.log('   voltou para a tela inicial: ' + estado.voltouAoComeco);
  console.log('   aviso: ' + estado.aviso);
  console.log('   tela: "' + estado.trecho + '"\n');
  await pagina.screenshot({ path: path.join(FOTOS, 'falha-pix.png') });
  throw erro;
}
/*
 * O ENQUADRAMENTO É MEDIDO ANTES DE QUALQUER OUTRA COISA.
 *
 * A rolagem automática tenta três vezes (150ms, 600ms e 1200ms depois da troca
 * de passo) porque o vídeo acima só reserva a altura dele quando carrega. Esta
 * espera cobre as três; qualquer interação da bateria antes disso (inclusive
 * tirar foto) muda a posição e faz a medida acusar defeito que o cliente não
 * veria.
 */
await pagina.waitForTimeout(1600);
const rolagemDepois = await pagina.evaluate(() => window.scrollY);
checar(rolagemDepois !== rolagemAntes, '[pix] a tela se moveu sozinha ate o pagamento');

/*
 * O ENQUADRAMENTO EXATO da área de pagamento é medido por
 * scripts/testar-tela-pix.mjs, que existe só para essa tela e a mede em
 * repouso — lá o topo dá 80px, dentro do alvo.
 *
 * Aqui ele NÃO é verificado de novo, e isso é decisão consciente: esta bateria
 * interage com a página (mede, fotografa, clica) e cada interação mexe na
 * posição, produzindo números que variam entre 80px e 1100px para uma tela que
 * está correta. Uma medida que oscila assim não protege nada — só ensina a
 * ignorar falha vermelha, que é o pior que um teste pode fazer.
 */

await auditarEtapa('3-pix');

const copiar = pagina.getByRole('button', { name: 'Copiar código' });
checar(await copiar.count() > 0, '[pix] o botao de copiar esta na tela');
await copiar.click();
await pagina.waitForTimeout(500);
const copiado = await pagina.evaluate(() => navigator.clipboard.readText());
checar(copiado.length > 20, '[pix] o codigo foi copiado de verdade', `${copiado.length} caracteres`);

/* ------------------------------------------------- confirmacao e upsell ---- */
console.log('\n  (esperando a confirmacao simulada do PIX...)\n');
await pagina.waitForSelector('text=confirmada', { timeout: 90000 });
await auditarEtapa('4-upsell');

checar(
  await pagina.getByRole('button', { name: /ADICIONAR O APLICATIVO/i }).count() > 0,
  '[upsell] a oferta do aplicativo aparece depois do pagamento',
);
await pagina.getByRole('button', { name: /Sigo apenas com a minha/i }).click();
await pagina.waitForTimeout(1200);
await auditarEtapa('5-downsell');

const saidaDoDownsell = pagina.getByRole('button', { name: /Prefiro seguir|Sigo apenas|obrigado|quero apenas/i });
checar(await saidaDoDownsell.count() > 0, '[downsell] existe a saida para recusar');

/* -------------------------------------------------------------- conclusao -- */
await saidaDoDownsell.last().click();
await pagina.waitForTimeout(3000);

const url = pagina.url();
checar(/\/obg/.test(url) || (await pagina.getByText(/confirmado|acesso/i).count()) > 0,
  '[fim] o cliente termina na pagina de obrigado ou na tela de acesso', url);

const fim = await pagina.evaluate(() => ({
  itens: [...document.querySelectorAll('h1, h2, h3, h4, strong, p')]
    .filter((el) => /Oração Sagrada|Salmos/i.test(el.textContent || '')).length,
  comLink: [...document.querySelectorAll('a[href]')].filter((a) => /acessar|baixar|abrir/i.test(a.textContent || '')).length,
  semLink: /Entrega confirmada|ainda não configurado|Estamos preparando/i.test(document.body.innerText),
}));
checar(fim.itens > 0, '[fim] a tela lista o que a pessoa comprou', JSON.stringify(fim));

await auditarEtapa('6-fim');

checar(errosDeConsole.length === 0, 'nenhum erro de console na jornada inteira', errosDeConsole.slice(0, 3).join(' | '));

/*
 * O LINK DE ENTREGA é aviso, não falha: neste ambiente ele não existe de
 * propósito (DELIVERY_URL_* não é configurada em teste). Em PRODUÇÃO, porém,
 * isto significa cliente que pagou e não recebeu nada para abrir.
 */
if (fim.comLink === 0 && fim.semLink) {
  console.log('\n  AVISO   nenhum link de entrega na tela final.');
  console.log('          Esperado NESTE ambiente de teste. Em producao, confira');
  console.log('          /admin -> Entregas: cada item precisa de link ativo.');
}

console.log(`\n  fotos em ${path.resolve(FOTOS)}`);
await navegador.close();
console.log(`\n${tudoOk ? 'TUDO OK' : 'HOUVE FALHA'}\n`);
process.exit(tudoOk ? 0 : 1);
