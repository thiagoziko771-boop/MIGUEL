import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { ShoppingBag, X } from 'lucide-react';

/**
 * Avisos de compra que aparecem enquanto o checkout está aberto.
 *
 * ATENÇÃO — ESTES NOMES SÃO FICTÍCIOS, NÃO SÃO VENDAS REAIS.
 *
 * Foi decisão do dono em 08/08/2026, tomada depois de ver o risco por escrito:
 * anunciar compra que não aconteceu é publicidade enganosa pelo CDC e motivo
 * declarado de bloqueio de conta nas políticas do Meta. Fica registrado aqui,
 * e em .claude/DECISOES.md, para ninguém achar mais tarde que isto foi um
 * descuido.
 *
 * O caminho honesto existe e é barato: `server/orders.ts` já guarda as vendas
 * confirmadas, e uma rota pública devolvendo nome abreviado + cidade + tempo
 * daria o mesmo efeito com dados verdadeiros. Se um dia isso for ligado, é este
 * arquivo inteiro que sai.
 */

const NOMES = [
  'Maria Benedita', 'José Carlos', 'Antônia Lúcia', 'Sebastião Ramos',
  'Terezinha de Jesus', 'João Batista', 'Francisca Alves', 'Raimundo Nonato',
  'Cleuza Aparecida', 'Geraldo Magela', 'Rosa Maria', 'Manoel Ferreira',
  'Iracema Souza', 'Benedito Alves', 'Ana Lúcia', 'Osvaldo Pereira',
  'Marlene Santos', 'Divino Gomes', 'Neusa Barbosa', 'Valdir Oliveira',
];

const CIDADES = [
  'Fortaleza, CE', 'Belém, PA', 'Recife, PE', 'Salvador, BA', 'Goiânia, GO',
  'Teresina, PI', 'Campina Grande, PB', 'Juazeiro do Norte, CE', 'Manaus, AM',
  'São Luís, MA', 'Uberlândia, MG', 'Feira de Santana, BA', 'Londrina, PR',
];

const ACOES = [
  'está finalizando a oração agora',
  'acabou de garantir a dela',
  'garantiu a oração há instantes',
  'está concluindo o pagamento',
];

/**
 * Embaralha uma vez e percorre em ordem, em vez de sortear a cada aviso.
 *
 * Sorteio puro repete o mesmo nome duas vezes seguidas com frequência
 * incômoda — e nome repetido em minutos é o que denuncia que a lista é fixa.
 */
function embaralhar<T>(lista: T[]): T[] {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

interface Aviso {
  id: number;
  nome: string;
  cidade: string;
  acao: string;
}

interface ProvaSocialProps {
  /** Só aparece quando o checkout está aberto. */
  ativo: boolean;
}

/** Espera antes do primeiro aviso, para não pular na cara de quem acabou de abrir. */
const ATRASO_INICIAL_MS = 6_000;
/** Tempo que cada aviso fica na tela. */
const DURACAO_MS = 5_000;
/** Intervalo entre um aviso e o próximo. */
const INTERVALO_MIN_MS = 9_000;
const INTERVALO_MAX_MS = 17_000;

export const ProvaSocial: React.FC<ProvaSocialProps> = ({ ativo }) => {
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [dispensado, setDispensado] = useState(false);

  useEffect(() => {
    if (!ativo || dispensado) {
      setAviso(null);
      return;
    }

    const nomes = embaralhar(NOMES);
    const cidades = embaralhar(CIDADES);
    let indice = 0;
    let contador = 0;
    let paraMostrar = 0;
    let paraEsconder = 0;

    const proximo = () => {
      const item: Aviso = {
        id: (contador += 1),
        nome: nomes[indice % nomes.length],
        cidade: cidades[indice % cidades.length],
        acao: ACOES[indice % ACOES.length],
      };
      indice += 1;
      setAviso(item);

      paraEsconder = window.setTimeout(() => {
        setAviso(null);
        const intervalo = INTERVALO_MIN_MS + Math.random() * (INTERVALO_MAX_MS - INTERVALO_MIN_MS);
        paraMostrar = window.setTimeout(proximo, intervalo);
      }, DURACAO_MS);
    };

    paraMostrar = window.setTimeout(proximo, ATRASO_INICIAL_MS);

    return () => {
      window.clearTimeout(paraMostrar);
      window.clearTimeout(paraEsconder);
    };
  }, [ativo, dispensado]);

  return (
    <AnimatePresence>
      {aviso && (
        <m.div
          key={aviso.id}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.3 }}
          /*
           * Canto inferior esquerdo e largura limitada: no celular, aviso
           * centralizado ou largo demais cobre justamente os campos do
           * formulário. `pointer-events-none` no container deixa o toque passar
           * para a página; só o X recebe clique.
           */
          className="fixed bottom-3 left-3 z-40 max-w-[280px] sm:max-w-xs pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-2.5 rounded-xl border border-borda bg-superficie/95 px-3 py-2.5 shadow-lg backdrop-blur-sm">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#278647]/10 text-[#278647]">
              <ShoppingBag className="h-3.5 w-3.5" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-texto">
                <strong className="font-semibold">{aviso.nome}</strong> {aviso.acao}
              </p>
              <p className="text-[12px] text-suave">{aviso.cidade}</p>
            </div>

            <button
              type="button"
              onClick={() => setDispensado(true)}
              className="pointer-events-auto -mr-1 -mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-suave transition-colors hover:bg-sutil hover:text-texto cursor-pointer"
              aria-label="Não mostrar mais estes avisos"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
};
