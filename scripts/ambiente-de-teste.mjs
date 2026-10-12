/**
 * O funil inteiro rodando na sua máquina, sem tocar em NADA de verdade.
 *
 *   npm run teste
 *
 * Sobe o backend e o site já configurados para teste e imprime o endereço. Para
 * encerrar, Ctrl+C — ele derruba os dois processos.
 *
 * O QUE ESTE AMBIENTE GARANTE, e é por isso que ele existe:
 *
 * 1. NENHUM PIX REAL. `PIX_MODE=mock` faz as cobranças serem simuladas e se
 *    confirmarem sozinhas depois de alguns segundos. O código gerado começa com
 *    "MOCK-NAO-PAGUE" — nenhum aplicativo de banco aceita.
 * 2. NENHUM DADO DE CLIENTE DE VERDADE. Os pedidos vão para `.data-teste/`, uma
 *    pasta só deste ambiente. O banco de produção (Neon) não é tocado, porque
 *    DATABASE_URL é apagada da configuração antes de o servidor subir.
 * 3. NENHUM EVENTO NO META E NENHUM E-MAIL. As credenciais são apagadas junto:
 *    um teste que dispara Purchase envenena a otimização do anúncio de verdade,
 *    e um teste que manda e-mail chega na caixa de alguém.
 * 4. NENHUMA MENSAGEM DE WHATSAPP PARA NÚMERO REAL. O número de atendimento
 *    entra como 5500000000000, que não existe. A tela funciona inteira, e a
 *    conversa que abrir não vai para ninguém.
 *
 * O ambiente lê o seu .env.local para o que NÃO é sensível (o Pixel do
 * navegador, por exemplo, que só muda o que aparece na tela), e sobrescreve o
 * que pode causar estrago. Nada é escrito no seu .env.local.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORTA_BACKEND = process.env.PORTA_BACKEND ?? '3334';
const PORTA_SITE = process.env.PORTA_SITE ?? '4300';

/*
 * O que é APAGADO da configuração antes de subir.
 *
 * A lista é de coisas que, se sobrevivessem, alcançariam o mundo real: banco de
 * produção, envio de e-mail, eventos de anúncio e as chaves dos gateways. É
 * mais seguro apagar do que confiar que o modo mock cobre todos os caminhos —
 * um dia alguém acrescenta um caminho novo e esquece do mock.
 */
const APAGAR = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'EMAIL_API_KEY',
  'META_CAPI_TOKEN',
  'META_ADS_TOKEN',
  'PIXGO_API_KEY',
  'PIXGO_WEBHOOK_SECRET',
  'SYNCPAY_CLIENT_ID',
  'SYNCPAY_CLIENT_SECRET',
  'SYNCPAY_WEBHOOK_TOKEN',
  'PUBLIC_BASE_URL',
];

const ambiente = { ...process.env };
for (const chave of APAGAR) delete ambiente[chave];

Object.assign(ambiente, {
  PIX_MODE: 'mock',
  PORT: PORTA_BACKEND,
  DATA_DIR: '.data-teste',
  // Desliga o rastreamento de propósito: ver o item 3 do cabeçalho.
  META_TRACKING_ENABLED: 'false',
  // Número que não existe, para a opção de boleto aparecer e funcionar inteira
  // sem mandar mensagem para ninguém.
  WHATSAPP_SUPORTE: process.env.WHATSAPP_SUPORTE ?? '5500000000000',
  // Confirma o PIX simulado em 12s e o boleto simulado em 25s — tempo de ver a
  // tela de espera trabalhar antes de virar a de acesso.
  MOCK_CONFIRM_DELAY_MS: process.env.MOCK_CONFIRM_DELAY_MS ?? '12000',
  MOCK_BOLETO_CONFIRM_DELAY_MS: process.env.MOCK_BOLETO_CONFIRM_DELAY_MS ?? '25000',
  /*
   * O limite de pedidos por janela existe para PRODUÇÃO, onde 12 tentativas em
   * dez minutos vindas do mesmo lugar são sinal de abuso. Numa bateria
   * automatizada isso é o normal: cada rodada cria pedidos, e a partir do
   * décimo terceiro o servidor passa a responder "muitas tentativas" — o teste
   * quebra no meio e acusa defeito de tela onde havia só o porteiro fazendo o
   * trabalho dele.
   */
  RATE_LIMIT_MAX_ORDERS: process.env.RATE_LIMIT_MAX_ORDERS ?? '500',
  // Senha conhecida para o painel deste ambiente. Não é a de produção, e o
  // painel daqui só enxerga os pedidos de teste.
  ADMIN_SENHA: 'painel-local-2026',
  PAINEL_CHAVE_MESTRA: 'chave-de-teste-local-nao-serve-em-producao-0000000000000000',
});

const filhos = [];

function subir(rotulo, comando, argumentos, extra = {}) {
  const filho = spawn(comando, argumentos, {
    env: { ...ambiente, ...extra },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const escrever = (dados) => {
    for (const linha of String(dados).split('\n')) {
      if (linha.trim()) console.log(`[${rotulo}] ${linha}`);
    }
  };
  filho.stdout.on('data', escrever);
  filho.stderr.on('data', escrever);
  filho.on('exit', (codigo) => {
    console.log(`[${rotulo}] encerrou (${codigo})`);
    encerrar();
  });
  filhos.push(filho);
  return filho;
}

let encerrando = false;
function encerrar() {
  if (encerrando) return;
  encerrando = true;
  for (const filho of filhos) {
    try { filho.kill(); } catch { /* já morreu */ }
  }
  process.exit(0);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

console.log(`
==============================================================
 AMBIENTE DE TESTE — nada aqui é real
==============================================================
 PIX .............. simulado, confirma sozinho
 Boleto ........... abre WhatsApp de número inexistente
 Pedidos .......... .data-teste/ (não é o banco de produção)
 E-mail e Meta .... desligados
==============================================================
`);

subir('site', 'npx', ['vite', `--port=${PORTA_SITE}`, '--strictPort']);
subir('backend', 'npx', ['tsx', 'server/index.ts']);

setTimeout(() => {
  console.log(`
--------------------------------------------------------------
 Funil ....... http://localhost:${PORTA_SITE}
 Painel ...... http://localhost:${PORTA_SITE}/admin   (senha: painel-local-2026)
 Obrigado .... http://localhost:${PORTA_SITE}/obg
 Saúde ....... http://localhost:${PORTA_SITE}/api/health   (confira "mode":"mock")

 Para encerrar: Ctrl+C
--------------------------------------------------------------
`);
}, 3500);
