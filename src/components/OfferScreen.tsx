import React, { useEffect, useRef, useState } from 'react';
import * as m from 'motion/react-m';
import confetti from 'canvas-confetti';
import { ShieldCheck, Sparkles, Star, HeartHandshake, CheckCircle2, ArrowRight } from 'lucide-react';
import { OFFER_DATA } from '../data/funnelData';
import { lerCadastroRapido, primeiroNome } from '../lib/cadastroRapido';
import { rastrear } from '../lib/rastreio';
import { temPedidoGuardado } from '../lib/pedidoGuardado';
import { Button } from './Button';
import { InlineCheckout } from './InlineCheckout';
import { ProvaSocial } from './ProvaSocial';

/**
 * Segundos de espera antes de o botão de compra aparecer.
 *
 * Zero significa sempre visível. `?cta=<segundos>` sobrescreve, para conferir
 * a tela sem esperar. Cuidado com o ausente: get() devolve null e Number(null)
 * é 0, não NaN, e sem essa checagem todo cliente cairia em espera zero.
 */
function segundosDeEspera(): number {
  const bruto = new URLSearchParams(window.location.search).get('cta');
  const pedido = bruto === null || bruto.trim() === '' ? Number.NaN : Number(bruto);
  return Number.isFinite(pedido) && pedido >= 0 ? pedido : OFFER_DATA.segundosAteOCta;
}

/** Alguém digitou `?cta=` na URL? Então quem manda é o parâmetro, não a memória. */
function esperaVeioDaUrl(): boolean {
  const bruto = new URLSearchParams(window.location.search).get('cta');
  if (bruto === null || bruto.trim() === '') return false;
  return Number.isFinite(Number(bruto)) && Number(bruto) >= 0;
}

/*
 * Quem já cumpriu a espera uma vez não a cumpre de novo.
 *
 * A pessoa que assistiu até o botão aparecer JÁ OUVIU a oferta e o preço — é
 * exatamente para isso que a espera existe. Fazê-la esperar 4 minutos outra vez
 * na segunda visita não protege nada: só cobra pedágio de quem já pagou, e de
 * quem tem a maior chance de comprar, porque voltou. Não ter comprado ontem não
 * quer dizer que não compra hoje.
 *
 * A marca é gravada no momento em que o botão APARECE, nunca quando a tela
 * abre. Essa distinção é o que separa isto do relógio em sessionStorage que
 * existiu aqui antes e foi removido: aquele guardava o INÍCIO da contagem, e
 * como recarregar a página faz refazer o quiz, o tempo corria durante a refeita
 * e o botão surgia antes de o vídeo dizer o preço. Guardando só o fato
 * consumado, isso não acontece.
 *
 * Se a VSL ou o preço mudarem de verdade, troque o nome desta chave: as marcas
 * antigas viram lixo ignorado e todo mundo assiste à oferta nova por inteiro.
 *
 * v1 -> v2 em 10/08/2026, na troca da VSL 97ib3ki0q3 ("VSL 47") pela a78m863q0a
 * ("VLS CERTA ESCALA"). Sem virar a chave, quem já tinha visto o botão no vídeo
 * ANTIGO cairia direto no botão de compra sem ouvir uma palavra do novo — e a
 * espera existe justamente para ninguém chegar ao checkout sem ter ouvido a
 * oferta e o preço.
 */
const CHAVE_CTA_VISTO = 'rezas_sagradas.cta_visto.v2';

function jaCumpriuAEspera(): boolean {
  try {
    return window.localStorage.getItem(CHAVE_CTA_VISTO) !== null;
  } catch {
    // Navegação privada ou storage bloqueado: segue a espera normal.
    return false;
  }
}

function marcarEsperaCumprida(): void {
  try {
    window.localStorage.setItem(CHAVE_CTA_VISTO, new Date().toISOString());
  } catch {
    // Sem storage não há memória, e a espera de sempre continua valendo.
  }
}

/** Quanto falta da espera, em milissegundos, medido contra o relógio real. */
function faltamMs(espera: number, inicio: number): number {
  return espera * 1000 - (Date.now() - inicio);
}

export const OfferScreen: React.FC = () => {
  /*
   * Já nasce aberto para quem tem pedido esperando.
   *
   * Essa pessoa não precisa ser convencida de novo: ela já viu a VSL, escolheu
   * o que queria e gerou o PIX. Fazê-la assistir ao vídeo e apertar de novo o
   * botão de comprar para reencontrar o próprio código seria cobrar duas vezes
   * a mesma decisão. É também o que faz a mensagem de recuperação chegar a
   * alguém: sem isto ela existiria abaixo de um checkout fechado.
   */
  /*
   * `?checkout=1` abre a tela JÁ com o checkout aberto e rola até ele — é o
   * link que o dono manda por WhatsApp para quem quer pagar e escolher os
   * bônus sem passar pela VSL de novo (pedido de 15/08/2026, caso Ricardo).
   * Só vale para quem digita a URL; ninguém do funil cai aqui.
   */
  const [abrirDiretoNoCheckout] = useState(() => {
    const bruto = new URLSearchParams(window.location.search).get('checkout');
    return bruto === '1' || bruto === 'true';
  });
  const [showOfferDetails, setShowOfferDetails] = useState(() => temPedidoGuardado() || abrirDiretoNoCheckout);

  useEffect(() => {
    if (!abrirDiretoNoCheckout) return;
    // Duas passadas: a primeira antes de o player reservar altura, a segunda
    // depois — a mesma razão das três tentativas do PixPanel.
    const relogios = [200, 900].map((atraso) =>
      window.setTimeout(() => {
        document.getElementById('offer-details-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, atraso),
    );
    return () => relogios.forEach((r) => window.clearTimeout(r));
  }, [abrirDiretoNoCheckout]);
  const [espera] = useState(segundosDeEspera);
  /*
   * A contagem nasce aqui, na montagem desta tela — ou seja, no instante em
   * que a etapa da VSL entra, e não quando a pessoa abriu o site.
   *
   * Antes o início ficava guardado no sessionStorage para sobreviver a um
   * recarregamento. A intenção era boa, mas na prática só atrapalhava: o passo
   * do funil não é persistido, então quem recarrega volta para a primeira tela
   * e refaz o quiz inteiro. O relógio antigo continuava correndo durante essa
   * refeita, e quando a pessoa chegava de novo na VSL a espera inteira já tinha
   * passado — o botão de compra aparecia de cara, antes de o vídeo dizer o
   * preço, que é exatamente o que a espera existe para impedir.
   *
   * Com o início na montagem, cada entrada na VSL conta o seu próprio tempo.
   */
  const [inicio] = useState(() => Date.now());
  /*
   * Já nasce liberado em três casos: sem espera configurada, com `?cta=0`, ou
   * para quem já cumpriu a espera numa visita anterior. Nascer liberado (em vez
   * de liberar logo depois) evita a mensagem "assista ao vídeo" piscar por um
   * quadro antes de o botão entrar.
   *
   * O `?cta=` vence a memória de propósito: ele é a ferramenta de conferir a
   * tela, e uma ferramenta que responde diferente conforme o que está guardado
   * no navegador de quem testa não serve para conferir nada — inclusive para a
   * bateria scripts/testar-cta.mjs.
   */
  const [ctaLiberado, setCtaLiberado] = useState(
    () => espera <= 0 || (!esperaVeioDaUrl() && jaCumpriuAEspera()),
  );

  /*
   * A espera existe para o botão não aparecer antes de o vídeo explicar a
   * oferta e o preço. Com espera zero ele já nasce visível e este efeito nem
   * chega a agendar nada.
   *
   * A contagem é de tempo de tela, não de vídeo assistido: começa quando esta
   * etapa entra, mesmo que a pessoa demore a apertar o play. É de propósito —
   * amarrar a espera ao progresso do vídeo deixaria o botão fora do alcance de
   * quem só quer comprar, e quem pausa no meio já esperou o tempo de qualquer
   * forma.
   *
   * O relógio é conferido contra o horário de início, e não confiado a um
   * setTimeout só: aba em segundo plano tem os timers atrasados ou suspensos,
   * então o disparo pode chegar tarde. Conferindo o horário, ao voltar para a
   * aba o botão aparece na hora se o tempo real já passou.
   */
  useEffect(() => {
    if (ctaLiberado) return;

    let relogio = 0;
    const conferir = () => {
      const faltam = faltamMs(espera, inicio);
      if (faltam <= 0) {
        setCtaLiberado(true);
        /*
         * A marca é gravada AQUI, no instante em que o botão aparece — e não na
         * montagem da tela. Quem chegou até este ponto ouviu a oferta e o preço
         * inteiros; na próxima visita o botão já a espera pronto.
         *
         * Com `?cta=` na URL não se grava nada: aquilo é conferência de tela, e
         * marcar a espera como cumprida a partir de um atalho de teste sujaria
         * o navegador de quem só queria olhar a página.
         */
        if (!esperaVeioDaUrl()) marcarEsperaCumprida();
        return;
      }
      // Nunca dorme mais que meio minuto: se o navegador atrasar o disparo,
      // a conferência seguinte corrige em vez de esperar indefinidamente.
      relogio = window.setTimeout(conferir, Math.min(faltam, 30_000));
    };
    conferir();

    const aoVoltarParaAba = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(relogio);
        conferir();
      }
    };
    document.addEventListener('visibilitychange', aoVoltarParaAba);

    return () => {
      window.clearTimeout(relogio);
      document.removeEventListener('visibilitychange', aoVoltarParaAba);
    };
  }, [espera, inicio, ctaLiberado]);

  /*
   * Até onde cada pessoa assiste a VSL.
   *
   * A MAIOR PERDA DO FUNIL ACONTECE NESTA TELA E ERA CEGA: 87% de quem chega
   * aqui não gera PIX, e não havia como saber se saíam nos primeiros quinze
   * segundos ou já perto do fim. Os dois casos pedem consertos opostos — um é o
   * gancho do vídeo, o outro é a oferta — e sem o número a escolha seria palpite.
   *
   * O MARCO QUE DECIDE É 242 s: é quando o vídeo diz o preço e o botão de
   * compra nasce. Quem não chega lá nunca viu a oferta, e contar essa pessoa
   * como "viu e não quis" é ler o funil errado.
   *
   * Marcos esparsos, e cada um uma vez só: o evento vai para o nosso banco a
   * cada degrau vencido, não a cada segundo. Este público está em rede de
   * operadora, e um aviso por segundo seria mais tráfego que o próprio vídeo.
   */
  useEffect(() => {
    const player = document.querySelector('wistia-player');
    if (!player) return;

    const MARCOS = [10, 30, 60, 120, 180, 242, 300, 360];
    const vistos = new Set<number>();

    const aoAvancar = () => {
      /*
       * O tempo vem do próprio elemento, não do `detail` do evento: `currentTime`
       * é a fonte que a Wistia mantém atualizada e não depende do formato do
       * payload, que muda entre versões do player sem aviso.
       */
      const segundos = Math.floor(Number((player as unknown as { currentTime?: number }).currentTime ?? 0));
      if (!Number.isFinite(segundos)) return;

      for (const marco of MARCOS) {
        if (segundos >= marco && !vistos.has(marco)) {
          vistos.add(marco);
          rastrear('MarcoDaVSL', { step: 13, segundosDaVSL: marco });
        }
      }
    };

    /*
     * `second-change`, COM HÍFEN. O nome sem hífen (`secondchange`, o da API
     * antiga da Wistia) não existe neste player: o listener era registrado, o
     * vídeo tocava, e nada era medido — silêncio idêntico ao de "ninguém
     * assiste". Descoberto interceptando `dispatchEvent` no elemento e listando
     * o que passava por ele; se um dia a medição secar, é assim que se confere.
     *
     * Dispara uma vez por segundo de vídeo assistido, e só enquanto ele toca —
     * pausa não conta, que é o certo: o que se mede é quanto da mensagem chegou.
     */
    player.addEventListener('second-change', aoAvancar);
    return () => player.removeEventListener('second-change', aoAvancar);
  }, []);

  /*
   * Quando a espera acaba, a página rola sozinha até o botão.
   *
   * Sem isso o botão nasce fora da tela: a VSL é 9:16 e no celular ocupa a
   * altura toda, então o momento em que a espera termina não acontece em
   * lugar nenhum que a pessoa esteja olhando. Ela segue assistindo sem saber
   * que já pode comprar.
   *
   * `block: 'center'` em vez de rolar o mínimo: deixa o botão no meio da tela,
   * com um pedaço do vídeo ainda visível acima. Rolar o mínimo encostaria o
   * botão na borda de baixo, que é justo onde o polegar tampa no celular.
   *
   * Três guardas antes de mexer na página de alguém:
   *   - `espera <= 0`: com `?cta=0` o botão já nasce junto com a tela, e rolar
   *     aí seria arrastar a página de quem acabou de chegar.
   *   - `showOfferDetails`: se o checkout já está aberto, quem manda na rolagem
   *     é o handleUnlockOffer, e duas rolagens brigando dão solavanco.
   *   - `prefers-reduced-motion`: vai direto, sem animar.
   *
   * O atraso curto deixa a animação de entrada começar antes: o botão aparece
   * e só então a página o traz, em vez de rolar até um espaço ainda vazio.
   */
  const ctaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctaLiberado || espera <= 0 || showOfferDetails) return;

    const semAnimacao = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const atraso = window.setTimeout(() => {
      ctaRef.current?.scrollIntoView({
        behavior: semAnimacao ? 'auto' : 'smooth',
        block: 'center',
      });
    }, 250);

    return () => window.clearTimeout(atraso);
  }, [ctaLiberado, espera, showOfferDetails]);

  useEffect(() => {
    // Launch celebratory golden confetti on screen enter
    try {
      confetti({
        particleCount: 70,
        spread: 60,
        origin: { y: 0.6 },
        colors: ['#D4AF37', '#C59B27', '#E9C455', '#FFFFFF']
      });
    } catch (e) {
      // fallback ignore if confetti unavailable
    }
  }, []);

  const handleUnlockOffer = () => {
    // O checkout abrindo é o sinal mais forte antes do formulário: quem clica
    // aqui já decidiu ver o preço. É o evento que o Meta usa para achar mais
    // gente parecida com quem compra, e não com quem só assiste.
    rastrear('InitiateCheckout', { step: 13, contentIds: ['main'] });
    setShowOfferDetails(true);
    setTimeout(() => {
      document.getElementById('offer-details-section')?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  return (
    <m.div 
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="w-full max-w-md mx-auto py-4 px-4 space-y-6"
    >
      {/* Avisos de compra — nomes FICTÍCIOS, ver o cabeçalho de ProvaSocial.tsx */}
      <ProvaSocial ativo={showOfferDetails} />

      {/*
        Top Banner Badge.

        Quem deixou o nome no fluxo curto (anúncio do dinheiro) é recebida
        pelo nome e declarada ESCOLHIDA — é o fecho da história que começou na
        "análise de merecimento". Para o quiz completo não há nome guardado e
        o casal padrão de frases continua.
      */}
      <div className="bg-superficie border border-borda rounded-xl p-4 text-center shadow-xs">
        {(() => {
          const nome = primeiroNome(lerCadastroRapido()?.nome ?? '');
          const titulo = nome === '' ? OFFER_DATA.badgeTitle : `Parabéns, ${nome}!`;
          const subtitulo =
            nome === ''
              ? OFFER_DATA.badgeSubtitle
              : 'Sua análise foi concluída: você foi escolhida para receber esta oração.';
          return (
            <>
              <span className="font-sans font-bold text-texto text-xl block tracking-tight">{titulo}</span>
              <span className="font-sans font-semibold text-ouro text-sm sm:text-base block mt-0.5">
                {subtitulo}
              </span>
            </>
          );
        })()}
      </div>

      {/* Main Headline */}
      <div className="text-center space-y-2">
        <h1 className="font-sans font-bold text-2xl sm:text-3xl text-texto leading-tight">
          A oração secreta do{" "}
          <span className="text-ouro underline decoration-ouro/40 underline-offset-4">
            Arcanjo Miguel
          </span>{" "}
          foi liberada para você.
        </h1>
        <p className="font-sans text-base text-suave leading-relaxed">
          {OFFER_DATA.subheadline}
        </p>
      </div>

      {/*
        VSL.

        O vídeo começa parado, no botão de play da própria Wistia. Antes ele
        vinha do painel com autoplay mudo e "clique para ouvir": tocava sozinho
        sem som, e o único controle era um ícone de alto-falante pequeno no
        canto. Quem chegava aqui procurava um play, não achava, e saía achando
        que o vídeo tinha quebrado.

        Os atributos vêm no código, e não do painel, porque é o funil que
        depende deles: mexer no painel mudaria a página sem passar por commit.
      */}
      <div className="w-full rounded-2xl overflow-hidden border border-borda shadow-lg bg-black">
        <wistia-player
          media-id="a78m863q0a"
          aspect="0.5625"
          autoplay="false"
          silent-autoplay="false"
          muted="false"
          big-play-button="true"
        ></wistia-player>
      </div>

      {/*
        Antes da hora não há nada abaixo do vídeo — nem aviso, nem cadeado.
        Removido por decisão do dono em 08/08/2026.

        A frase que existia aqui ("o botão aparece aqui em seguida") anunciava a
        espera, e anunciar a espera faz a pessoa vigiar o espaço vazio em vez de
        assistir. O que ela protegia era outra coisa: quem chega e não vê botão
        nenhum pode achar que a página quebrou. Se aparecer relato disso, é aqui
        que se resolve — de preferência com uma frase que não fale em botão nem
        em tempo.
      */}

      {/* CTA Button directly below VSL */}
      {!showOfferDetails && ctaLiberado && (
        <m.div
          ref={ctaRef}
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="pt-1"
        >
          <Button
            onClick={handleUnlockOffer}
            variant="comprar"
            fullWidth
            icon={<ArrowRight className="w-5 h-5 ml-1" />}
          >
            SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA
          </Button>
          {/* Era "Clique acima para liberar o checkout e os bônus" — linguagem de
              loja, trocada em 15/08 a pedido do dono pela voz da oferta. */}
          <p className="text-center text-base sm:text-lg font-semibold text-texto leading-snug mt-3 flex items-start justify-center gap-1.5 px-2">
            <Sparkles className="w-4 h-4 text-ouro flex-shrink-0 mt-1" />
            <span>
              Miguel veio até você por um motivo: ele vai destravar bênçãos na sua vida.{' '}
              <span className="text-ouro">Não deixe para depois.</span>
            </span>
          </p>
        </m.div>
      )}

      {/*
        Checkout revelado abaixo do vídeo, com rolagem até ele.

        Chegou a ser uma camada por cima da VSL (o vídeo seguia tocando atrás),
        e foi revertido a pedido do dono em 08/08/2026. Se um dia voltar a ideia,
        o que fazia aquilo valer era um detalhe só: o `<wistia-player>` não podia
        ser desmontado, senão o vídeo parava e recomeçava do zero.
      */}
      {showOfferDetails && (
        <m.div
          id="offer-details-section"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="space-y-6 pt-2"
        >
          {/* Embedded Checkout with Order Bumps */}
          <InlineCheckout />

          {/* Guarantee Badge */}
          <div className="bg-sutil p-4 rounded-xl border border-borda text-xs text-suave text-center space-y-1">
            <div className="flex items-center justify-center gap-1.5 font-bold text-texto">
              <ShieldCheck className="w-5 h-5 text-ouro" />
              <span className="text-sm">Garantia Incondicional de 30 Dias</span>
            </div>
            <p>{OFFER_DATA.guaranteeText}</p>
          </div>

          {/* Customer Reviews & Social Proof */}
          <div className="space-y-4 pt-2">
            <h3 className="font-sans font-bold text-lg text-texto text-center flex items-center justify-center gap-2">
              <HeartHandshake className="w-5 h-5 text-ouro" />
              Relatos Recentes de Fiéis Abençoados
            </h3>

            <div className="space-y-3">
              {OFFER_DATA.writtenTestimonials.map((review, idx) => (
                <div 
                  key={idx} 
                  className="bg-superficie border border-borda rounded-xl p-4 space-y-2 shadow-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {review.avatarUrl && (
                        <img 
                          src={review.avatarUrl} 
                          alt={review.name} 
                          className="w-10 h-10 rounded-full object-cover border border-borda shadow-2xs"
                        />
                      )}
                      <div>
                        <p className="font-sans font-semibold text-sm text-texto">
                          {review.name}
                        </p>
                        <p className="text-[13px] text-suave">
                          {review.city}
                        </p>
                      </div>
                    </div>
                    <div className="flex text-ouro">
                      {Array.from({ length: review.stars }).map((_, i) => (
                        <Star key={i} className="w-3.5 h-3.5 fill-ouro text-ouro" />
                      ))}
                    </div>
                  </div>

                  <p className="text-xs sm:text-sm text-texto font-sans leading-relaxed pt-1">
                    "{review.text}"
                  </p>

                  <p className="text-[12px] text-suave text-right font-medium">
                    {review.time}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </m.div>
      )}
    </m.div>
  );
};
