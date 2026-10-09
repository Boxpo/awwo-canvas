import { useRef, type KeyboardEvent } from 'react';

/** Enter sends and Shift+Enter keeps its newline. The Enter that confirms an input-method
 * composition never sends: browsers report it as composing, as key code 229, or deliver it
 * between the composition events. Every prompt box shares this, so the rule cannot drift. */
export function useEnterToSend(send: () => void) {
  const composing = useRef(false);
  return {
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      send();
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
  };
}
