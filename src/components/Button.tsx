import React from 'react';
import type { HTMLMotionProps } from 'motion/react';
import * as m from 'motion/react-m';
import { Sparkles, ArrowRight, Loader2 } from 'lucide-react';

interface ButtonProps extends HTMLMotionProps<'button'> {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'comprar';
  fullWidth?: boolean;
  isLoading?: boolean;
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  fullWidth = true,
  isLoading = false,
  icon = <ArrowRight className="w-5 h-5 ml-2" />,
  className = '',
  disabled,
  ...props
}) => {
  const baseStyles = "relative min-h-[56px] px-6 py-4 rounded-full font-sans font-semibold text-base sm:text-lg tracking-wide flex items-center justify-center transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none";

  /*
   * `comprar` é o verde, e existe separado de `primary` de propósito.
   *
   * `primary` veste sete botões do funil, inclusive o "Continuar" do quiz.
   * Pintar tudo de verde apagaria a diferença entre avançar no quiz e comprar
   * — que é justamente a distinção que o verde deveria criar.
   *
   * O tom é #278647, e o número tem uma razão medida: é o verde MAIS VIVO que
   * ainda mantém 4.5:1 de contraste com texto branco, o mínimo em que uma
   * pessoa com visão reduzida consegue ler. O verde vivo de referência
   * (#22C55E) fica em 2.28:1 — bonito na tela de quem enxerga bem, ilegível
   * para o público que compra aqui, que tem 50 anos ou mais e lê no celular.
   *
   * Se um dia clarear este verde, meça o contraste antes: um botão de compra
   * que não se lê é o lugar mais caro possível para economizar legibilidade.
   */
  const variants = {
    primary: "bg-acao hover:bg-acao-hover text-sobre-acao border border-acao active:scale-[0.98] hover:shadow-md",
    comprar: "bg-[#278647] hover:bg-[#1F6F3A] text-white border border-[#278647] active:scale-[0.98]",
    secondary: "bg-ouro hover:bg-ouro-forte text-sobre-ouro border border-ouro active:scale-[0.98]",
    outline: "bg-superficie hover:bg-sutil text-texto border-1.5 border-borda hover:border-ouro active:scale-[0.98]"
  };

  /*
   * Só os botões de compra pulsam, e só enquanto podem ser apertados.
   *
   * O "Continuar" do quiz de fora de propósito: se tudo pulsa, o pulso deixa de
   * apontar para onde se compra e vira ruído de fundo. Carregando também não
   * pulsa — anel piscando embaixo de "Aguarde um momento" diz duas coisas
   * opostas ao mesmo tempo, e a pessoa clica de novo achando que não pegou.
   *
   * O `shadow-sm` do estilo base sai quando o pulso entra: as duas sombras se
   * somariam e o anel ficaria sujo.
   */
  const pulsa = variant === 'comprar' && !disabled && !isLoading;
  const classesDeSombra = pulsa ? 'pulso-de-compra' : 'shadow-sm';

  return (
    <m.button
      whileTap={{ scale: disabled || isLoading ? 1 : 0.98 }}
      whileHover={{ y: disabled || isLoading ? 0 : -1 }}
      className={`${baseStyles} ${variants[variant]} ${classesDeSombra} ${fullWidth ? 'w-full' : 'w-auto'} ${className}`}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <div className="flex items-center gap-2">
          {/* `text-current` porque o texto do botão muda de cor por variante e
              por tema — o verde de compra leva branco, o ouro leva quase-preto.
              Um branco fixo aqui sumia dentro do botão dourado. */}
          <Loader2 className="w-5 h-5 animate-spin text-current" />
          <span>Aguarde um momento...</span>
        </div>
      ) : (
        <span className="flex items-center justify-center gap-2 text-center">
          <span>{children}</span>
          {icon}
        </span>
      )}
    </m.button>
  );
};
