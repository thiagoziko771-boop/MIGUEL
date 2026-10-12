import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { HERO_DATA, HERO_VARIANTES } from '../data/funnelData';
import { capaAtiva } from '../lib/capa';

interface HeroScreenProps {
  onStart: () => void;
}

/**
 * Tela 0 — hero cinematográfico do tema "Sacred Shield".
 *
 * Fica fora do container claro de max-w-md do App de propósito: a arte é de
 * sangria total, e é ela que segura a promessa. Um retrato do Arcanjo dentro de
 * um cartão de 448px com moldura clara não impõe nada; ocupando a tela inteira,
 * com o texto assentado sobre a parte mais escura do degradê, impõe.
 *
 * Não há marca nem nada escrito no alto. A tela tem uma coisa só para a pessoa
 * fazer, e o rosto do Arcanjo é o que precisa chegar primeiro.
 *
 * A altura é 100svh (small viewport height), não 100vh. No Chrome do Android a
 * barra de endereço entra e sai da conta do vh — com 100vh o botão de "Descobrir
 * agora" nasce escondido atrás dela, e o primeiro clique do funil vira rolagem.
 */
export const HeroScreen: React.FC<HeroScreenProps> = ({ onStart }) => {
  /*
   * Os textos acompanham o anúncio que trouxe o clique (ver HERO_VARIANTES).
   * `useState` com inicializador, e não uma chamada a cada render: a URL não
   * muda durante a vida da tela, e a capa não pode trocar de texto na frente
   * da pessoa.
   */
  const [textos] = useState(() => HERO_VARIANTES[capaAtiva()]);

  return (
    <section className="relative min-h-[100svh] w-full flex flex-col justify-end">
      {/* Arte de fundo + camadas de escurecimento */}
      <div className="absolute inset-0 z-0 overflow-hidden">
        <img
          src={HERO_DATA.imageUrl}
          alt="Arcanjo Miguel"
          className="w-full h-full object-cover object-top"
        />
        {/*
          Véu escuro sobre a arte inteira. A imagem do Arcanjo é dourada e muito
          clara — bonita sozinha, mas em cima dela o layout perde o ar
          cinematográfico e nenhum texto branco se sustenta. 35% de preto devolve
          a profundidade sem apagar o rosto.
        */}
        <div className="absolute inset-0 bg-[#131313]/35" />
        {/* Vinheta radial: fecha os cantos e joga o olho para o centro da arte */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(19,19,19,0.5)_100%)]" />
        {/* Fecho de cima, leve: só tira o brilho do céu para a tela não vazar por cima */}
        <div className="absolute inset-x-0 top-0 h-[22%] bg-gradient-to-b from-[#131313]/55 to-transparent" />
        {/*
          Degradê pesado embaixo. Sem ele o texto branco cai em cima da armadura
          dourada e some — a imagem é clara justamente na metade de baixo.
        */}
        <div className="absolute inset-x-0 bottom-0 h-[70%] bg-gradient-to-t from-[#131313] via-[#131313]/85 to-transparent" />
      </div>

      {/* Conteúdo */}
      <div className="relative z-10 w-full px-6 pb-8 md:pb-16 flex flex-col items-center text-center max-w-2xl mx-auto">
        <h1
          className="font-caslon font-bold text-[clamp(2.375rem,12vw,3rem)] leading-[1.16] tracking-[-0.02em] text-[#e5e2e1] mb-4"
          style={{ textShadow: '0 4px 16px rgba(0,0,0,0.55)' }}
        >
          {textos.headerTitle}
        </h1>

        {/*
          Maior e mais claro que o resto do texto de apoio (pedido do dono,
          14/08): esta linha é a instrução do que fazer, lida por gente 45+
          segurando o celular à distância de braço. O #f2efe9 quase branco com
          sombra é o mesmo tratamento do título — o bege #d0c5af que as outras
          linhas usam desaparecia sobre a parte clara da armadura.
        */}
        <p
          className="font-work font-medium text-xl md:text-2xl leading-8 text-[#f2efe9] mb-8"
          style={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
        >
          {textos.subtitle}
        </p>

        {/*
          O botão tem 56px de altura e ocupa a largura toda no celular: é o
          único alvo de toque da tela e o primeiro passo do funil inteiro.

          `pulso-de-abertura` e `halo-dourado` andam juntos de propósito: a
          animação escreve o halo dentro dos próprios quadros, e quando o
          sistema pede menos movimento ela é desligada — aí a classe estática
          volta a valer e o botão não perde a auréola.
        */}
        <button
          onClick={onStart}
          className="btn-dourado halo-dourado pulso-de-abertura w-full md:w-auto md:px-12 min-h-[56px] px-8 py-4 rounded-full font-work font-semibold text-sm text-[#241a00] uppercase tracking-[0.08em] hover:scale-[1.02] active:scale-95 transition-transform duration-300 flex items-center justify-center gap-2 cursor-pointer"
        >
          {textos.ctaText}
          <ArrowRight className="w-5 h-5" strokeWidth={2.5} />
        </button>

        {/*
          EXPERIMENTO LOCAL 14/08/2026: a citação morava ENTRE o subtítulo e o
          botão, completa (23 palavras em itálico) — era leitura obrigatória no
          caminho da única ação da tela, para um público 45+ no celular. Ela
          desceu para baixo do botão, encurtada: vira selo de fé para quem
          hesita, sem custar um centímetro de rolagem a quem já ia tocar.
        */}
        <blockquote className="font-caslon text-base leading-snug text-[#d0c5af] italic opacity-70 mt-5 text-center">
          &ldquo;{textos.quote}&rdquo;
          <span className="font-work not-italic text-[#f2ca50]/80"> — {textos.citation}</span>
        </blockquote>
      </div>
    </section>
  );
};
