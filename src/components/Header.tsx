import React from 'react';

interface HeaderProps {
  progressPercent?: number;
  showProgress?: boolean;
}

/**
 * Barra do topo do funil: só o progresso do quiz.
 *
 * Teve um botão de som, removido em 08/08/2026 porque não silenciava nada — o
 * estado alternava o próprio ícone e mais nada, enquanto o vídeo da Wistia e o
 * áudio da etapa 7 têm cada um os seus controles.
 *
 * Teve também um selo "Etapa 1/10", removido em 10/08/2026 a pedido do dono. Ele
 * gastava uma faixa inteira no alto do celular para dizer o que a barra logo
 * abaixo já mostra — e ainda anunciava o tamanho da fila: ler "1/10" na primeira
 * pergunta é descobrir que faltam nove.
 *
 * A barra inteira some quando não há progresso a mostrar. Na tela da oferta ela
 * ficava vazia, empurrando o vídeo para baixo sem informar nada — espaço no alto
 * do celular é caro demais para um retângulo em branco.
 */
export const Header: React.FC<HeaderProps> = ({
  progressPercent = 0,
  showProgress = true,
}) => {
  if (!showProgress || progressPercent <= 0) return null;

  return (
    <header className="w-full bg-fundo/95 backdrop-blur-md border-b border-borda sticky top-0 z-30 transition-all">
      {/* Progress Bar Component - Clean Minimalism 4px bar */}
      <div className="w-full bg-borda h-1 relative overflow-hidden">
        <div
          className="h-full bg-ouro transition-all duration-500 ease-out rounded-r-full"
          style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
        />
      </div>
    </header>
  );
};
