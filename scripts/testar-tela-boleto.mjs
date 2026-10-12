/**
 * Audita a escolha da forma de pagamento e a tela do boleto emitido.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-tela-boleto.mjs http://localhost:4300
 *
 * Exige o servidor em PIX_MODE=mock com BOLETO_PROVIDER=mock, e de preferência
 * com MOCK_BOLETO_CONFIRM_DELAY_MS alto (600000). Nada aqui move dinheiro: a
 * linha digitável do mock começa em 000, código de banco que não existe.
 *
 * O irmão desta bateria é testar-tela-pix.mjs, e a diferença entre as duas é a
 * própria razão desta existir. A tela do PIX é uma SALA DE ESPERA: a pessoa paga
 * em segundos e vê o acesso liberar. A do boleto é um COMPROVANTE — a
 * confirmação chega de 1 a 3 dias depois, com a página fechada. Por isso o que
 * se mede aqui não é só "o código apareceu", e sim se a tela AVISA do prazo
 * antes de a pessoa ir pagar, e se ela entrega o que se leva embora: número do
 * pedido, valor e vencimento.
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

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch();

// iPhone 14: o aparelho mediano deste público. Medir num monitor largo
// esconderia justamente os defeitos de enquadramento que importam aqui.
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  permissions: ['clipboard-read', 'clipboard-write'],
});

const pagina = await contexto.newPage();

const errosDeConsole = [];
pagina.on('console', (msg) => {
  if (msg.type() === 'error') errosDeConsole.push(msg.text().slice(0, 200));
});
pagina.on('pageerror', (erro) => errosDeConsole.push(String(erro.message).slice(0, 200)));

/*
 * O boleto que o SERVIDOR devolveu, capturado na resposta da criação.
 *
 * É contra ele que a tela é conferida, dígito por dígito. Ler só o que está na
 * tela provaria que existe um texto com cara de boleto ali — e uma linha
 * inventada passaria no teste.
 */
let boletoDoServidor = null;
pagina.on('response', async (resposta) => {
  if (!resposta.url().includes('/api/orders') || resposta.request().method() !== 'POST') return;
  try {
    const corpo = await resposta.json();
    if (corpo?.data?.boleto) boletoDoServidor = corpo.data.boleto;
  } catch {
    /* resposta de erro: o teste falha adiante, com mensagem melhor */
  }
});

console.log(`\nEscolha de pagamento e tela do boleto em ${BASE}\n`);

await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(1200);

await pagina.getByRole('button', { name: 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA' }).click();
await pagina.waitForTimeout(900);

/* -------------------------------------------------------------------------- */
/* 1. A escolha existe, e o PIX vem marcado                                    */
/* -------------------------------------------------------------------------- */

const seletor = await pagina.evaluate(() => {
  const grupo = document.querySelector('[role="radiogroup"]');
  if (!grupo) return null;
  const opcoes = [...grupo.querySelectorAll('[role="radio"]')].map((el) => ({
    texto: el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    marcada: el.getAttribute('aria-checked') === 'true',
    altura: Math.round(el.getBoundingClientRect().height),
  }));
  return { total: opcoes.length, opcoes };
});

checar(seletor !== null, 'o grupo de formas de pagamento existe na tela');
if (!seletor) {
  console.log('\nSem seletor nao ha o que medir. O servidor esta com BOLETO_PROVIDER=mock?\n');
  await navegador.close();
  process.exit(1);
}

checar(seletor.total === 2, 'sao duas opcoes (PIX e boleto)', `achei ${seletor.total}`);
checar(seletor.opcoes[0]?.marcada === true, 'o PIX vem marcado por padrao');
checar(seletor.opcoes[1]?.marcada === false, 'o boleto NAO vem marcado');
checar(
  /PIX/i.test(seletor.opcoes[0]?.texto ?? '') && /IMEDIATA/i.test(seletor.opcoes[0]?.texto ?? ''),
  'a opcao PIX diz que a liberacao e imediata',
);
/*
 * O prazo tem de estar no rótulo, não escondido na tela seguinte: é a única
 * informação que muda a decisão, e ela precisa estar à vista NA HORA de decidir.
 */
checar(
  /3 DIAS|DIAS ÚTEIS|DIAS UTEIS/i.test(seletor.opcoes[1]?.texto ?? ''),
  'a opcao boleto avisa do prazo no proprio rotulo',
  seletor.opcoes[1]?.texto?.slice(0, 90),
);
// Alvo de toque para dedo de pessoa mais velha, que é o público desta página.
checar(
  (seletor.opcoes[1]?.altura ?? 0) >= 44,
  'a opcao boleto tem alvo de toque de 44px ou mais',
  `${seletor.opcoes[1]?.altura}px`,
);

/* -------------------------------------------------------------------------- */
/* 2. Escolher boleto muda o que o botao PROMETE                               */
/* -------------------------------------------------------------------------- */

await pagina.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
await pagina.getByPlaceholder('Seu melhor e-mail (onde chega o acesso)').fill('maria@exemplo.com');
await pagina.getByPlaceholder('CPF de quem vai pagar (000.000.000-00)').fill('52998224725');

const rotuloComPix = (await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).textContent()) ?? '';
checar(/PIX/i.test(rotuloComPix), 'com PIX escolhido, o botao fala de PIX', rotuloComPix.trim());

await pagina.getByRole('radio', { name: /Boleto/ }).click();
await pagina.waitForTimeout(400);

const rotuloComBoleto = (await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).textContent()) ?? '';
checar(
  /BOLETO/i.test(rotuloComBoleto) && !/PIX/i.test(rotuloComBoleto),
  'com boleto escolhido, o botao fala de boleto e nao de PIX',
  rotuloComBoleto.trim(),
);

const rolagemAntes = await pagina.evaluate(() => window.scrollY);

await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).click();
await pagina.waitForTimeout(3500);

/* -------------------------------------------------------------------------- */
/* 3. O boleto nasceu, e a tela mostra o do servidor                           */
/* -------------------------------------------------------------------------- */

checar(Boolean(boletoDoServidor), 'o servidor emitiu o boleto');
if (!boletoDoServidor) {
  console.log('\nSem boleto emitido nao ha o que medir.\n');
  await navegador.close();
  process.exit(1);
}

checar(
  boletoDoServidor.linhaDigitavelCrua?.length === 47,
  'a linha digitavel tem 47 digitos',
  `${boletoDoServidor.linhaDigitavelCrua?.length}`,
);

const naTela = await pagina.evaluate(() => {
  const topoDe = (el) => (el ? el.getBoundingClientRect().top + window.scrollY : null);
  const acharTexto = (texto) =>
    [...document.querySelectorAll('p, span, h1, h2, h3, h4, li, strong')].find((el) =>
      el.textContent?.replace(/\s+/g, ' ').includes(texto),
    );

  const area = document.getElementById('area-de-pagamento-boleto');
  const linha = document.querySelector('[aria-label="Linha digitável do boleto"]');
  const botao = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copiar código do boleto'));

  return {
    temArea: Boolean(area),
    linhaVisivel: linha?.textContent?.trim() ?? null,
    // Os dígitos como estão na tela, sem a formatação, para comparar com o servidor.
    digitosNaTela: (linha?.textContent ?? '').replace(/\D/g, ''),
    topoDoAviso: topoDe(acharTexto('O acesso é liberado depois que o banco confirmar')),
    topoDaLinha: topoDe(linha),
    topoDoBotao: topoDe(botao),
    alturaDoBotao: botao ? Math.round(botao.getBoundingClientRect().height) : 0,
    temVencimento: Boolean(acharTexto('Vence ')),
    temNumeroDoPedido: Boolean(acharTexto('Número do pedido')),
    temPrazoEscrito: Boolean(acharTexto('1 a 3 dias úteis')),
    temSaidaParaPix: [...document.querySelectorAll('button')].some((el) => /pagar com PIX/i.test(el.textContent ?? '')),
    /*
     * A promessa é medida DENTRO do painel do boleto, não no documento.
     *
     * A página acima é o funil inteiro — VSL, oferta e depoimentos — e ela
     * promete acesso imediato com razão, porque o caminho normal é o PIX. Ler o
     * body todo acusava a tela do boleto por causa de um depoimento que diz
     * "recebi imediatamente", que é texto de outra pessoa sobre outra coisa.
     *
     * A frase que oferece o PIX ("quer receber agora, na hora? volte e escolha
     * PIX") é retirada antes de medir: ela é o oposto de uma promessa de
     * imediatismo do boleto — é o convite para trocar de método justamente
     * porque o boleto não é imediato.
     */
    prometeImediato: (() => {
      const painel = document.getElementById('painel-do-boleto');
      if (!painel) return false;
      const texto = (painel.innerText ?? '').replace(/Quer receber agora, na hora\?[^]*?escolha PIX\./i, '');
      return /liberado imediatamente|liberação imediata|na hora/i.test(texto);
    })(),
    /*
     * Enquadramento, e não direção da rolagem.
     *
     * O teste antigo exigia scrollY maior depois do clique, e falhava por um
     * motivo que é acerto do produto: o formulário sai da tela e o painel é mais
     * curto, então a página encurta e o destino passa a ficar ACIMA de onde a
     * pessoa estava. O que importa é o alvo ter ficado à vista, para qualquer
     * lado que a tela tenha andado.
     */
    topoDaAreaNaJanela: area ? Math.round(area.getBoundingClientRect().top) : null,
    alturaDaJanela: window.innerHeight,
  };
});

checar(naTela.temArea, 'a area do boleto existe (ancora da rolagem)');
checar(
  naTela.digitosNaTela === boletoDoServidor.linhaDigitavelCrua,
  'a linha na tela e exatamente a que o servidor emitiu',
  `tela=${naTela.digitosNaTela?.slice(0, 20)}... servidor=${boletoDoServidor.linhaDigitavelCrua?.slice(0, 20)}...`,
);
checar(
  (naTela.linhaVisivel ?? '').includes('.') && (naTela.linhaVisivel ?? '').includes(' '),
  'a linha aparece agrupada, para conferir em pedacos',
  naTela.linhaVisivel ?? '',
);

/* -------------------------------------------------------------------------- */
/* 4. A ordem: o aviso do prazo vem ANTES do codigo                            */
/* -------------------------------------------------------------------------- */

/*
 * Esta é a checagem mais importante da bateria. Depois do botão verde ninguém lê
 * mais nada: se o aviso do prazo estiver embaixo, ele não existe na prática, e a
 * pessoa vai descobrir que esperou por três dias quando cobrar o acesso.
 */
checar(naTela.topoDoAviso !== null, 'o aviso do prazo existe na tela');
checar(
  naTela.topoDoAviso !== null && naTela.topoDaLinha !== null && naTela.topoDoAviso < naTela.topoDaLinha,
  'o aviso do prazo vem ANTES da linha digitavel',
  `aviso=${naTela.topoDoAviso} linha=${naTela.topoDaLinha}`,
);
checar(naTela.temPrazoEscrito, 'o prazo esta escrito como "1 a 3 dias uteis"');
checar(!naTela.prometeImediato, 'a tela do boleto NAO promete liberacao imediata em nenhum lugar');

/* -------------------------------------------------------------------------- */
/* 5. O que se leva embora, e a saida                                          */
/* -------------------------------------------------------------------------- */

checar(naTela.temVencimento, 'a data de vencimento esta na tela');
checar(naTela.temNumeroDoPedido, 'o numero do pedido esta na tela');
checar(naTela.temSaidaParaPix, 'existe a saida para trocar por PIX');
checar(naTela.alturaDoBotao >= 44, 'o botao de copiar tem alvo de toque confortavel', `${naTela.alturaDoBotao}px`);

/* -------------------------------------------------------------------------- */
/* 6. A rolagem levou a pessoa ate o pagamento                                 */
/* -------------------------------------------------------------------------- */

const rolagemDepois = await pagina.evaluate(() => window.scrollY);
checar(rolagemDepois !== rolagemAntes, 'a tela se moveu sozinha depois de emitir', `ficou em ${rolagemAntes}`);
/*
 * O alvo tem de estar no alto da tela: é ali que ficam a linha digitável e o
 * botão de copiar, que é a ação inteira desta tela. Aceito de -8 (encostado no
 * topo) a 200 px, que ainda deixa o cartão do código na primeira dobra de um
 * aparelho de 844 px.
 */
checar(
  naTela.topoDaAreaNaJanela !== null && naTela.topoDaAreaNaJanela >= -8 && naTela.topoDaAreaNaJanela <= 200,
  'a area de pagamento ficou enquadrada na primeira dobra',
  `topo em ${naTela.topoDaAreaNaJanela}px de uma janela de ${naTela.alturaDaJanela}px`,
);

/* -------------------------------------------------------------------------- */
/* 7. O botao copia DE VERDADE, e copia os digitos crus                        */
/* -------------------------------------------------------------------------- */

await pagina.getByRole('button', { name: 'Copiar código do boleto' }).click();

/*
 * A CONFIRMAÇÃO É MEDIDA PRIMEIRO, e não depois de conferir a área de
 * transferência.
 *
 * Ela some sozinha da tela quatro segundos após o clique — de propósito, para
 * não ficar um aviso velho pendurado. Conferindo o clipboard antes, a leitura
 * consumia parte desse tempo e a checagem às vezes chegava depois do sumiço:
 * falhava numa rodada e passava na outra, para um botão que sempre funcionou.
 */
const confirmacao = await pagina
  .getByText('Código copiado!')
  .first()
  .waitFor({ timeout: 4000 })
  .then(() => true, () => false);
checar(confirmacao, 'a tela confirma que copiou');

const copiado = await pagina.evaluate(() => navigator.clipboard.readText());
checar(
  copiado.replace(/\D/g, '') === boletoDoServidor.linhaDigitavelCrua,
  'o botao copia a linha digitavel do servidor',
  `copiou "${copiado.slice(0, 24)}..."`,
);
/*
 * Crus, sem pontos: é a forma que o campo do banco aceita colada. Colar a
 * versão bonitinha faz parte dos aplicativos recusar o valor.
 */
checar(!/[.\s]/.test(copiado), 'o que foi copiado nao tem pontos nem espacos', `copiou "${copiado.slice(0, 24)}..."`);


/* -------------------------------------------------------------------------- */
/* 8. Nada de erro de console                                                  */
/* -------------------------------------------------------------------------- */

checar(errosDeConsole.length === 0, 'nenhum erro de console', errosDeConsole.join(' | '));

const destino = process.env.SCREENSHOT_DIR ?? '.';
await pagina.screenshot({ path: path.join(destino, 'tela-boleto.png'), fullPage: true });
console.log(`\n  captura em ${path.join(destino, 'tela-boleto.png')}`);

await navegador.close();
console.log(`\n${tudoOk ? 'TUDO OK' : 'HOUVE FALHA'}\n`);
process.exit(tudoOk ? 0 : 1);
