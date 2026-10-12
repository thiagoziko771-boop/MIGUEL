/**
 * Confere um plano de campanha ANTES de ele virar dinheiro.
 *
 *   node scripts/testar-plano-de-campanha.mjs campanhas/estreia-bm-nova.json
 *
 * O ERRO QUE ISTO PEGA acontece no pior momento: o dono coloca saldo, manda
 * subir, e o comando quebra na terceira peça porque um arquivo mudou de nome —
 * com a campanha já criada, o conjunto já criado e dois anúncios no ar. Desfazer
 * isso à mão, com pressa, é como se cria conta bagunçada.
 *
 * Aqui nada é enviado ao Meta. O que se verifica é tudo que dá para saber sem
 * gastar: o formato do plano, a existência e o peso de cada imagem, o orçamento
 * dentro do teto, a data de início no futuro e — o mais esquecido — se as
 * variáveis da conta estão configuradas.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const CAMINHO = process.argv[2];

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

if (!CAMINHO) {
  console.error('\nInforme o plano: node scripts/testar-plano-de-campanha.mjs campanhas/<arquivo>.json\n');
  process.exit(1);
}

console.log(`\nConferindo ${CAMINHO}\n`);

/* -------------------------------------------------------------------------- */
console.log('== O plano ==\n');

let plano;
try {
  plano = JSON.parse(readFileSync(path.join(RAIZ, CAMINHO), 'utf8'));
  checar(true, 'o arquivo é um JSON válido');
} catch (erro) {
  checar(false, 'o arquivo é um JSON válido', erro.message);
  process.exit(1);
}

checar(typeof plano.campanha === 'string' && plano.campanha.length > 3, `tem nome de campanha (${plano.campanha})`);

const reais = Number(plano.reais);
checar(Number.isFinite(reais) && reais > 0, `tem orçamento (R$ ${reais}/dia)`);
// O mesmo teto do gerenciador: R$ 200/dia. Um zero a mais aqui custa um mês.
checar(reais <= 200, `orçamento dentro do teto de R$ 200/dia (R$ ${reais})`);

const inicio = Date.parse(plano.inicioEm);
checar(Number.isFinite(inicio), `data de início legível (${plano.inicioEm})`);
checar(
  Number.isFinite(inicio) && inicio > Date.now(),
  'a data de início está no futuro',
  Number.isFinite(inicio) ? `${plano.inicioEm} já passou` : '',
);

const idade = Number(plano.idadeMin);
checar(Number.isFinite(idade) && idade >= 18, `idade mínima válida (${idade}+)`);

/* -------------------------------------------------------------------------- */
console.log('\n== As peças ==\n');

const pecas = Array.isArray(plano.pecas) ? plano.pecas : [];
checar(pecas.length > 0, `o plano tem peças (${pecas.length})`);
// O campo já se chamou `anuncios` num rascunho, e o gerenciador ignoraria em
// silêncio: campanha criada, conjunto criado, nenhum anúncio dentro.
checar(!plano.anuncios, 'as peças estão em `pecas`, e não em `anuncios`');

for (const peca of pecas) {
  const rotulo = peca.nome ?? '(sem nome)';
  const arquivo = path.join(RAIZ, peca.arquivo ?? '');

  if (!existsSync(arquivo)) {
    checar(false, `${rotulo}: o arquivo existe`, peca.arquivo);
    continue;
  }

  const kb = Math.round(statSync(arquivo).size / 1024);
  checar(true, `${rotulo}: arquivo presente (${kb} KB)`);
  // Abaixo de 20 KB não é criativo de feed: é miniatura ou placeholder.
  checar(kb >= 20, `${rotulo}: peso de criativo de verdade`, `${kb} KB é pequeno demais`);
  checar(Boolean(peca.titulo), `${rotulo}: tem título`);
  checar(Boolean(peca.mensagem), `${rotulo}: tem texto`);
  // O Meta corta o título no feed por volta de 40 caracteres.
  checar((peca.titulo ?? '').length <= 45, `${rotulo}: título cabe no feed (${(peca.titulo ?? '').length} caracteres)`);
}

/* -------------------------------------------------------------------------- */
console.log('\n== A conta (o que falta configurar) ==\n');

function configurado(nome) {
  if ((process.env[nome] ?? '').trim()) return true;
  try {
    const env = readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
    const linha = env.split(/\r?\n/).find((l) => l.startsWith(`${nome}=`));
    return Boolean((linha ?? '').split('=').slice(1).join('=').trim());
  } catch {
    return false;
  }
}

const exigidas = ['META_CONTA_ID', 'META_ADS_TOKEN', 'META_PIXEL_ID', 'META_PAGINA_ID'];
const faltando = exigidas.filter((n) => !configurado(n));

for (const nome of exigidas) console.log(`  ${configurado(nome) ? 'PRONTO ' : 'FALTA  '} ${nome}`);
if (!configurado('META_INSTAGRAM_ID')) console.log('  (opcional) META_INSTAGRAM_ID — sem ele o anúncio sai só no Facebook');

/* -------------------------------------------------------------------------- */

if (!tudoOk) {
  console.log('\nO PLANO TEM PROBLEMAS. Corrija antes de subir.\n');
  process.exit(1);
}

if (faltando.length) {
  console.log(`\nO plano está correto. Faltam ${faltando.length} credencial(is) para poder subir:`);
  for (const n of faltando) console.log(`   ${n}`);
  console.log('');
  process.exit(0);
}

console.log('\nPLANO PRONTO E CONTA CONFIGURADA. Para subir:');
console.log(`   node scripts/gerenciar-anuncios.mjs subir-lote ${CAMINHO}\n`);
