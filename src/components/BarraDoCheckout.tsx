import React, { useEffect, useState } from 'react';

/**
 * A barra que ocupa a espera entre tocar no botão e o PIX aparecer.
 *
 * Essa espera é curta — de um a três segundos —, mas é o pior segundo do funil
 * inteiro: a pessoa acabou de decidir pagar, tocou no botão e a tela fica igual.
 * Quem tem pouca intimidade com celular lê "nada aconteceu" e toca de novo, ou
 * desiste achando que travou. O botão já mostrava um giro, e giro não diz
 * quanto falta; a barra diz que existe um fim.
 *
 * TRÊS DECISÕES QUE FAZEM ELA SER HONESTA:
 *
 * 1. NÃO CHEGA A 100% SOZINHA. Ela sobe até 90% e para. Os 100% só acontecem
 *    quando a cobrança existe de verdade. Barra que completa antes da resposta
 *    ensina a pessoa a esperar a tela mudar depois de "pronto" — e é aí que ela
 *    toca de novo, gerando dois pedidos.
 * 2. DESACELERA PERTO DO FIM, como o carregamento real de qualquer coisa. Subir
 *    linear até 90% e travar parece defeito; a curva que vai fechando parece
 *    trabalho acontecendo.
 * 3. NÃO SEGURA O CHECKOUT. Ela some junto com o formulário quando a cobrança
 *    fica pronta, mesmo que isso aconteça depressa. Houve aqui um tempo mínimo
 *    de exibição, e ele obrigava o handler a esperar antes de trocar de passo —
 *    o que quebrou o checkout: a cobrança nascia e a tela voltava ao início.
 *    Ver o comentário em InlineCheckout.tsx, no lugar onde a espera existia. A
 *    barra mostra o tempo REAL da chamada; passar rápido é a verdade quando a
 *    resposta foi rápida.
 *
 * O texto muda junto porque ele é a outra metade da informação: "gerando o seu
 * código PIX" explica O QUE está acontecendo, coisa que porcentagem nenhuma faz.
 */
interface BarraDoCheckoutProps {
  /** Enquanto true, a barra avança. Ao virar false, ela completa e some. */
  ativo: boolean;
  /** Chamado depois que a barra completa e termina a saída. */
  aoTerminar?: () => void;
}

const PASSOS = [
  { ate: 30, texto: 'Reservando a sua Oração...' },
  { ate: 65, texto: 'Preparando a sua contribuição...' },
  { ate: 90, texto: 'Gerando o seu código PIX...' },
  { ate: 100, texto: 'Pronto! Abrindo o seu pagamento...' },
];

/** Tempo mínimo em que a barra fica à vista, para não piscar. Ver a decisão 3. */
const MINIMO_VISIVEL_MS = 900;

export const BarraDoCheckout: React.FC<BarraDoCheckoutProps> = ({ ativo, aoTerminar }) => {
  const [progresso, setProgresso] = useState(0);
  const [visivel, setVisivel] = useState(false);
  const [nasceuEm, setNasceuEm] = useState(0);

  useEffect(() => {
    if (!ativo) return;

    setVisivel(true);
    setProgresso(0);
    setNasceuEm(Date.now());

    /*
     * Cada passo anda um pouco menos que o anterior: a distância que falta é
     * dividida, então a barra nunca alcança o teto sozinha e vai ficando lenta
     * como um carregamento de verdade.
     */
    const relogio = window.setInterval(() => {
      setProgresso((atual) => (atual >= 90 ? 90 : atual + Math.max(1, (90 - atual) * 0.08)));
    }, 90);

    return () => window.clearInterval(relogio);
  }, [ativo]);

  useEffect(() => {
    if (ativo || !visivel) return;

    // Completa de verdade só agora, que a cobrança existe.
    setProgresso(100);

    const esperou = Date.now() - nasceuEm;
    const falta = Math.max(0, MINIMO_VISIVEL_MS - esperou);
    const relogio = window.setTimeout(() => {
      setVisivel(false);
      aoTerminar?.();
    }, falta + 260);

    return () => window.clearTimeout(relogio);
  }, [ativo, visivel, nasceuEm, aoTerminar]);

  if (!visivel) return null;

  const passo = PASSOS.find((p) => progresso <= p.ate) ?? PASSOS[PASSOS.length - 1];

  return (
    <div className="space-y-2 py-1" data-barra-checkout>
      <div className="flex items-center justify-between text-[13px]">
        {/* `aria-live` porque quem usa leitor de tela não vê a barra encher:
            sem isto, apertar o botão não produz retorno nenhum. */}
        <span className="text-texto font-semibold" role="status" aria-live="polite">
          {passo.texto}
        </span>
        <span className="text-suave font-mono">{Math.round(progresso)}%</span>
      </div>

      <div
        className="w-full h-2.5 rounded-full bg-sutil border border-borda overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(progresso)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Preparando o seu pagamento"
      >
        {/*
          `transition-[width]` e não animação de keyframes: a largura muda em
          degraus vindos do estado, e a transição alisa cada degrau. Assim a
          barra continua honesta — ela representa o progresso real que temos,
          suavizado, e não uma animação decorativa rodando à parte.
        */}
        <div
          className="h-full bg-ouro transition-[width] duration-200 ease-out"
          style={{ width: `${progresso}%` }}
        />
      </div>

      <p className="text-[12px] text-suave">
        Só um instante — não feche esta página nem toque de novo.
      </p>
    </div>
  );
};
