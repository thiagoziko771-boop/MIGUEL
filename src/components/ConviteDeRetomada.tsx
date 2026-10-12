import React, { useEffect, useRef } from 'react';
import * as m from 'motion/react-m';
import { ArrowDown, ShieldCheck } from 'lucide-react';
import { Button } from './Button';
import { rastrear } from '../lib/rastreio';

/**
 * A mensagem que recebe quem começou o pedido e não terminou.
 *
 * Ela aparece num momento muito específico: a pessoa gerou o PIX, saiu — para o
 * app do banco, para atender alguém, para pensar — e VOLTOU. O pedido dela
 * continua guardado no navegador (ver STORAGE_KEY em InlineCheckout) e o
 * checkout a devolve direto para a tela do código PIX.
 *
 * Antes desta mensagem, essa volta era muda: a pessoa reencontrava um QR Code e
 * um código, sem uma linha explicando por que aquilo ainda estava ali. Quem
 * tinha desistido não via motivo para reconsiderar, e quem só tinha se
 * distraído precisava se lembrar sozinha do que estava fazendo.
 *
 * DUAS COISAS QUE ELA NÃO FAZ, de propósito:
 *
 *  - não inventa pressa. Nada de contagem regressiva, "última chance" ou vaga
 *    que expira. O prazo real da chave PIX já está escrito logo abaixo, no
 *    painel de pagamento, e é o único que existe de verdade;
 *  - não cobra. O texto oferece continuar, e diz isso uma vez só. Mensagem de
 *    recuperação que insiste vira mensagem de cobrança, e cobrança num funil
 *    devocional queima a confiança que a oferta inteira depende.
 */

/** Âncora da rolagem: quem volta precisa cair aqui, e não no topo da VSL. */
export const ID_DO_CONVITE_DE_RETOMADA = 'convite-de-retomada';

interface ConviteDeRetomadaProps {
  /** Valor já formatado do pedido em aberto. Vem do servidor, nunca da tela. */
  valorFormatado: string;
  /** Leva a pessoa até o QR Code e o copia e cola. */
  onContinuar: () => void;
}

export const ConviteDeRetomada: React.FC<ConviteDeRetomadaProps> = ({ valorFormatado, onContinuar }) => {
  /*
   * Registra que a mensagem foi mostrada — uma vez por montagem, e não uma vez
   * por renderização. O relógio do painel de PIX ao lado redesenha esta árvore a
   * cada segundo; sem a trava, um cliente parado dez minutos na tela viraria
   * seiscentas "recuperações vistas" no relatório.
   */
  const jaRegistrou = useRef(false);
  useEffect(() => {
    if (jaRegistrou.current) return;
    jaRegistrou.current = true;
    rastrear('RecuperacaoVista', { step: 13, contentIds: ['main'] });
  }, []);

  const continuar = (): void => {
    rastrear('RecuperacaoClique', { step: 13, contentIds: ['main'] });
    onContinuar();
  };

  return (
    <m.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      id={ID_DO_CONVITE_DE_RETOMADA}
      aria-labelledby="titulo-retomada"
      className="scroll-mt-4 bg-creme border border-ouro rounded-2xl p-5 sm:p-6 space-y-4"
    >
      {/* O escudo é o mesmo do cabeçalho do checkout, e é o símbolo do próprio
          Arcanjo. Repetir o que a pessoa já viu antes de sair ajuda a reconhecer
          que ela voltou para o lugar certo. */}
      <div className="w-14 h-14 rounded-full bg-superficie border border-ouro flex items-center justify-center mx-auto text-ouro">
        <ShieldCheck className="w-7 h-7 stroke-[2.25]" />
      </div>

      <h3
        id="titulo-retomada"
        className="font-sans font-bold text-lg sm:text-xl text-texto leading-snug text-center text-balance"
      >
        Sua oração ainda está esperando por você. 🙏
      </h3>

      {/* Alinhado à esquerda: parágrafo centralizado de três linhas no celular
          obriga o olho a procurar o começo de cada linha, e este público lê
          devagar. Só o título, a oração e a bênção ficam centralizados. */}
      <div className="space-y-2.5 text-sm text-suave leading-relaxed">
        <p>
          Percebemos que você iniciou seu pedido da{' '}
          <strong className="text-texto font-semibold">Oração Sagrada de São Miguel Arcanjo</strong>, mas talvez
          tenha acontecido alguma coisa no caminho.
        </p>
        <p>Se você ainda deseja receber sua oração, você pode continuar de onde parou.</p>
      </div>

      {/*
        A oração da própria devoção, em destaque.
        É o trecho da oração de São Miguel que o funil inteiro promete — e aqui
        ele faz um trabalho que texto de venda nenhum faria: lembra a pessoa do
        motivo pelo qual ela entrou, sem pedir nada em troca.
      */}
      <blockquote className="border-l-2 border-ouro pl-3.5 py-0.5">
        <p className="font-serif italic text-[15px] sm:text-base text-texto leading-relaxed">
          São Miguel Arcanjo, defendei-nos no combate e permanecei ao nosso lado neste momento de fé.
        </p>
      </blockquote>

      <div className="space-y-3">
        <p className="text-sm text-suave leading-relaxed">
          Toque no botão abaixo para concluir seu pedido de{' '}
          <strong className="text-texto font-semibold">{valorFormatado}</strong>, que continua reservado em seu nome.
        </p>

        {/*
          Dourado, e não o verde de compra. O verde já está logo abaixo, no botão
          que copia o código PIX — que é onde o pagamento realmente acontece.
          Dois botões verdes na mesma tela disputariam a mesma atenção, e este
          aqui só faz a pessoa descer até o outro.

          Sem o ícone padrão e com o texto um ponto menor: em tela de 390 px o
          rótulo quebrava em duas linhas e a seta ficava pendurada ao lado do
          bloco, apontando para o vazio entre elas. A seta desceu para a linha de
          apoio, onde diz a mesma coisa sem disputar espaço.
        */}
        <Button
          variant="secondary"
          onClick={continuar}
          icon={null}
          className="text-[15px] sm:text-base tracking-wide"
        >
          CONTINUAR MEU PEDIDO
        </Button>

        <p className="text-[12px] text-suave text-center flex items-center justify-center gap-1.5">
          <ArrowDown className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Leva você direto ao QR Code e ao código PIX</span>
        </p>
      </div>

      <p className="text-[13px] text-suave text-center leading-relaxed">
        Que São Miguel Arcanjo interceda por você e proteja seu caminho. 🙏
      </p>
    </m.section>
  );
};
