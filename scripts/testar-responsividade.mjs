/**
 * Audita a responsividade do funil em telas de verdade.
 *
 * Mede três defeitos que só aparecem no aparelho e passam despercebidos no
 * computador do desenvolvedor:
 *
 *   1. ESTOURO HORIZONTAL — a página fica mais larga que a tela e o dedo
 *      arrasta o conteúdo para o lado. É o defeito que mais destrói confiança
 *      num checkout: parece site quebrado bem na hora de pagar.
 *   2. ALVO DE TOQUE PEQUENO — botão ou link com menos de 44x44 px. Abaixo
 *      disso o dedo erra, e cada erro é uma chance de desistir.
 *   3. TEXTO MIÚDO — fonte abaixo de 12 px em texto corrido, ilegível em
 *      celular. Em campo de formulário, fonte menor que 16 px faz o iOS dar
 *      zoom sozinho ao focar, o que desloca a tela inteira.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-responsividade.mjs http://localhost:4300
 *
 * A etapa "pix" gera uma cobrança por tela medida — seis no total. Peça ao
 * servidor de teste PIX_MODE=mock e RATE_LIMIT_MAX_ORDERS alto (500): no padrão
 * de 12 pedidos por 10 minutos, rodar esta bateria duas vezes seguidas esbarra
 * no freio, o PIX não é criado e a medição acusa "NAO RENDERIZOU" — que parece
 * tela quebrada e é só o limite fazendo o trabalho dele.
 *
 * E PEÇA TAMBÉM `MOCK_CONFIRM_DELAY_MS` ALTO. No padrão, a cobrança simulada se
 * confirma sozinha doze segundos depois de criada: a partir da quarta tela a
 * bateria já está lenta o bastante para o pedido virar "pago" antes da medição,
 * a tela troca o código PIX pela confirmação, e o relatório acusa três telas
 * quebradas que estão perfeitas. Aconteceu na primeira vez que esta bateria
 * rodou, e custou meia hora de caça a um defeito que não existia:
 *
 *   PIX_MODE=mock MOCK_CONFIRM_DELAY_MS=600000 RATE_LIMIT_MAX_ORDERS=500 \
 *     PORT=3387 SERVE_STATIC=true npx tsx server/index.ts
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

/** Aparelhos reais, do menor em uso ao desktop. */
const TELAS = [
  { nome: 'iPhone SE (menor em uso)', largura: 320, altura: 568, toque: true },
  { nome: 'Android comum', largura: 360, altura: 740, toque: true },
  { nome: 'iPhone 14', largura: 390, altura: 844, toque: true },
  { nome: 'iPhone Pro Max', largura: 430, altura: 932, toque: true },
  { nome: 'Tablet', largura: 768, altura: 1024, toque: true },
  { nome: 'Notebook', largura: 1280, altura: 800, toque: false },
];

/**
 * Etapas que importam: entrada, quiz, prova social e a tela que vende.
 *
 * `esperado` não é enfeite. Sem ele, uma página que nem renderizou passa em
 * todas as medições — sem botão não há alvo pequeno, sem conteúdo não há
 * estouro — e o teste diz "OK" para uma tela em branco. Já aconteceu aqui: um
 * erro de sintaxe quebrou o funil e a bateria inteira deu OK.
 */
const NOME_DO_BOTAO_DE_COMPRA = 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA';

/** Abre o checkout a partir da tela da oferta. */
async function abrirCheckout(pagina) {
  const botao = pagina.getByRole('button', { name: NOME_DO_BOTAO_DE_COMPRA });
  if (await botao.isVisible().catch(() => false)) {
    await botao.click();
    await pagina.waitForTimeout(900);
  }
}

/**
 * Vai até a tela do PIX de verdade: preenche o formulário e gera a cobrança.
 *
 * Exige o servidor em `PIX_MODE=mock` — o CPF é o de teste e nenhum dinheiro
 * se move. Esta etapa existe porque a tela do PIX é a ÚNICA em que o cliente
 * fica parado esperando, com o dedo no botão de copiar: é onde um estouro
 * horizontal ou um alvo pequeno custa a venda que já estava fechada. Ela ficava
 * fora da medição justamente por ser a mais difícil de alcançar.
 */
async function gerarPix(pagina) {
  await abrirCheckout(pagina);
  await pagina.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
  await pagina.getByPlaceholder('Seu melhor e-mail (onde chega o acesso)').fill('maria@exemplo.com');
  await pagina.getByPlaceholder('CPF de quem vai pagar (000.000.000-00)').fill('52998224725');
  await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).click();
  await pagina.waitForTimeout(2500);
}

const ETAPAS = [
  { nome: 'hero', caminho: '/?tela=0', esperado: 'Sua mensagem do Arcanjo Miguel está pronta.' },
  { nome: 'quiz', caminho: '/?tela=3', esperado: 'Voltar' },
  { nome: 'depoimentos', caminho: '/?tela=11', esperado: 'Continuar' },
  { nome: 'oferta', caminho: '/?tela=13&cta=0', esperado: NOME_DO_BOTAO_DE_COMPRA },
  { nome: 'checkout', caminho: '/?tela=13&cta=0', preparar: abrirCheckout, esperado: 'Não deixe essa decisão' },
  { nome: 'pix', caminho: '/?tela=13&cta=0', preparar: gerarPix, esperado: 'Pix Copia e Cola' },
  { nome: 'obrigado', caminho: '/obg', esperado: 'Pagamento confirmado' },
];

const problemas = [];

const navegador = await chromium.launch();

console.log(`\nResponsividade em ${BASE}\n`);

for (const tela of TELAS) {
  const contexto = await navegador.newContext({
    viewport: { width: tela.largura, height: tela.altura },
    hasTouch: tela.toque,
    isMobile: tela.toque,
    deviceScaleFactor: tela.toque ? 3 : 1,
  });

  const achadosDaTela = [];

  for (const etapa of ETAPAS) {
    const pagina = await contexto.newPage();
    try {
      await pagina.goto(BASE + etapa.caminho, { waitUntil: 'domcontentloaded' });
      await pagina.waitForTimeout(1200);

      if (etapa.preparar) await etapa.preparar(pagina);

      /*
       * A tela renderizou mesmo? Medir uma página em branco devolve "tudo
       * certo" e esconde exatamente o defeito que quebrou o funil.
       */
      const renderizou = await pagina
        .getByText(etapa.esperado, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (!renderizou) {
        achadosDaTela.push(`"${etapa.nome}" NAO RENDERIZOU (nao achei "${etapa.esperado}") — medicao invalida`);
        await pagina.close();
        continue;
      }

      // 1. Estouro horizontal: a página não pode ser mais larga que a tela.
      const estouro = await pagina.evaluate(() => {
        const documento = document.documentElement;
        const excesso = documento.scrollWidth - documento.clientWidth;
        if (excesso <= 1) return null;

        // Quem são os culpados: elementos que passam da borda direita.
        const largura = documento.clientWidth;
        const culpados = [];
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > largura + 1) {
            culpados.push(
              `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''} (passa ${Math.round(r.right - largura)}px)`,
            );
          }
          if (culpados.length >= 4) break;
        }
        return { excesso, culpados };
      });
      if (estouro) {
        achadosDaTela.push(
          `estouro horizontal de ${estouro.excesso}px em "${etapa.nome}" -> ${estouro.culpados.join(' | ') || 'origem nao identificada'}`,
        );
      }

      // 2. Alvos de toque pequenos (só faz sentido em tela de dedo).
      if (tela.toque) {
        const pequenos = await pagina.evaluate(() => {
          const achados = [];
          for (const el of document.querySelectorAll('button, a[href], input[type=checkbox], [role=button]')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const estilo = getComputedStyle(el);
            if (estilo.visibility === 'hidden' || estilo.display === 'none') continue;
            if (r.height < 44 || r.width < 44) {
              const texto = (el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('aria-label') || el.tagName;
              achados.push(`"${texto}" ${Math.round(r.width)}x${Math.round(r.height)}px`);
            }
            if (achados.length >= 5) break;
          }
          return achados;
        });
        if (pequenos.length) {
          achadosDaTela.push(`alvo de toque pequeno em "${etapa.nome}" -> ${pequenos.join(' | ')}`);
        }

        // 3. Campo de formulário com fonte < 16px faz o iOS dar zoom sozinho.
        const camposMiudos = await pagina.evaluate(() => {
          const achados = [];
          for (const el of document.querySelectorAll('input, select, textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            const tamanho = Number.parseFloat(getComputedStyle(el).fontSize);
            if (tamanho < 16) {
              achados.push(`${el.getAttribute('placeholder') || el.type || 'campo'} (${tamanho}px)`);
            }
          }
          return achados;
        });
        if (camposMiudos.length) {
          achadosDaTela.push(`campo com fonte < 16px em "${etapa.nome}" (iOS dá zoom ao focar) -> ${camposMiudos.join(' | ')}`);
        }
      }
    } catch (erro) {
      achadosDaTela.push(`erro ao medir "${etapa.nome}": ${erro.message.split('\n')[0]}`);
    }
    await pagina.close();
  }

  await contexto.close();

  const rotulo = `${tela.nome} (${tela.largura}px)`;
  if (achadosDaTela.length === 0) {
    console.log(`  OK      ${rotulo}`);
  } else {
    console.log(`  ACHADO  ${rotulo}`);
    for (const a of achadosDaTela) console.log(`            - ${a}`);
    problemas.push(...achadosDaTela.map((a) => `${rotulo}: ${a}`));
  }
}

await navegador.close();

console.log(
  problemas.length === 0
    ? '\nNENHUM PROBLEMA DE RESPONSIVIDADE\n'
    : `\n${problemas.length} PROBLEMA(S) DE RESPONSIVIDADE\n`,
);
process.exit(problemas.length === 0 ? 0 : 1);
