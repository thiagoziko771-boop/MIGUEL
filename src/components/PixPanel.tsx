import React, { useEffect, useState } from 'react';
import * as m from 'motion/react-m';
import { AlertCircle, Check, Copy, Loader2, QrCode, RefreshCw, ShieldAlert } from 'lucide-react';
import type { Order } from '../lib/api';
import { copiarTexto } from '../lib/copiar';
import { formatCountdown } from '../lib/format';

/**
 * Âncora da rolagem automática: quem gera o PIX cai direto no QR Code e no
 * copia e cola. Exportada porque quem manda rolar é o InlineCheckout, que é
 * dono do passo do checkout — e um identificador escrito à mão nos dois
 * arquivos se perderia na primeira renomeação.
 */
export const ID_DA_AREA_DE_PAGAMENTO = 'area-de-pagamento-pix';

interface PixPanelProps {
  order: Order;
  title: string;
  description: string;
  isChecking: boolean;
  error: string | null;
  onCheckNow: () => void;
  /**
   * Volta para o formulário. Quando ausente, a saída não aparece.
   *
   * Existe só no PIX do pedido principal: no upsell e no downsell a pessoa já
   * pagou o que importa, e uma saída ali só ofereceria uma porta para desistir
   * de algo que ela acabou de escolher.
   */
  onEditarPedido?: () => void;
}

export const PixPanel: React.FC<PixPanelProps> = ({
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 4000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /*
   * O aviso de falha some sozinho também, mas com folga maior: ele traz uma
   * instrução para executar ("segure o dedo sobre o código"), e sumir em três
   * segundos tiraria a instrução da tela antes de a pessoa terminar de ler.
   */
  useEffect(() => {
    if (!falhaAoCopiar) return;
    const timer = window.setTimeout(() => setFalhaAoCopiar(false), 12000);
    return () => window.clearTimeout(timer);
  }, [falhaAoCopiar]);

  const pixCode = order.pix?.code ?? '';
  const countdown = formatCountdown(order.pix?.expiresAt, now);
  const isExpired = order.status === 'expired' || (order.status === 'pending' && order.pix?.expiresAt != null && countdown === null);

  const [qrGerado, setQrGerado] = useState<string | null>(null);
  const imagemDoGateway = order.pix?.imageUrl ?? null;

  /*
   * O QR é desenhado AQUI, SEMPRE — e a imagem do gateway virou só o plano B.
   *
   * Era o contrário: quando o gateway devolvia uma imagem, a geração local nem
   * rodava. Isso funcionou por acidente enquanto o provedor ativo não mandava
   * imagem nenhuma (a SyncPay devolve `null`, então o desenho local era o único
   * caminho e nunca falhou). A ZuckPay MANDA `qrcode_image`, apontando para um
   * `qr.php` no domínio deles — e aí a tela do PIX passaria a depender de uma
   * requisição a um terceiro para mostrar o QR. Se ela falhasse por bloqueador
   * de anúncio, por hotlink, por lentidão no 4G ou por o domínio estar fora do
   * ar, o cliente veria um espaço vazio no lugar do código, sem nenhum
   * substituto — na tela em que ele está com o banco aberto para pagar.
   *
   * O copia e cola JÁ É o conteúdo do QR. Desenhar a partir dele não precisa de
   * rede, não pode divergir da cobrança e ainda poupa um download num funil em
   * que a maioria entra por celular ruim. A biblioteca entra por import
   * dinâmico para não pesar nas telas do quiz.
   */
  useEffect(() => {
    if (!pixCode) {
      setQrGerado(null);
      return;
    }
    let ativo = true;

    import('qrcode-generator')
      .then((modulo) => {
        if (!ativo) return;
        // typeNumber 0 escolhe a versão do QR sozinho, conforme o tamanho do
        // código; 'M' é a correção de erro padrão do BR Code.
        const qr = modulo.default(0, 'M');
        qr.addData(pixCode);
        qr.make();
        setQrGerado(qr.createDataURL(6, 2));
      })
      .catch(() => {
        if (ativo) setQrGerado(null);
      });

    return () => {
      ativo = false;
    };
  }, [pixCode]);

  /*
   * O desenho local ganha. A imagem do gateway só aparece se a biblioteca não
   * carregar — o caso raro em que ter um terceiro de reserva é melhor que não
   * ter QR nenhum.
   */
  const imagemDoQr = qrGerado ?? imagemDoGateway;

  /*
   * A cópia em si mora em src/lib/copiar.ts: o boleto precisa exatamente do
   * mesmo cuidado com os navegadores embutidos, e duas cópias da mesma lógica
   * seriam duas chances de errar no passo que fecha a venda.
   */
  const handleCopy = async () => {
    if (!pixCode) return;
    const deuCerto = await copiarTexto(pixCode);
    setCopied(deuCerto);
    setFalhaAoCopiar(!deuCerto);
  };

  return (
    <m.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-4 space-y-5">
      <div className="w-14 h-14 rounded-full bg-amber-100 text-ouro flex items-center justify-center mx-auto border border-amber-200">
        <QrCode className="w-7 h-7 stroke-[2.5]" />
      </div>

      <div className="space-y-1">
        <span className="text-[13px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full uppercase tracking-wider border border-emerald-200">
          Seu PIX está pronto
        </span>
        <h3 className="font-sans font-bold text-xl text-texto pt-1">{title}</h3>
        <p className="text-xs text-suave">{description}</p>
        <p className="text-xs text-suave">
          Valor: <strong className="text-texto text-sm font-bold">{order.amountFormatted}</strong>
        </p>
      </div>

      {isExpired ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800 space-y-1">
          <p className="font-bold flex items-center justify-center gap-1.5">
            <AlertCircle className="w-4 h-4" />
            Esta chave PIX expirou
          </p>
          <p className="text-xs">
            Sua oração continua reservada: recarregue a página para gerar um novo código e concluir.
          </p>
        </div>
      ) : (
        <>
          {/*
            Um bloco só, com o passo a passo DEPOIS, para quem precisar dele —
            o tutorial já morou entre o QR e o código, e obrigava quem só queria
            copiar a atravessá-lo.

            A ORDEM INTERNA MUDA COM O TAMANHO DA TELA, e isso é o coração do
            enquadramento (pedido do dono em 14/08/2026): no celular o COPIA E
            COLA vem primeiro e o QR desce; em tela larga o QR volta para cima.
            Quem chega de anúncio está no celular, e paga no MESMO aparelho — o
            QR é inútil para ela (não dá para apontar a câmera para a própria
            tela). Com o QR em cima, a rolagem automática parava nele e o botão
            de copiar ficava ~550 px abaixo, fora da primeira tela: a pessoa
            gerava o código e não via o que fazer em seguida. Invertida a ordem,
            o que a rolagem enquadra é rótulo + código + botão verde — a ação
            inteira na primeira dobra.

            `flex` + `order`, e não reordenar o DOM por JS: o mesmo HTML serve
            aos dois layouts. E `gap-4` no lugar do `space-y-4` de antes porque
            `space-y` põe a margem pela ordem do DOM, não pela visual — com
            `order` trocado, o vão cairia no lugar errado.
          */}
          {/*
            `scroll-mt-20` é para a rolagem automática (ver InlineCheckout) não
            encostar o cartão no topo da tela: os 80 px de respiro deixam à
            vista o valor a pagar, que fica logo acima. Rolar até aqui
            escondendo quanto custa seria trocar um problema de enquadramento
            por outro.
          */}
          <div
            id={ID_DA_AREA_DE_PAGAMENTO}
            className="scroll-mt-20 bg-sutil border border-borda rounded-2xl p-4 sm:p-5 flex flex-col gap-4"
          >
            {imagemDoQr && (
              <div className="space-y-2 order-3 sm:order-1">
                {/*
                  O fundo do QR é branco literal, não a superfície do tema.
                  O código é preto sobre transparente: num tema escuro ele ficaria
                  preto sobre quase-preto e nenhum leitor de banco acha os módulos.
                  Esta é a imagem que faz o dinheiro entrar — ela não segue tema.

                  `aspect-square` com largura em porcentagem, e não medida fixa:
                  a proporção do QR não pode ser distorcida em tela nenhuma, e
                  num aparelho estreito (320 px) uma largura fixa de 200 px
                  encostaria nas bordas do cartão. O teto de 224 px existe
                  porque acima disso o QR só ocupa espaço — a leitura por outro
                  celular já é confortável nesse tamanho.
                */}
                <div className="flex justify-center">
                  <img
                    src={imagemDoQr}
                    alt={`QR Code do PIX de ${order.amountFormatted}`}
                    className="w-[74%] max-w-[240px] min-w-[176px] aspect-square object-contain rounded-xl border border-borda bg-white p-3"
                  />
                </div>
                <p className="text-[13px] text-suave leading-snug">
                  Está em outro aparelho? Aponte a câmera do app do banco para o QR Code.
                </p>
              </div>
            )}

            {/* A divisória é um elemento próprio (e não `border-t` no bloco do
                código) porque ela precisa ficar ENTRE os dois blocos nos dois
                layouts — e qual bloco vem primeiro muda com a tela. */}
            {imagemDoQr && <div className="border-t border-borda order-2" />}

            {/*
              O caminho de quem paga no mesmo celular. O rótulo existe para
              separar as duas formas de pagar: sem ele, o código parecia legenda
              do QR, e não uma segunda opção.
            */}
            <div className="space-y-3 order-1 sm:order-3">
              <div className="space-y-1">
                <p className="text-sm font-sans font-bold text-texto">Pix Copia e Cola</p>
                <p className="text-[13px] text-suave leading-snug">
                  Este é o código do seu PIX. Copie e cole no aplicativo do seu banco.
                </p>
              </div>

              {/*
                O código inteiro, sem rolagem interna.

                Antes havia `max-h-24 overflow-y-auto`: o código ficava cortado
                dentro de uma caixinha com barra de rolagem própria, que no
                celular é quase invisível e dá a impressão de que o código está
                incompleto. `break-all` quebra onde precisar e `select-all` faz
                um toque longo selecionar tudo de uma vez, que é a saída manual
                de quem estiver num navegador sem área de transferência.
              */}
              <div
                className="bg-superficie p-3 rounded-lg border border-borda text-[12px] sm:text-[13px] font-mono text-left leading-relaxed text-suave break-all select-all"
                aria-label="Código PIX copia e cola"
              >
                {pixCode}
              </div>

              {/*
                Verde e pulsando, como os outros botões de compra: é ele que
                conclui o pagamento, e na tela do PIX é a única ação que importa.

                O pulso para depois de copiado. O anel existe para dizer "aperte
                aqui"; continuar piscando depois de a pessoa já ter apertado é
                pedir de novo o que ela acabou de fazer.

                `min-h-[56px]`: alvo de toque confortável para dedo de pessoa
                mais velha, que é o público desta página.
              */}
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
                    <span>Copiar código</span>
                  </>
                )}
              </button>

              {/*
                A confirmação em texto, além da troca do rótulo do botão.

                `aria-live` porque quem usa leitor de tela não vê o botão mudar
                de cor: sem isto, apertar "Copiar" não produz retorno nenhum. E
                a faixa verde é o sinal que a pessoa mais velha reconhece como
                "deu certo, pode ir para o banco".
              */}
              {/*
                O aviso para leitor de tela fica SEMPRE no documento; o aviso
                visual aparece e some.

                Os dois separados porque cada um tem uma exigência que briga com
                a do outro. Uma região `aria-live` precisa já existir na página
                quando o texto muda — se ela nasce junto com a mensagem, ou
                estava em `display:none`, parte dos leitores não anuncia nada, e
                quem não enxerga aperta "Copiar" sem retorno nenhum. Já a faixa
                verde não pode ter espaço reservado: o vão guardado para ela
                abria um buraco permanente entre o botão e o prazo da chave.
                `sr-only` resolve os dois: fica no documento, não ocupa lugar.
              */}
              <p className="sr-only" role="status" aria-live="polite">
                {copied ? 'Código PIX copiado. Agora cole no aplicativo do seu banco.' : ''}
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

              {countdown && (
                <p className="text-[13px] text-suave text-center">
                  Esta chave expira em <strong className="text-texto">{countdown}</strong>
                </p>
              )}

              {/*
                AQUI JÁ HOUVE um aviso com o nome do recebedor ("na confirmação
                do banco aparece PRIME UNION TRADING FIN — é o processador
                oficial"), publicado e removido no mesmo dia, 14/08/2026, por
                decisão do dono: em vez de explicar o nome estranho, ele optou
                por trocar de gateway e fazer o problema não existir. Se o
                gateway novo também liquidar por conta de terceiro, o aviso
                está no histórico do git e o dado continua disponível em
                `order.pix.recebedor`, que o servidor segue extraindo de cada
                código exatamente para conferências assim.
              */}
            </div>
          </div>

          {/*
            O passo a passo, escrito para quem nunca pagou um PIX.

            Este público é adulto mais velho, comprando pelo celular, muitas
            vezes com pouca intimidade com aplicativo de banco. "Aponte a
            câmera" pressupõe que a pessoa sabe onde fica a câmera DENTRO do
            app do banco — e quem não sabe fica parada olhando a tela com o
            dinheiro na mão, querendo pagar.

            Numerado porque aqui a ordem é informação de verdade: são passos de
            um procedimento, e trocar a ordem não funciona. O passo de conferir
            os dados existe de propósito: é o que evita a pessoa achar depois
            que foi cobrada a mais.
          */}
          <div className="bg-superficie border border-borda rounded-2xl p-4 sm:p-5 text-left space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-sans font-bold text-texto">Nunca pagou com PIX? Siga estes passos</p>
              <p className="text-[13px] text-suave leading-snug">
                É mais simples do que parece — leva menos de um minuto.
              </p>
            </div>
            <ol className="space-y-3">
              {[
                {
                  titulo: 'Abra seu banco',
                  texto: <>Abra o <strong className="text-texto">aplicativo do seu banco</strong>, o mesmo que você usa normalmente.</>,
                },
                {
                  titulo: 'Entre no Pix',
                  texto: <>No aplicativo do banco, procure pela área <strong className="text-texto">Pix</strong>.</>,
                },
                {
                  titulo: 'Toque em Pagar',
                  texto: <>Toque na opção <strong className="text-texto">Pagar</strong>.</>,
                },
                {
                  titulo: 'Escolha Copia e Cola',
                  texto: <>Procure a opção <strong className="text-texto">Pix Copia e Cola</strong>.</>,
                },
                {
                  titulo: 'Copie o código',
                  texto: <>Volte para esta página e toque em <strong className="text-texto">Copiar código</strong> para copiar o código Pix.</>,
                },
                {
                  titulo: 'Cole no aplicativo do banco',
                  texto: <>Agora volte para o aplicativo do seu banco e <strong className="text-texto">cole o código</strong> no campo Pix Copia e Cola.</>,
                },
                {
                  titulo: 'Confirme o pagamento',
                  texto: (
                    <>
                      Confira os dados do pagamento — o valor é de{' '}
                      <strong className="text-texto">{order.amountFormatted}</strong> — e confirme a operação no seu banco.
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
            <p className="text-[12px] text-suave leading-snug border-t border-borda pt-3">
              Está no computador? Pegue o celular, abra o app do banco e leia o QR Code da tela.
            </p>
          </div>

          {/* O gateway trava a cobrança no CPF informado: se outra pessoa pagar,
              o PIX pode ser recusado e o estorno demora. */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-left text-[13px] text-amber-900 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              O pagamento precisa ser feito pelo CPF <strong>{order.customer.documentMasked}</strong>. Se outra pessoa pagar,
              o PIX é recusado automaticamente e o estorno pode levar até 48 horas.
            </span>
          </div>

          <div className="bg-superficie border border-borda rounded-xl p-3.5 space-y-2.5">
            <p className="text-xs text-texto font-semibold flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-ouro" />
              Aguardando a confirmação do seu PIX...
            </p>
            <p className="text-[13px] text-suave">
              A liberação é automática assim que o banco confirmar. Pode deixar esta tela aberta — não é preciso
              fazer mais nada.
            </p>
            {/* `min-h-[44px]`: media 42 px de altura e o dedo errava. Alvo de
                toque abaixo de 44 px é o limite conhecido, e aqui erra quem já
                pagou e só quer conferir. */}
            <button
              onClick={onCheckNow}
              disabled={isChecking}
              className="w-full min-h-[44px] py-2.5 px-4 bg-sutil border border-borda text-texto rounded-xl font-sans font-semibold text-xs flex items-center justify-center gap-2 hover:border-ouro transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Verificando...' : 'Já paguei — verificar agora'}</span>
            </button>
          </div>

          {/*
            A saída desta tela.

            Sem ela, quem gerava o PIX ficava preso: a única forma de mudar o
            pedido — tirar um bônus, corrigir o e-mail, pensar melhor — era
            fechar a página, e ao voltar caía de novo no mesmo código. Fechar a
            página é a decisão que não volta atrás; esta porta transforma isso
            em "mudar de ideia sobre o pedido", que volta.

            Discreta de propósito, embaixo de tudo: quem veio pagar não pode
            tropeçar nela antes do botão de copiar. Discreta na aparência, mas
            não no toque: o `min-h-[44px]` dá ao dedo a área de sempre sem
            engordar o texto, que continua pequeno para não competir com o botão
            de copiar.
          */}
          {onEditarPedido && (
            <button
              onClick={onEditarPedido}
              className="w-full min-h-[44px] text-[13px] text-suave underline underline-offset-2 hover:text-texto transition-colors cursor-pointer py-1"
            >
              Quero mudar meu pedido
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
