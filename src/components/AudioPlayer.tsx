import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';
import { AUDIO_INTERMISSION_DATA } from '../data/funnelData';

interface AudioPlayerProps {
  onEnded?: () => void;
  autoPlay?: boolean;
}

/**
 * A mensagem falada da etapa de áudio do funil.
 *
 * Antes daqui não saía gravação nenhuma: o player usava `SpeechSynthesisUtterance`,
 * a voz sintética do navegador lendo um texto. Isso soava robótico onde soava, e
 * em boa parte dos aparelhos não soava — o iOS bloqueia a fala sem gesto direto e
 * muitos Android não trazem voz pt-BR instalada. Ou seja: a etapa que existe para
 * criar intimidade ficava MUDA justamente no celular, que é por onde este público
 * entra.
 *
 * O arquivo é a gravação real, a mesma do site original do funil, extraída de lá.
 * Ele vive em `public/` e não no bundle: são 2 MB, e embutir isso em JavaScript
 * atrasaria o carregamento das telas do quiz, que vêm antes e são a maior parte
 * do caminho.
 */
const ARQUIVO_DO_AUDIO = '/mensagem-arcanjo-miguel.mp3';

export const AudioPlayer: React.FC<AudioPlayerProps> = ({ onEnded }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [falhou, setFalhou] = useState(false);

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      return;
    }

    /*
     * O play precisa nascer do clique, sem `await` antes dele: navegador de
     * celular só libera áudio dentro do gesto do usuário, e qualquer espera no
     * meio faz o pedido perder o vínculo com o toque e ser recusado.
     */
    const tentativa = audio.play();
    if (tentativa) {
      tentativa.catch(() => {
        // Sem autorização ou arquivo indisponível: a etapa segue clicável.
        setFalhou(true);
        setIsPlaying(false);
      });
    }
  };

  /*
   * Quem manda no estado é o elemento, não o nosso relógio.
   *
   * A versão anterior contava o tempo num `setInterval` próprio, e o número na
   * tela descolava do que se ouvia sempre que o áudio demorava a carregar ou o
   * navegador segurava a aba em segundo plano. Ouvindo os eventos do próprio
   * `<audio>`, a barra mostra o que está tocando de verdade.
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const aoTocar = () => setIsPlaying(true);
    const aoPausar = () => setIsPlaying(false);
    const aoAndar = () => setCurrentTime(audio.currentTime);
    const aoCarregar = () => {
      if (Number.isFinite(audio.duration)) setTotalDuration(audio.duration);
    };
    const aoTerminar = () => {
      setIsPlaying(false);
      setCurrentTime(audio.duration || 0);
      onEnded?.();
    };
    const aoFalhar = () => setFalhou(true);

    audio.addEventListener('play', aoTocar);
    audio.addEventListener('pause', aoPausar);
    audio.addEventListener('timeupdate', aoAndar);
    audio.addEventListener('loadedmetadata', aoCarregar);
    audio.addEventListener('ended', aoTerminar);
    audio.addEventListener('error', aoFalhar);

    return () => {
      audio.removeEventListener('play', aoTocar);
      audio.removeEventListener('pause', aoPausar);
      audio.removeEventListener('timeupdate', aoAndar);
      audio.removeEventListener('loadedmetadata', aoCarregar);
      audio.removeEventListener('ended', aoTerminar);
      audio.removeEventListener('error', aoFalhar);
      audio.pause();
    };
  }, [onEnded]);

  return (
    <div className="w-full bg-sutil border border-borda rounded-2xl p-4 sm:p-5 shadow-xs space-y-3">
      {/*
        `preload="metadata"` traz só o cabeçalho, para a duração aparecer certa
        antes do play. Baixar os 2 MB inteiros de saída gastaria o 4G de quem
        talvez nem aperte o botão.
      */}
      <audio ref={audioRef} src={ARQUIVO_DO_AUDIO} preload="metadata" playsInline />

      <div className="flex items-center gap-3.5">
        {/* Play/Pause Button */}
        <button
          onClick={togglePlay}
          className="w-12 h-12 rounded-full bg-acao hover:bg-acao-hover text-sobre-acao flex items-center justify-center shadow-sm transition-all active:scale-95 flex-shrink-0 cursor-pointer"
          aria-label={isPlaying ? 'Pausar áudio' : 'Tocar áudio sagrado'}
        >
          {/* `fill-current` segue a cor do botão: branco sobre o grafite do tema
              claro, quase-preto sobre o ouro do escuro. Preenchido de branco
              fixo, o triângulo sumia dentro do botão dourado. */}
          {isPlaying ? (
            <Pause className="w-5 h-5 fill-current" />
          ) : (
            <Play className="w-5 h-5 fill-current ml-0.5" />
          )}
        </button>

        {/*
          Só a onda, sem título e sem contador.
          A tela é um recado de voz, e recado de voz não vem rotulado: o que a
          pessoa precisa entender é "aperte e ouça". Texto ao redor do player
          disputa atenção com a fala e faz a etapa parecer mais um formulário.
          O progresso continua visível na própria onda.
        */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 h-9 px-1 py-1 overflow-hidden">
            {Array.from({ length: 28 }).map((_, i) => {
              const active = (i / 28) * 100 <= progress;
              const heights = [30, 60, 45, 90, 70, 40, 85, 100, 65, 50, 80, 40, 75, 95, 60, 80, 50, 90, 70, 40, 85, 60, 40, 75, 90, 50, 30, 60];
              const h = heights[i % heights.length];

              return (
                <div
                  key={i}
                  className={`flex-1 rounded-full transition-all duration-300 ${
                    active
                      ? 'bg-ouro'
                      : 'bg-borda'
                  } ${isPlaying ? 'animate-pulse' : ''}`}
                  style={{
                    height: `${h}%`,
                    animationDelay: `${(i % 5) * 150}ms`
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* Speaker Avatar */}
        <div className="w-11 h-11 rounded-full overflow-hidden border border-borda flex-shrink-0 bg-superficie">
          <img
            src={AUDIO_INTERMISSION_DATA.avatarUrl}
            alt={AUDIO_INTERMISSION_DATA.speakerName}
            className="w-full h-full object-cover"
          />
        </div>
      </div>

      {/*
        Nenhum texto abaixo do player — só quando algo dá errado.
        Aí a frase deixa de ser enfeite e vira informação: sem ela, o cliente
        aperta play, não ouve nada e conclui que o site quebrou.
      */}
      {falhou && (
        <p className="text-xs text-center text-suave font-sans flex items-center justify-center gap-1">
          <Volume2 className="w-3.5 h-3.5 text-ouro" />
          Não foi possível tocar o áudio agora. Você pode seguir normalmente.
        </p>
      )}
    </div>
  );
};
