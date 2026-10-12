import React, { useEffect, useState } from 'react';
import * as m from 'motion/react-m';
import { AlertCircle, Barcode, Check, Copy, Clock, ExternalLink, RefreshCw } from 'lucide-react';
import type { Order } from '../lib/api';
import { copiarTexto } from '../lib/copiar';

/**
 * Âncora da rolagem automática, igual à do PIX: quem emite o boleto cai direto
 * na linha digitável e no botão de copiar.
 */
export const ID_DA_AREA_DO_BOLETO = 'area-de-pagamento-boleto';

/**
 * A tela do boleto emitido.
 *
 * A diferença que organiza tudo aqui: no PIX a tela é uma SALA DE ESPERA — a
 * pessoa paga no app e volta em segundos para ver o acesso liberado. No boleto
 * ela é um COMPROVANTE: a confirmação vem de 1 a 3 dias úteis depois, quase
 * sempre com a página já fechada. Por isso esta tela precisa fazer duas coisas
 * que a do PIX não faz:
 *
 *  - DIZER, sem rodeio, que a liberação não é agora. Este público é adulto mais
 *    velho e de fé, comprando por impulso a partir de um anúncio; deixar no ar
 *    que o acesso vem na hora produz, três horas depois, uma pessoa achando que
 *    foi enganada. O aviso vem ANTES da linha digitável, não no rodapé.
 *  - Dar o que levar embora: o número do pedido e a data de vencimento, à
 *    vista, porque é com eles que ela cobra o suporte se algo falhar.
 */
interface BoletoPanelProps {
  order: Order;
  title: string;
  description: string;
  isChecking: boolean;
  error: string | null;
  onCheckNow: () => void;
  /** Volta ao formulário. Ausente, a saída não aparece — mesma regra do PixPanel. */
  onEditarPedido?: () => void;
}

/**
 * Data no formato que a pessoa lê no banco: "quinta-feira, 20 de agosto".
 *
 * Sem o dia da semana o vencimento é só um número — e é justamente o dia da
 * semana que faz alguém perceber que o prazo cai num sábado e resolver pagar
 * antes.
 */
function formatarVencimento(iso: string): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }).format(data);
}

export const BoletoPanel: React.FC<BoletoPanelProps> = ({
  order,
  title,
  description,
  isChecking,
  error,
  onCheckNow,
  onEditarPedido,
}) => {
  const [copied, setCopied] = useState(false);
  const [falhaAoCopiar, setFalhaAoCopiar] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 4000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Folga maior que a da confirmação: este aviso traz uma instrução para
  // executar, e sumir em três segundos a tiraria da tela antes da leitura.
  useEffect(() => {
    if (!falhaAoCopiar) return;
    const timer = window.setTimeout(() => setFalhaAoCopiar(false), 12000);
    return () => window.clearTimeout(timer);
  }, [falhaAoCopiar]);

  const boleto = order.boleto;
  const vencido = order.status === 'expired';

  const handleCopy = async () => {
    if (!boleto) return;
    // Copia os dígitos crus: é a forma que o campo do banco aceita colada. A
    // versão com pontos serve para ler, não para colar.
    const deuCerto = await copiarTexto(boleto.linhaDigitavelCrua);
    setCopied(deuCerto);
    setFalhaAoCopiar(!deuCerto);
  };

  return (
    /* O id delimita o painel para a bateria de tela poder medir o texto DAQUI,
       e não o da página inteira: o funil acima promete acesso imediato (com
       razão, para o PIX), e um teste que lê o documento todo confunde as duas
       promessas. Ver scripts/testar-tela-boleto.mjs. */
    <m.div
      id="painel-do-boleto"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      className="text-center py-4 space-y-5"
    >
      <div className="w-14 h-14 rounded-full bg-sutil text-texto flex items-center justify-center mx-auto border border-borda">
        <Barcode className="w-7 h-7 stroke-[2.5]" />
      </div>

      <div className="space-y-1">
        <span className="text-[13px] font-bold text-texto bg-sutil px-2.5 py-1 rounded-full uppercase tracking-wider border border-borda">
          Seu boleto está pronto
        </span>
        <h3 className="font-sans font-bold text-xl text-texto pt-1">{title}</h3>
        <p className="text-xs text-suave">{description}</p>
        <p className="text-xs text-suave">
          Valor: <strong className="text-texto text-sm font-bold">{order.amountFormatted}</strong>
        </p>
      </div>

      {vencido ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800 space-y-1">
          <p className="font-bold flex items-center justify-center gap-1.5">
            <AlertCircle className="w-4 h-4" />
            Este boleto venceu
          </p>
          <p className="text-xs">
            Sua oração continua reservada: recarregue a página para gerar um novo pagamento. Se você pagou nos
            últimos dias, aguarde — pode ser a compensação do banco, que leva até 3 dias úteis.
          </p>
        </div>
      ) : !boleto ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
          Estamos emitindo o seu boleto. Recarregue esta página em alguns instantes.
        </div>
      ) : (
        <>
          {/*
            O aviso do prazo, ACIMA de tudo.

            Ele é a única informação desta tela que contraria o que a pessoa
            espera, e por isso vem primeiro — depois do botão de copiar ninguém
            lê mais nada. Âmbar e não vermelho: é um prazo normal do meio de
            pagamento que ela escolheu, não um erro.
          */}
          <div className="bg-amber-50 border border-amber-300 rounded-xl p-3.5 text-left flex items-start gap-2.5">
            <Clock className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-bold text-amber-900">O acesso é liberado depois que o banco confirmar</p>
              <p className="text-[13px] text-amber-900 leading-snug">
                Boleto não é instantâneo: a confirmação leva de <strong>1 a 3 dias úteis</strong> depois do
                pagamento. Assim que ela chegar, sua Oração é liberada automaticamente e você pode voltar a esta
                página pelo mesmo navegador.
              </p>
              <p className="text-[13px] text-amber-900 leading-snug">
                Quer receber agora, na hora? <strong>Volte e escolha PIX.</strong>
              </p>
            </div>
          </div>

          {/* `scroll-mt-20` deixa o valor a pagar à vista quando a rolagem
              automática para aqui — mesmo motivo do painel do PIX. */}
          <div
            id={ID_DA_AREA_DO_BOLETO}
            className="scroll-mt-20 bg-sutil border border-borda rounded-2xl p-4 sm:p-5 space-y-3"
          >
            <div className="space-y-1 text-left">
              <p className="text-sm font-sans font-bold text-texto">Código de barras (linha digitável)</p>
              <p className="text-[13px] text-suave leading-snug">
                Copie e cole no aplicativo do seu banco, na opção de pagar boleto.
              </p>
            </div>

            {/*
              A linha inteira, em pedaços, sem rolagem interna.

              `select-all` faz um toque longo pegar tudo de uma vez — a saída
              manual de quem estiver num navegador sem área de transferência. O
              tamanho maior que o do código PIX é deliberado: aqui existe a
              chance real de a pessoa DIGITAR os 47 números no banco, e para
              digitar ela precisa conseguir ler.
            */}
            <div
              className="bg-superficie p-3 rounded-lg border border-borda text-[13px] sm:text-sm font-mono text-left leading-relaxed text-texto break-all select-all"
              aria-label="Linha digitável do boleto"
            >
              {boleto.linhaDigitavel}
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className={`w-full min-h-[56px] py-3.5 px-4 bg-[#278647] text-white rounded-xl font-sans font-bold text-sm sm:text-base flex items-center justify-center gap-2 hover:bg-[#1F6F3A] transition-colors cursor-pointer ${copied ? 'shadow-xs' : 'pulso-de-compra'}`}
            >
              {copied ? (
                <>
                  <Check className="w-5 h-5 stroke-[3]" />
                  <span>Código copiado!</span>
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  <span>Copiar código do boleto</span>
                </>
              )}
            </button>

            {/* Sempre no documento e sem ocupar espaço: região `aria-live` que
                nasce junto com a mensagem não é anunciada por parte dos
                leitores de tela. Mesma solução do painel do PIX. */}
            <p className="sr-only" role="status" aria-live="polite">
              {copied ? 'Código do boleto copiado. Agora cole no aplicativo do seu banco.' : ''}
              {falhaAoCopiar ? 'Não foi possível copiar automaticamente. Selecione o código na tela.' : ''}
            </p>

            {copied && (
              <p className="text-[13px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-center gap-1.5">
                <Check className="w-4 h-4 flex-shrink-0" />
                Código copiado! Agora cole no app do seu banco.
              </p>
            )}
            {falhaAoCopiar && (
              <p className="text-[13px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-left flex items-start gap-1.5">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  Seu navegador não deixou copiar sozinho. Segure o dedo sobre o código acima até aparecer
                  <strong> Copiar</strong>, e depois cole no app do banco.
                </span>
              </p>
            )}

            <p className="text-[13px] text-suave text-center">
              Vence <strong className="text-texto">{formatarVencimento(boleto.vencimento)}</strong>. Depois dessa
              data o banco recusa o pagamento.
            </p>

            {/* O PDF só aparece quando o provedor devolve um. Nem todos devolvem,
                e um link morto nesta tela vale menos que nenhum link. */}
            {boleto.urlPdf && (
              <a
                href={boleto.urlPdf}
                target="_blank"
                rel="noreferrer"
                className="w-full min-h-[44px] py-2.5 px-4 bg-superficie border border-borda text-texto rounded-xl font-sans font-semibold text-xs flex items-center justify-center gap-2 hover:border-ouro transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Abrir o boleto em PDF (para imprimir ou pagar no caixa)</span>
              </a>
            )}
          </div>

          {/*
            O passo a passo, escrito para quem nunca pagou boleto pelo celular.

            Mesma razão do tutorial do PIX: "pague o boleto" pressupõe saber
            onde fica essa opção DENTRO do app do banco, e quem não sabe fica
            parada com o dinheiro na mão, querendo pagar. Numerado porque a
            ordem aqui é informação de verdade.
          */}
          <div className="bg-superficie border border-borda rounded-2xl p-4 sm:p-5 text-left space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-sans font-bold text-texto">Nunca pagou boleto pelo celular? Siga estes passos</p>
              <p className="text-[13px] text-suave leading-snug">
                Dá para pagar sem sair de casa e sem imprimir nada.
              </p>
            </div>
            <ol className="space-y-3">
              {[
                {
                  titulo: 'Copie o código',
                  texto: <>Toque no botão verde <strong className="text-texto">Copiar código do boleto</strong>, acima.</>,
                },
                {
                  titulo: 'Abra seu banco',
                  texto: <>Abra o <strong className="text-texto">aplicativo do seu banco</strong>, o mesmo que você usa normalmente.</>,
                },
                {
                  titulo: 'Toque em Pagar',
                  texto: (
                    <>
                      Procure a opção <strong className="text-texto">Pagar</strong> e, dentro dela,{' '}
                      <strong className="text-texto">Boleto</strong> ou{' '}
                      <strong className="text-texto">Código de barras</strong>.
                    </>
                  ),
                },
                {
                  titulo: 'Cole o código',
                  texto: (
                    <>
                      Cole o código no campo indicado. Se o app pedir para ler o código de barras com a câmera,
                      procure a opção de <strong className="text-texto">digitar o código</strong>.
                    </>
                  ),
                },
                {
                  titulo: 'Confirme o pagamento',
                  texto: (
                    <>
                      Confira o valor — <strong className="text-texto">{order.amountFormatted}</strong> — e confirme
                      no seu banco.
                    </>
                  ),
                },
                {
                  titulo: 'Guarde o comprovante',
                  texto: (
                    <>
                      Guarde o comprovante do banco. Ele é a sua prova de pagamento enquanto a confirmação não
                      chega.
                    </>
                  ),
                },
              ].map((passo, indice) => (
                <li key={passo.titulo} className="flex gap-3 items-start">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-ouro text-sobre-ouro text-xs font-bold flex items-center justify-center mt-0.5">
                    {indice + 1}
                  </span>
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-[13px] sm:text-sm font-sans font-bold text-texto leading-snug">{passo.titulo}</p>
                    <p className="text-[13px] leading-snug text-suave">{passo.texto}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/*
            O que a pessoa leva embora desta tela.

            O número do pedido é o que faz o suporte encontrá-la depois — e com
            boleto o "depois" é a regra, não a exceção: quase ninguém vai estar
            com esta página aberta quando a confirmação cair.
          */}
          <div className="bg-superficie border border-borda rounded-xl p-3.5 space-y-2.5 text-left">
            <p className="text-sm font-sans font-bold text-texto">Anote antes de fechar esta página</p>
            <div className="space-y-1 text-[13px] text-suave">
              <p>
                Número do pedido:{' '}
                <strong className="text-texto font-mono">{order.id.slice(0, 8).toUpperCase()}</strong>
              </p>
              <p>
                Acesso em nome de: <strong className="text-texto">{order.customer.email}</strong>
              </p>
            </div>
            <button
              onClick={onCheckNow}
              disabled={isChecking}
              className="w-full min-h-[44px] py-2.5 px-4 bg-sutil border border-borda text-texto rounded-xl font-sans font-semibold text-xs flex items-center justify-center gap-2 hover:border-ouro transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Verificando...' : 'Já paguei — verificar agora'}</span>
            </button>
          </div>

          {onEditarPedido && (
            <button
              onClick={onEditarPedido}
              className="w-full min-h-[44px] text-[13px] text-suave underline underline-offset-2 hover:text-texto transition-colors cursor-pointer py-1"
            >
              Quero mudar meu pedido ou pagar com PIX
            </button>
          )}
        </>
      )}

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center justify-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </p>
      )}
    </m.div>
  );
};
