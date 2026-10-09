// The in-tile composer — one turn on THIS tile's own conversation.
//
// Ported from the previous canvas's chat composer (since-deleted apps/web/src/studio/StudioChatBubble.tsx):
// Enter sends, Shift+Enter is a newline, the input and the button are disabled while a stream is
// in flight, and the honest notice stays visible.
//
// That notice is not decoration. Talking to an agent here wakes its FULL worker: it may really go
// do governed work (edit files, open sub-issues, request approvals), and the reply IS that
// execution, not a chatbot answer. The surface says so before the operator types.
//
// An UNBOUND tile cannot send at all. It is disabled with the reason stated — never a live-looking
// box whose message would silently go nowhere.

import { useId, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { useCanvasI18n } from './i18n';

export const COMPOSER_COPY = {
  notice:
    'Agent 将按已配置的权限执行任务。',
  placeholder: '给这个 Agent 发消息…',
  send: '发送',
  sending: '运行中…',
  unbound: '本节点尚未绑定真实 Agent，无法对话。',
} as const;

export interface TileComposerProps {
  /** True while this tile's stream is live — sending again would supersede it. */
  streaming: boolean;
  /** Hard block (e.g. the tile is not bound to a real agent). `blockedReason` says why. */
  blocked?: boolean;
  blockedReason?: string;
  /** A temporary execution prerequisite disables sending while leaving the draft editable. */
  sendUnavailableReason?: string;
  /** An optional card-owned draft survives switching its input/output tabs. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  onSend: (text: string, onAccepted?: () => void) => void;
  /** The host acknowledges only after the message has a durable execution record. */
  deferClear?: boolean;
  notice?: string;
}

export function TileComposer({ streaming, blocked = false, blockedReason, sendUnavailableReason, draft, onDraftChange, onSend, deferClear = false, notice }: TileComposerProps) {
  const { t } = useCanvasI18n();
  const reasonId = useId();
  const disclaimerId = useId();
  const [localInput, setLocalInput] = useState('');
  const input = draft ?? localInput;
  const setInput = (value: string) => { setLocalInput(value); onDraftChange?.(value); };
  const disabled = blocked || streaming;
  const sendReason = !blocked ? sendUnavailableReason?.trim() || undefined : undefined;

  const send = () => {
    const message = input.trim();
    if (!message || disabled || sendReason) return;
    if (deferClear) onSend(message, () => setInput(''));
    else { setInput(''); onSend(message); }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="canvas-composer">
      {blocked ? (
        <div className="canvas-composer-blocked" data-testid="composer-blocked">
          {blockedReason || t('composer.unbound')}
        </div>
      ) : sendReason ? (
        <div className="canvas-composer-notice" id={reasonId} role="status">{sendReason}</div>
      ) : (
        <div className="canvas-composer-notice">{notice ?? t('composer.notice')}</div>
      )}
      <div className="canvas-composer-row">
        <textarea
          className="canvas-composer-input"
          data-testid="composer-input"
          value={input}
          rows={2}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.placeholder')}
          aria-describedby={blocked ? undefined : disclaimerId}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="canvas-composer-send"
          data-testid="composer-send"
          disabled={disabled || Boolean(sendReason) || !input.trim()}
          title={sendReason}
          aria-label={sendReason ? `${t('composer.send')}：${sendReason}` : undefined}
          aria-describedby={sendReason ? reasonId : undefined}
          onClick={send}
        >
          {streaming ? <Loader2 size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
          <span>{t(streaming ? 'composer.sending' : 'composer.send')}</span>
        </button>
      </div>
      {blocked ? null : <small id={disclaimerId} className="canvas-composer-disclaimer">{t('composer.disclaimer')}</small>}
    </div>
  );
}
