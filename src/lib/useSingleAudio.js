import { useEffect, useState } from 'react';
import { singleAudio } from './single-audio.js';

export function useSingleAudio() {
  const [state, setState] = useState(singleAudio.state);
  useEffect(() => singleAudio.subscribe(setState), []);
  return state;
}
