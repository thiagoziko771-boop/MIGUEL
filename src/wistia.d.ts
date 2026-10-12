import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/** Web component carregado pelo script da Wistia no index.html. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'wistia-player': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        'media-id'?: string;
        aspect?: string;
        /*
         * Os atributos abaixo sobrescrevem, no código, o que está salvo no
         * painel da Wistia. Ficam aqui de propósito: quem lê o componente vê
         * como o player se comporta sem precisar abrir o painel, e uma troca
         * acidental por lá não muda o funil sem passar por commit.
         *
         * São strings, não booleanos de HTML: atributo booleano de HTML é
         * verdadeiro só por existir, então autoplay={false} viraria autoplay
         * presente — exatamente o contrário do pretendido.
         */
        /**
         * Quanto do vídeo o player baixa antes de alguém apertar play.
         * `none` não baixa nada; o padrão da Wistia já puxa o primeiro segmento.
         */
        preload?: 'none' | 'metadata' | 'auto';
        autoplay?: 'true' | 'false';
        'silent-autoplay'?: 'true' | 'false' | 'allow';
        muted?: 'true' | 'false';
        'big-play-button'?: 'true' | 'false';
        'controls-visible-on-load'?: 'true' | 'false';
        'play-pause-control'?: 'true' | 'false';
        'play-bar-control'?: 'true' | 'false';
        'volume-control'?: 'true' | 'false';
        'fullscreen-control'?: 'true' | 'false';
      };
    }
  }
}
