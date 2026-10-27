import { Clapperboard } from 'lucide-react';
import { DIRECTABLE_LABEL, isVerifiedDirectable } from '../lib/directable';

// “可导演”只挂在实测能听情绪/节奏指令的音色上；没挂 = 没验证过（Design 规则，只此一套）。
export function DirectableBadge({ voiceId }) {
  if (!isVerifiedDirectable(voiceId)) return null;
  return <span className="directable-badge" title="实测过能听情绪、节奏指令"><Clapperboard size={10} aria-hidden="true" />{DIRECTABLE_LABEL}</span>;
}
