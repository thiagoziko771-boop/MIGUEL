import React from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { HERO_DATA } from '../data/funnelData';
import { primeiroNome } from '../lib/cadastroRapido';

interface TransicaoBencaosProps {
  nome: string;
  onContinuar: () => void;
}

/**
 * A tela entre o PEDIDO DE ORAÇÃO e o quiz (fluxo "peça e será dado",
 * 15/08/2026 — versão A, a emocional, escolhida pelo dono).
 *
 * Não é um "obrigado" genérico: é o fecho do gesto. A pessoa acabou de
 * entregar o pedido e precisa ouvir que ele chegou — só então faz sentido
 * pedir mais dela (as perguntas). Sem esta tela, o quiz nascia colado no
 * formulário e parecia mais burocracia.
 *
 * Mesma arte e mesmas camadas do hero, de propósito: é a mesma cena, um passo
 * adiante. Rápida e sem espera artificial — o botão está ali desde o primeiro
 * quadro; quem quiser seguir, segue.
 */
export const TransicaoBencaos: React.FC<TransicaoBencaosProps> = ({ nome, onContinuar }) => {
  const primeiro = primeiroNome(nome);

  return (
    <section className="relative min-h-[100svh] w-full flex flex-col justify-end">
      <div className="absolute inset-0 z-0 overflow-hidden">
        <img src={HERO_DATA.imageUrl} alt="Arcanjo Miguel" className="w-full h-full object-cover object-top" />
        <div className="absolute inset-0 bg-[#131313]/45" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(19,19,19,0.5)_100%)]" />
        <div className="absolute inset-x-0 top-0 h-[22%] bg-gradient-to-b from-[#131313]/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-[72%] bg-gradient-to-t from-[#131313] via-[#131313]/88 to-transparent" />
      </div>

      <div className="relative z-10 w-full px-6 pb-8 md:pb-16 flex flex-col items-center text-center max-w-2xl mx-auto">
        <div className="w-14 h-14 rounded-full bg-[#f2ca50]/15 border border-[#f2ca50]/50 flex items-center justify-center mb-4">
          <CheckCircle2 className="w-8 h-8 text-[#f2ca50]" strokeWidth={2} />
        </div>

        <h1
          className="font-caslon font-bold text-[clamp(1.875rem,9vw,2.5rem)] leading-[1.18] tracking-[-0.01em] text-[#e5e2e1] mb-3"
          style={{ textShadow: '0 4px 16px rgba(0,0,0,0.55)' }}
        >
          Seu pedido foi enviado ao Arcanjo Miguel. 🙏
        </h1>

        <p
          className="font-work font-semibold text-xl md:text-2xl leading-8 text-[#f2ca50] mb-3"
          style={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
        >
          {primeiro ? `${primeiro}, agora continue para receber suas bênçãos.` : 'Agora, continue para receber suas bênçãos.'}
        </p>

        <p
          className="font-work text-lg leading-7 text-[#f2efe9] mb-8"
          style={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
        >
          Responda algumas perguntas sobre o seu momento de vida e continue sua oração.
        </p>

        <button
          onClick={onContinuar}
          className="btn-dourado halo-dourado pulso-de-abertura w-full md:w-auto md:px-12 min-h-[56px] px-8 py-4 rounded-full font-work font-semibold text-sm text-[#241a00] uppercase tracking-[0.08em] hover:scale-[1.02] active:scale-95 transition-transform duration-300 flex items-center justify-center gap-2 cursor-pointer"
        >
          Continuar para receber minhas bênçãos
          <ArrowRight className="w-5 h-5" strokeWidth={2.5} />
        </button>
      </div>
    </section>
  );
};
