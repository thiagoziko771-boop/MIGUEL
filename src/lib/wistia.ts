/**
 * Carrega os scripts da Wistia sob demanda, em vez de na abertura do site.
 *
 * Eram quatro tags no <head> do index.html — o runtime do player (49 kB) e um
 * arquivo por vídeo — e as quatro baixavam na TELA 0, antes da primeira
 * pergunta. Só que o primeiro vídeo aparece na tela 11 e a VSL na 13: quem
 * abandona no quiz baixava 60 kB e abria quatro conexões com um domínio de
 * terceiro sem nunca ver um vídeo.
 *
 * Este público chega por celular em rede de operadora. O que se ganha não é o
 * número no relatório: é a primeira tela pintando antes de a pessoa desistir.
 *
 * O adiamento é seguro porque o index.html já estiliza `wistia-player:not(:defined)`
 * com o quadro borrado do próprio vídeo — enquanto o script não chega, o lugar
 * do vídeo já está lá, com a imagem certa, em vez de um buraco branco.
 */

/** Os três vídeos do funil: a VSL da oferta e os dois depoimentos. */
const MIDIAS = [
  'a78m863q0a', // VSL da tela 13
  'sc2zwew6dx', // depoimento — Maria Helena
  '31rfb4n9yd', // depoimento — Dona Neide
];

let jaPedido = false;

function injetar(src: string, comoModulo: boolean): void {
  // Recarregar o mesmo script faria o player registrar o custom element duas
  // vezes, e o navegador reclama em voz alta no console.
  if (document.querySelector(`script[src="${src}"]`)) return;

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  if (comoModulo) script.type = 'module';
  document.head.appendChild(script);
}

/**
 * Começa a baixar os players. Chamar várias vezes não repete o trabalho.
 *
 * Quem chama é a troca de tela do funil, assim que a pessoa sai do hero: da
 * primeira pergunta até o primeiro vídeo há seis perguntas e 52 segundos de
 * áudio, folga de sobra para 60 kB chegarem sem ninguém esperar por eles.
 */
export function carregarWistia(): void {
  if (jaPedido || typeof document === 'undefined') return;
  jaPedido = true;

  injetar('https://fast.wistia.com/player.js', false);
  for (const midia of MIDIAS) {
    injetar(`https://fast.wistia.com/embed/${midia}.js`, true);
  }
}
