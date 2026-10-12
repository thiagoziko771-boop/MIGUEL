import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Lock, Mic, Square, Trash2 } from 'lucide-react';
import { emailPlausivel, sugestaoDeEmail } from '../lib/emailPlausivel';
import { maskPhone, onlyDigits } from '../lib/format';
import { HERO_DATA } from '../data/funnelData';

interface PedidoDeOracaoProps {
  onConcluir: (dados: { nome: string; email: string; telefone: string; pedido: string; temAudio: boolean }) => void;
  /**
   * Primeira tela do funil (fluxo direto `/pedido`, 15/08/2026): a arte do
   * Arcanjo fica atrás do cartão, com as mesmas camadas do hero — a pessoa
   * chega do anúncio e já está diante dele. Sem isto o cartão fica sobre o
   * fundo liso do tema, como no fluxo com capa própria.
   */
  comAnjoAtras?: boolean;
}

/**
 * Tela do fluxo "peça e será dado" (experimento local de 15/08/2026).
 *
 * A capa promete reciprocidade: "o que você tanto pede em oração, Miguel vai
 * te dar agora". Esta tela é onde a pessoa PEDE — escrevendo ou gravando o
 * próprio pedido — e deixa nome, e-mail e WhatsApp. Só depois vem o quiz.
 *
 * O que muda em relação ao funil normal: o contato nasce ANTES do checkout.
 * Hoje quem desiste no quiz é inalcançável; aqui todo mundo que passa desta
 * tela vira lead com e-mail e telefone — e um pedido de oração escrito por
 * ela mesma, que é o melhor material de recuperação que existe.
 *
 * O áudio é gravado no navegador (MediaRecorder) e fica SÓ na memória da
 * tela: não sobe para lugar nenhum nesta versão. É a prova de conceito do
 * gesto — a pessoa fala com Miguel — e o texto continua sendo o que vai para
 * o banco. Subir o áudio exige rota nova e armazenamento; fica para depois
 * de o dono aprovar o fluxo.
 *
 * AS CORES SÃO AS DA PALETA (superficie/sutil/borda/texto/ouro), e não
 * hexadecimais próprios: a primeira versão usava um preto genérico com caixa
 * amarela por cima e o dono achou feio — com razão, não era o mesmo tom da
 * oferta. Com os tokens do tema a tela fica IGUAL ao checkout, e ainda segue
 * o tema claro/escuro sozinha.
 */
const CLASSE_CAMPO =
  'w-full px-4 py-3.5 rounded-xl border border-borda bg-sutil text-lg text-texto ' +
  'placeholder-suave/60 focus:outline-none focus:border-ouro focus:bg-superficie transition-colors';

export const PedidoDeOracao: React.FC<PedidoDeOracaoProps> = ({ onConcluir, comAnjoAtras = false }) => {
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [pedido, setPedido] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const [gravando, setGravando] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [segundos, setSegundos] = useState(0);
  const gravador = useRef<MediaRecorder | null>(null);
  const pedacos = useRef<Blob[]>([]);
  const relogio = useRef<number | null>(null);

  const suportaAudio = typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    return () => {
      if (relogio.current) window.clearInterval(relogio.current);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const comecarGravacao = async () => {
    setErro(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      pedacos.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) pedacos.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(pedacos.current, { type: rec.mimeType || 'audio/webm' });
        setAudioUrl(URL.createObjectURL(blob));
      };
      gravador.current = rec;
      rec.start();
      setGravando(true);
      setSegundos(0);
      relogio.current = window.setInterval(() => setSegundos((s) => s + 1), 1000);
    } catch {
      setErro('Não consegui acessar o microfone. Você pode escrever o seu pedido no campo acima.');
    }
  };

  const pararGravacao = () => {
    gravador.current?.stop();
    setGravando(false);
    if (relogio.current) window.clearInterval(relogio.current);
  };

  // 2 minutos é bastante para um pedido; sem teto a gravação seguiria até a
  // pessoa esquecer, e um blob de 20 min travaria o celular.
  useEffect(() => {
    if (gravando && segundos >= 120) pararGravacao();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segundos, gravando]);

  const apagarAudio = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    setSegundos(0);
  };

  const confirmar = (event: React.FormEvent) => {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    if (nome.trim().length < 2) {
      setErro('Escreva o seu nome — é em nome dele que a oração é feita.');
      return;
    }
    if (!emailPlausivel(email)) {
      const sugestao = sugestaoDeEmail(email);
      setErro(sugestao ? `Confira o e-mail. Você quis dizer ${sugestao}?` : 'Confira o e-mail — parece incompleto.');
      return;
    }
    if (onlyDigits(telefone).length < 10) {
      setErro('Informe o seu WhatsApp com DDD — é por ele que Miguel te responde.');
      return;
    }
    if (pedido.trim().length < 5 && !audioUrl) {
      setErro('Conte o seu pedido: escreva ou grave um áudio. Miguel precisa saber o que você pede.');
      return;
    }
    setErro(null);
    onConcluir({ nome: nome.trim(), email: email.trim(), telefone: onlyDigits(telefone), pedido: pedido.trim(), temAudio: !!audioUrl });
  };

  const mmss = `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, '0')}`;

  return (
    <section className={`relative w-full flex-1 flex flex-col items-center justify-center py-6 px-4 ${comAnjoAtras ? 'min-h-[100svh]' : ''}`}>
      {comAnjoAtras && (
        <div className="absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
          <img src={HERO_DATA.imageUrl} alt="" className="w-full h-full object-cover object-top" />
          {/* As mesmas camadas do hero: véu, vinheta e degradê pesado embaixo, para
              o cartão assentar sobre a parte escura e o rosto continuar visível. */}
          <div className="absolute inset-0 bg-[#131313]/40" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(19,19,19,0.55)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-[78%] bg-gradient-to-t from-[#131313] via-[#131313]/85 to-transparent" />
        </div>
      )}
      <div className={`relative z-10 w-full max-w-md sm:max-w-lg mx-auto bg-superficie border border-borda rounded-2xl p-4 sm:p-6 shadow-md space-y-5 text-left ${comAnjoAtras ? 'mt-[36svh] bg-superficie/95 backdrop-blur-sm' : ''}`}>
        <div className="space-y-2">
          <span className="text-xs font-sans uppercase tracking-widest text-ouro font-bold block">
            Peça, e lhe será dado. 🙏
          </span>
          <h2 className="font-sans font-bold text-xl sm:text-2xl text-texto leading-snug">
            Faça seu pedido de oração.
          </h2>
          <p className="text-base text-suave leading-relaxed">
            Escreva o que sente no coração e o que você precisa. O que você tanto pede em oração será levado em seu nome.
          </p>
        </div>

        <form onSubmit={confirmar} className="space-y-4">
          <div className="space-y-2.5">
            <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider block">
              1. Em nome de quem é este pedido
            </label>
            <input
              type="text"
              placeholder="Seu nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              autoComplete="name"
              className={CLASSE_CAMPO}
            />
            <input
              type="email"
              placeholder="Seu e-mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className={CLASSE_CAMPO}
            />
            <input
              type="tel"
              placeholder="Seu WhatsApp com DDD"
              value={telefone}
              onChange={(e) => setTelefone(maskPhone(e.target.value))}
              inputMode="numeric"
              autoComplete="tel"
              className={CLASSE_CAMPO}
            />
          </div>

          <div className="space-y-2.5 pt-2 border-t border-borda">
            <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider block">
              2. Seu pedido de oração
            </label>
            <textarea
              placeholder="Escreva aqui o que sente no coração e o que você precisa..."
              value={pedido}
              onChange={(e) => setPedido(e.target.value.slice(0, 600))}
              rows={4}
              className={`${CLASSE_CAMPO} resize-none leading-relaxed`}
            />

            {suportaAudio && (
              <div className="space-y-2">
                <p className="text-[13px] text-suave">Ou, se preferir, grave o seu pedido em áudio:</p>
                {!audioUrl && !gravando && (
                  <button
                    type="button"
                    onClick={() => void comecarGravacao()}
                    className="w-full min-h-[48px] rounded-xl border border-borda bg-sutil text-texto font-sans font-semibold text-sm flex items-center justify-center gap-2 hover:border-ouro transition-colors cursor-pointer"
                  >
                    <Mic className="w-4 h-4 text-ouro" /> Gravar meu pedido
                  </button>
                )}
                {gravando && (
                  <button
                    type="button"
                    onClick={pararGravacao}
                    className="w-full min-h-[48px] rounded-xl bg-red-50 border border-red-200 text-red-800 font-sans font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Square className="w-4 h-4 animate-pulse" /> Gravando {mmss} — toque para parar
                  </button>
                )}
                {audioUrl && (
                  <div className="flex items-center gap-2">
                    <audio src={audioUrl} controls className="flex-1 h-10" />
                    <button
                      type="button"
                      onClick={apagarAudio}
                      aria-label="Apagar áudio"
                      className="min-w-[44px] min-h-[44px] rounded-xl border border-borda bg-sutil text-suave flex items-center justify-center hover:text-texto cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {erro && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {erro}
            </p>
          )}

          <button
            type="submit"
            className="btn-dourado halo-dourado pulso-de-abertura w-full min-h-[56px] px-8 py-4 rounded-full font-work font-semibold text-sm text-sobre-ouro uppercase tracking-[0.08em] hover:scale-[1.02] active:scale-95 transition-transform duration-300 flex items-center justify-center gap-2 cursor-pointer"
          >
            Entregar meu pedido ao Arcanjo Miguel
            <ArrowRight className="w-5 h-5" strokeWidth={2.5} />
          </button>

          <p className="text-[13px] text-suave flex items-center justify-center gap-1.5 pt-1">
            <Lock className="w-3.5 h-3.5 text-emerald-600" />
            Seu pedido é tratado com respeito e privacidade.
          </p>
        </form>
      </div>
    </section>
  );
};
