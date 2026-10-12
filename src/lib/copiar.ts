/**
 * Cópia para a área de transferência, com rede de segurança.
 *
 * Vive num arquivo próprio porque agora há DOIS lugares onde copiar é o passo
 * que fecha a venda — o código do PIX e a linha digitável do boleto — e uma
 * segunda implementação dessas seria uma segunda chance de errar no mesmo
 * ponto.
 *
 * `navigator.clipboard` não existe fora de HTTPS e é recusado por parte dos
 * navegadores embutidos (o do Instagram e o do Facebook, que é por onde este
 * público chega vindo do anúncio). O caminho antigo — `execCommand` sobre uma
 * seleção — ainda funciona nesses casos, então ele entra como segunda tentativa
 * em vez de a pessoa ficar com um botão que não faz nada.
 *
 * Quando as duas falham, devolve `false` — e quem chamou TEM de dizer isso na
 * tela. Silenciar o erro era o pior desfecho: o código continuava à vista, mas
 * quem apertou o botão ia para o app do banco achando que tinha copiado, e
 * voltava sem entender.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    // Permissão negada ou contexto inseguro: cai no caminho de baixo.
  }

  try {
    const campo = document.createElement('textarea');
    campo.value = texto;
    // Fora da vista, mas dentro do documento: elemento com `display:none` não
    // pode ser selecionado, e sem seleção não há o que copiar.
    campo.setAttribute('readonly', '');
    campo.style.position = 'fixed';
    campo.style.top = '-1000px';
    campo.style.opacity = '0';
    document.body.appendChild(campo);
    campo.select();
    campo.setSelectionRange(0, texto.length);
    const deuCerto = document.execCommand('copy');
    document.body.removeChild(campo);
    return deuCerto;
  } catch {
    return false;
  }
}
