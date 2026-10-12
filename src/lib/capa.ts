import type { CapaVariante } from '../data/funnelData';

/**
 * Qual capa esta visita deve ver.
 *
 * A fonte é o `utm_content` que o carimbo dos anúncios põe na URL (é o NOME do
 * anúncio, ver CARIMBO em scripts/gerenciar-anuncios.mjs) — por isso a busca é
 * por pedaço do nome, e não por igualdade: o nome completo carrega sufixos de
 * assinatura que mudam a cada lote. Anúncio novo que fale da mesma dor só
 * precisa manter a palavra no nome para herdar a capa certa.
 *
 * `?capa=dinheiro|madrugada|inveja` vem PRIMEIRO e existe para conferência
 * humana: é como o dono abre cada variante sem forjar um utm inteiro. Não é
 * segredo nem risco — a capa só muda texto.
 *
 * Fora desses dois casos a capa é a padrão, que serve o tráfego direto e os
 * anúncios antigos ("OUÇA AGORA...", que a padrão já espelha).
 */
export function capaAtiva(): CapaVariante {
  const params = new URLSearchParams(window.location.search);

  /*
   * `/pedido` é o endereço próprio do fluxo direto (tela do pedido -> análise
   * -> VSL), criado em 15/08/2026 para os criativos novos. É um caminho, e não
   * um parâmetro, para o anúncio ter uma URL limpa e para NENHUMA campanha
   * antiga (que aponta para `/`) cair nele por acidente.
   */
  if (window.location.pathname.replace(/\/+$/, '') === '/pedido') return 'pedido-direto';

  const pedida = (params.get('capa') ?? '').trim().toLowerCase();
  if (pedida === 'dinheiro' || pedida === 'madrugada' || pedida === 'inveja' || pedida === 'pedido' || pedida === 'pedido-direto') return pedida;

  const anuncio = (params.get('utm_content') ?? '').toUpperCase();
  if (anuncio.includes('DINHEIRO')) return 'dinheiro';
  if (anuncio.includes('MADRUGADA')) return 'madrugada';
  if (anuncio.includes('INVEJA')) return 'inveja';

  return 'padrao';
}
