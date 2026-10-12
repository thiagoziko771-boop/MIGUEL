import React, { useState, useEffect } from 'react';
import { Shield, CheckCircle2, Circle } from 'lucide-react';
import { LOADING_DATA } from '../data/funnelData';
import { lerCadastroRapido, primeiroNome } from '../lib/cadastroRapido';

interface LoadingScreenProps {
  onComplete: () => void;
}

/*
 * As quatro verificações da tela, cada uma com o ponto de progresso em que
 * acende. Vivem aqui, e não em funnelData, porque o ponto de acendimento é
 * parte do desenho da tela, não copy: mudar "concluiEm" sem olhar a tela
 * desalinha a lista com a barra invisível de progresso.
 *
 * São as frases longas que rodavam antes, encurtadas para rótulo de lista.
 * "Avaliando a sinceridade das suas respostas..." quebra em duas linhas na
 * coluna estreita e desalinha a coluna de ícones.
 */
const VERIFICACOES = [
  { rotulo: 'Avaliando sinceridade', concluiEm: 25 },
  { rotulo: 'Verificando pureza', concluiEm: 50 },
  { rotulo: 'Sintonizando momento', concluiEm: 75 },
  { rotulo: 'Confirmando merecimento', concluiEm: 96 },
];

/*
 * Tudo que ocupa altura é medido em vh, com piso e teto.
 *
 * A tela precisa caber inteira em QUALQUER celular, sem rolagem: ela dura ~5 s e
 * some sozinha, e um pedaço escondido abaixo da dobra é um pedaço que ninguém
 * vai rolar para ver. Com tamanhos fixos, o astrolábio de 256px mais os vãos de
 * 48px estouravam a tela em aparelho de 640px de altura — justamente os mais
 * baratos, que é boa parte deste público.
 *
 * O teto de cada clamp é o tamanho do layout original; em tela grande nada muda.
 */
const VAO = 'clamp(0.75rem, 4vh, 3rem)';
const DIAMETRO_DO_ANEL = 'clamp(9.5rem, 29vh, 16rem)';

/**
 * Tela 12 — a espera entre o quiz e a VSL, no tema "Sacred Shield".
 *
 * O relógio interno não mudou: 2 pontos a cada 90 ms até 100, com uma respirada
 * em 38% e 72%, e mais 900 ms parada no fim antes de chamar `onComplete`. São
 * ~5,4 s de tela. Esse tempo é o que dá peso ao veredito — cortar transforma a
 * "análise" numa transição, e ninguém acredita numa análise instantânea.
 *
 * O progresso não aparece como número nem como barra: quem conta a história é a
 * lista de verificações acendendo uma a uma.
 */
export const LoadingScreen: React.FC<LoadingScreenProps> = ({ onComplete }) => {
  const [progress, setProgress] = useState(0);

  /*
   * Quem veio do fluxo curto deixou o nome — e a análise que fala com a
   * pessoa ("o merecimento de Maria") é o ponto da tela nesse fluxo. Lido do
   * armazenamento, e não por prop: a tela é a mesma nos dois fluxos, e no
   * quiz completo simplesmente não há nome — o título padrão continua.
   */
  const [titulo] = useState(() => {
    const nome = primeiroNome(lerCadastroRapido()?.nome ?? '');
    return nome === '' ? LOADING_DATA.title : `Analisando o Merecimento de ${nome}...`;
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            onComplete();
          }, 900);
          return 100;
        }

        // Slightly pause around 38% and 72% for realistic verification feel
        if (prev === 38 || prev === 72) {
          return prev + 1;
        }

        return prev + 2;
      });
    }, 90);

    return () => clearInterval(interval);
  }, [onComplete]);

  // A primeira ainda não concluída é a que pulsa; as depois dela ficam apagadas.
  const indiceAtual = VERIFICACOES.findIndex((v) => progress < v.concluiEm);

  return (
    <div className="relative w-full h-[100svh] overflow-hidden flex flex-col items-center justify-center fundo-mistico px-6">
      {/* Céu: poeira de estrelas + degradê que assenta o texto no rodapé */}
      <div className="absolute inset-0 z-0 poeira-estelar" />
      <div className="absolute inset-0 z-0 bg-gradient-to-b from-transparent via-[#131313]/20 to-[#131313]/95" />

      <div
        className="relative z-10 w-full max-w-md flex flex-col items-center text-center"
        style={{ gap: VAO }}
      >
        {/* Cabeçalho */}
        <div className="entrar-rolando">
          <h2
            className="font-caslon font-bold text-[clamp(1.25rem,3.4vh,1.5rem)] leading-tight text-[#f2ca50] mb-2"
            style={{ filter: 'drop-shadow(0 0 15px rgba(233,195,73,0.3))' }}
          >
            Processamento Espiritual
          </h2>
          <p className="font-work text-[clamp(0.9375rem,2.2vh,1rem)] leading-snug text-[#d0c5af] max-w-[300px] mx-auto">
            {LOADING_DATA.subtitle}
          </p>
        </div>

        <h3
          className="font-caslon font-bold text-[clamp(1.375rem,4.2vh,1.75rem)] leading-tight text-[#f2ca50] entrar-rolando"
          style={{ animationDelay: '120ms', filter: 'drop-shadow(0 0 20px rgba(233,195,73,0.5))' }}
        >
          {titulo}
        </h3>

        {/* Astrolábio: anéis girando em torno do escudo */}
        <div
          className="relative flex items-center justify-center shrink-0 entrar-rolando"
          style={{ width: DIAMETRO_DO_ANEL, height: DIAMETRO_DO_ANEL, animationDelay: '240ms' }}
          aria-hidden="true"
        >
          <div className="absolute inset-0 rounded-full border border-[#f2ca50]/20 halo-pulsante" />
          <div className="absolute inset-[6%] rounded-full border border-[#f2ca50]/40 halo-pulsante girar-lento" />
          <div
            className="absolute inset-[12%] rounded-full border-2 border-dashed border-[#f2ca50]/60 girar-lento"
            style={{ animationDirection: 'reverse', animationDuration: '15s' }}
          />
          <div
            className="absolute inset-0 rounded-full border-t-2 border-r-2 border-[#f2ca50] girar-lento"
            style={{ borderRadius: '50% 50% 50% 50% / 40% 60% 40% 60%' }}
          />
          <div
            className="absolute inset-0 rounded-full border-b-2 border-l-2 border-[#f2ca50] girar-lento"
            style={{ borderRadius: '40% 60% 40% 60% / 50% 50% 50% 50%', animationDirection: 'reverse' }}
          />
          <Shield
            className="text-[#f2ca50] w-[25%] h-[25%]"
            strokeWidth={1.5}
            style={{ filter: 'drop-shadow(0 0 20px rgba(242,202,80,0.8))' }}
          />
        </div>

        {/*
          320px, não 280: "Confirmando merecimento" quebra em duas linhas nos
          280px do layout original e desalinha a coluna de ícones. Cada
          verificação precisa caber numa linha só.
        */}
        <ul
          className="w-full max-w-[320px] flex flex-col text-left"
          style={{ gap: 'clamp(0.5rem, 1.9vh, 1rem)' }}
          aria-live="polite"
        >
          {VERIFICACOES.map((verificacao, indice) => {
            const concluida = progress >= verificacao.concluiEm;
            const emAndamento = indice === indiceAtual;

            return (
              <li
                key={verificacao.rotulo}
                className={`flex items-center gap-4 entrar-rolando ${concluida || emAndamento ? '' : 'opacity-50'}`}
                style={{ animationDelay: `${360 + indice * 100}ms` }}
              >
                {concluida ? (
                  <CheckCircle2
                    className="w-[clamp(1.25rem,3vh,1.5rem)] h-[clamp(1.25rem,3vh,1.5rem)] shrink-0 text-[#f2ca50]"
                    strokeWidth={1.75}
                    style={{ filter: 'drop-shadow(0 0 10px rgba(242,202,80,0.5))' }}
                  />
                ) : (
                  <Circle
                    className={`w-[clamp(1.25rem,3vh,1.5rem)] h-[clamp(1.25rem,3vh,1.5rem)] shrink-0 ${
                      emAndamento ? 'text-[#f2ca50]/40 animate-pulse' : 'text-[#d0c5af]'
                    }`}
                    strokeWidth={1.75}
                  />
                )}
                <span
                  className={`font-work text-[clamp(1rem,2.5vh,1.1875rem)] leading-snug ${
                    concluida ? 'text-[#e5e2e1]' : 'text-[#d0c5af]'
                  }`}
                >
                  {verificacao.rotulo}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
