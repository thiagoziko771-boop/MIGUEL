import React from 'react';
import * as m from 'motion/react-m';
import { CheckCircle2, Circle } from 'lucide-react';
import { QuizOption } from '../types';

interface OptionCardProps {
  option: QuizOption;
  isSelected: boolean;
  onSelect: (option: QuizOption) => void;
  hasImageThumbnail?: boolean;
}

export const OptionCard: React.FC<OptionCardProps> = ({
  option,
  isSelected,
  onSelect,
  hasImageThumbnail = false,
}) => {
  return (
    <m.div
      whileHover={{ scale: 1.005, y: -1 }}
      whileTap={{ scale: 0.99 }}
      onClick={() => onSelect(option)}
      className={`
        relative w-full rounded-xl p-4 sm:p-5 transition-all duration-200 cursor-pointer select-none
        border-[1.5px] flex items-center justify-between gap-3.5 min-h-[64px]
        ${isSelected 
          ? 'bg-sutil border-ouro shadow-sm' 
          : 'bg-superficie border-borda hover:border-ouro/70 hover:bg-sutil/50 shadow-xs'
        }
      `}
    >
      <div className="flex items-center gap-3.5 flex-1 min-w-0">
        {/* Radio Circle (Minimalism Style) */}
        <div className="flex-shrink-0">
          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
            isSelected ? 'border-ouro' : 'border-borda'
          }`}>
            {isSelected && (
              <div className="w-2.5 h-2.5 rounded-full bg-ouro" />
            )}
          </div>
        </div>

        {/* Image Thumbnail option */}
        {hasImageThumbnail && option.imageUrl && (
          <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden flex-shrink-0 border border-borda bg-sutil">
            <img 
              src={option.imageUrl} 
              alt={option.text}
              className="w-full h-full object-cover object-center"
              loading="lazy"
            />
          </div>
        )}

        {/* Emoji / Icon Option */}
        {!hasImageThumbnail && option.icon && (
          <div className="w-10 h-10 rounded-lg bg-sutil border border-borda flex items-center justify-center text-xl flex-shrink-0">
            <span>{option.icon}</span>
          </div>
        )}

        {/* Option Text */}
        <span className="font-sans font-medium text-texto text-base leading-snug flex-1">
          {option.text}
        </span>
      </div>
    </m.div>
  );
};
