import React from 'react';
import { CheckCircle } from 'lucide-react';
import { TestimonialVideo } from '../types';

interface VideoPlayerProps {
  testimonial: TestimonialVideo;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ testimonial }) => {
  if (testimonial.wistiaMediaId) {
    return (
      <div className="flex flex-col space-y-1.5">
        {/*
          `preload="none"` é o que faz esta tela abrir rápido.

          São DOIS players lado a lado, e no padrão da Wistia cada um baixa o
          primeiro segmento de vídeo assim que monta — 976 kB + 879 kB de vídeo
          que ninguém pediu para ver. Medido em 10/08/2026: a tela inteira
          puxava 3,9 MB em 33 pedidos, quase metade disso em .ts. Em 4G de
          operadora são uns 26 s olhando para dois retângulos pretos, na tela
          que existe justamente para dar confiança.

          O runtime do player continua vindo aqui, de propósito: ele é
          compartilhado com a VSL da tela 13, que vem logo depois da tela de
          processamento (~5 s). Melhor pagar esse custo aqui, enquanto a pessoa
          lê os depoimentos, do que na tela onde o vídeo É a venda.
        */}
        <div className="w-full rounded-2xl overflow-hidden border border-borda shadow-md bg-black">
          <wistia-player media-id={testimonial.wistiaMediaId} aspect="0.5625" preload="none"></wistia-player>
        </div>
        <div className="px-1 text-left">
          <p className="font-sans font-bold text-texto text-xs sm:text-sm flex items-center gap-1">
            {testimonial.author}
            <CheckCircle className="w-3.5 h-3.5 text-ouro inline fill-emerald-600" />
          </p>
          {testimonial.title && (
            <p className="text-[13px] text-suave font-medium">
              {testimonial.title}
            </p>
          )}
        </div>
      </div>
    );
  }

  return null;
};

