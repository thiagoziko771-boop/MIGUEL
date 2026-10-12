import React, { useState } from 'react';
import { ArrowRight, Lock } from 'lucide-react';

interface CadastroRapidoProps {
  onConcluir: (nome: string, nascimento: string) => void;
}

/**
 * Tela do fluxo curto do anúncio do dinheiro (experimento de 14/08/2026).
 *
 * Substitui as nove perguntas do quiz para quem chegou pela capa "dinheiro":
 * nome e data de nascimento, e só. A narrativa é a da verificação — o botão
 * diz "verificar meu merecimento" porque a tela seguinte é a análise, que
 * termina com a pessoa sendo chamada pelo nome e declarada escolhida na
 * oferta. Sem o nome, essa história não existe.
 *
 * Segue o tema escuro do hero e da análise de propósito: a pessoa saiu de uma
 * arte escura e vai cair noutra — um formulário claro no meio quebraria o
 * clima cinematográfico que as duas pontas constroem.
 *
 * Os campos têm 16px+ de fonte pela mesma razão do checkout: abaixo disso o
 * Safari do iPhone dá zoom sozinho no foco e a tela salta (ver CLASSE_CAMPO
 * em InlineCheckout.tsx).
 */
const CLASSE_CAMPO_ESCURO =
  'w-full px-4 py-3.5 rounded-xl border border-[#f2ca50]/30 bg-[#1d1c1a] text-lg text-[#e5e2e1] ' +
  'placeholder-[#d0c5af]/50 focus:outline-none focus:border-[#f2ca50] transition-colors';

/** Dígitos digitados -> DD/MM/AAAA, progressivamente. */
function mascaraDeData(valor: string): string {
  const digitos = valor.replace(/\D/g, '').slice(0, 8);
  if (digitos.length <= 2) return digitos;
  if (digitos.length <= 4) return `${digitos.slice(0, 2)}/${digitos.slice(2)}`;
  return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4)}`;
}

function dataPlausivel(texto: string): boolean {
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  if (!partes) return false;
  const dia = Number(partes[1]);
  const mes = Number(partes[2]);
  const ano = Number(partes[3]);
  return dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && ano >= 1915 && ano <= 2015;
}

export const CadastroRapido: React.FC<CadastroRapidoProps> = ({ onConcluir }) => {
  const [nome, setNome] = useState('');
  const [nascimento, setNascimento] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const confirmar = (event: React.FormEvent) => {
    event.preventDefault();

    // Mesmo cuidado do checkout: solta o teclado para a próxima tela nascer
    // com a janela inteira.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    if (nome.trim().length < 2) {
      setErro('Escreva o seu nome — é em nome dele que a mensagem é preparada.');
      return;
    }
    if (!dataPlausivel(nascimento)) {
      setErro('Confira a data de nascimento: dia, mês e ano completos (por exemplo, 05/03/1968).');
      return;
    }
    setErro(null);
    onConcluir(nome.trim(), nascimento);
  };

  return (
    <section className="relative min-h-[100svh] w-full flex flex-col items-center justify-center bg-[#131313] px-6 py-10">
      <div className="w-full max-w-md flex flex-col items-center text-center">
        <h1
          className="font-caslon font-bold text-[clamp(1.75rem,8vw,2.25rem)] leading-[1.2] text-[#f2ca50] mb-3"
          style={{ filter: 'drop-shadow(0 0 15px rgba(233,195,73,0.3))' }}
        >
          Antes de ouvir, Miguel precisa saber quem é você.
        </h1>

        <p
          className="font-work font-medium text-lg leading-7 text-[#f2efe9] mb-8"
          style={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
        >
          Escreva seu nome e sua data de nascimento. A verificação é feita em seu nome.
        </p>

        <form onSubmit={confirmar} className="w-full space-y-3.5 text-left">
          <input
            type="text"
            placeholder="Seu nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            autoComplete="name"
            className={CLASSE_CAMPO_ESCURO}
          />
          <input
            type="text"
            placeholder="Data de nascimento (DD/MM/AAAA)"
            value={nascimento}
            onChange={(e) => setNascimento(mascaraDeData(e.target.value))}
            inputMode="numeric"
            autoComplete="bday"
            className={CLASSE_CAMPO_ESCURO}
          />

          {erro && (
            <p className="text-sm leading-snug text-[#ffb4a8] bg-[#3a1510] border border-[#7a2e22] rounded-lg px-3 py-2.5">
              {erro}
            </p>
          )}

          <button
            type="submit"
            className="btn-dourado halo-dourado pulso-de-abertura w-full min-h-[56px] px-8 py-4 rounded-full font-work font-semibold text-sm text-[#241a00] uppercase tracking-[0.08em] hover:scale-[1.02] active:scale-95 transition-transform duration-300 flex items-center justify-center gap-2 cursor-pointer"
          >
            Verificar meu merecimento
            <ArrowRight className="w-5 h-5" strokeWidth={2.5} />
          </button>
        </form>

        <p className="font-work text-sm text-[#d0c5af]/80 mt-4 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" />
          Usado apenas para preparar a sua oração.
        </p>
      </div>
    </section>
  );
};
