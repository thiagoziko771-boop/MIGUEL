export type StepType = 
  | 'hero' 
  | 'quiz' 
  | 'audio_intermission' 
  | 'testimonials' 
  | 'loading' 
  | 'vsl_offer';

export interface QuizOption {
  id: string;
  text: string;
  icon?: string;
  imageUrl?: string;
}

export interface QuizQuestion {
  id: string;
  stepNumber: number; // 1 to 9
  progressPercent: number; // e.g. 11, 22, 33...
  question: string;
  options: QuizOption[];
  hasImageThumbnails?: boolean;
}

export interface TestimonialVideo {
  id: string;
  author: string;
  title?: string;
  duration: string;
  thumbnailUrl: string;
  avatarUrl?: string;
  quote?: string;
  wistiaMediaId?: string;
}

export interface UserAnswer {
  questionId: string;
  questionText: string;
  selectedOptionId: string;
  selectedOptionText: string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'wistia-player': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          'media-id'?: string;
          aspect?: string;
          // Ver a explicação de cada um em src/wistia.d.ts.
          autoplay?: 'true' | 'false';
          'silent-autoplay'?: 'true' | 'false' | 'allow';
          muted?: 'true' | 'false';
          'big-play-button'?: 'true' | 'false';
          'controls-visible-on-load'?: 'true' | 'false';
          'play-pause-control'?: 'true' | 'false';
          'play-bar-control'?: 'true' | 'false';
          'volume-control'?: 'true' | 'false';
          'fullscreen-control'?: 'true' | 'false';
        },
        HTMLElement
      >;
    }
  }
}
