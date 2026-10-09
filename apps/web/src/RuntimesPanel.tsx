// The hot-plug registry, live: what each worker serves, whether it is ready, and the two ways a
// worker joins without a restart (POST /api/runtimes here, or AWWO_REGISTER_URL from the worker).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { RefreshCw, Unplug, X } from 'lucide-react';
import type { RuntimeView } from '@awwo/core/protocol';
import { api, hasApiToken, saveApiToken } from './api';
import type { ShellTranslate } from './text';

interface Props {
  runtimes: RuntimeView[];
  defaultRuntime: string;
  t: ShellTranslate;
  onClose: () => void;
  onChanged: () => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function RuntimesPanel({ runtimes, defaultRuntime, t, onClose, onChanged }: Props) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState({ id: '', url: 'http://127.0.0.1:8793', label: '', token: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [apiToken, setApiToken] = useState('');
  useEffect(() => { closeRef.current?.focus(); }, []);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try { await action(); onChanged(); } catch (failure) { setError(message(failure)); } finally { setBusy(''); }
  };
  const plugIn = (event: FormEvent) => {
    event.preventDefault();
    void act('plug', async () => {
      await api.registerRuntime({ id: form.id.trim(), url: form.url.trim(), ...(form.label.trim() ? { label: form.label.trim() } : {}),
        ...(form.token ? { token: form.token } : {}) });
      setForm(current => ({ ...current, id: '', label: '', token: '' }));
    });
  };

  return <div className="awwo-modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <section className="awwo-modal awwo-runtimes" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="awwo-modal-head">
        <h2 id={titleId}>{t('runtimesTitle')}</h2>
        <button ref={closeRef} type="button" className="awwo-icon" aria-label={t('close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="awwo-modal-body">
        <p className="awwo-muted">{t('runtimesIntro')}</p>
        <ul className="awwo-runtime-list">
          {runtimes.length === 0 ? <li className="awwo-muted">{t('runtimesNone')}</li> : null}
          {runtimes.map(runtime => <li key={runtime.id} className={`awwo-runtime is-${runtime.status}`}>
            <div className="awwo-runtime-head">
              <span className="awwo-status-dot" aria-hidden="true" />
              <strong>{runtime.label}</strong><code>{runtime.id}</code>
              {runtime.id === defaultRuntime ? <span className="awwo-chip is-accent">default</span> : null}
              <span className="awwo-chip">{runtime.source === 'file' ? t('fromFile') : t('fromApi')}</span>
              <span className="awwo-spacer" />
              <button type="button" className="awwo-ghost" disabled={busy !== ''} onClick={() => void act(`probe:${runtime.id}`, () => api.probeRuntime(runtime.id))}>
                <RefreshCw size={13} aria-hidden="true" />{t('probe')}</button>
              {runtime.source === 'api' ? <button type="button" className="awwo-ghost is-danger" disabled={busy !== ''}
                onClick={() => void act(`unplug:${runtime.id}`, () => api.unplugRuntime(runtime.id))}>
                <Unplug size={13} aria-hidden="true" />{t('remove')}</button> : null}
            </div>
            {runtime.error ? <p className="awwo-warning">{runtime.error}</p> : null}
            {runtime.status === 'ready' ? <dl className="awwo-runtime-facts">
              <dt>{t('models')}</dt>
              <dd>{runtime.models.map(model => <span key={model.id} className="awwo-chip" title={model.id}>
                {model.label}{model.reasoningEfforts.length ? ` · ${model.reasoningEfforts.join('/')}` : ''}</span>)}</dd>
              {runtime.tools.length ? <><dt>{t('tools')}</dt><dd>{runtime.tools.map(tool => <span key={tool} className="awwo-chip">{tool}</span>)}</dd></> : null}
              <dt>{t('load', { active: runtime.activeRuns, max: runtime.maxConcurrency })}</dt>
              <dd className="awwo-muted">{runtime.sdkVersion}</dd>
            </dl> : null}
          </li>)}
        </ul>

        <form className="awwo-runtime-form" onSubmit={plugIn}>
          <h3>{t('addRuntime')}</h3>
          <label>{t('runtimeId')}<input required pattern="[a-z][a-z0-9_\-]{0,63}" value={form.id} placeholder="python"
            onChange={event => setForm({ ...form, id: event.target.value })} /></label>
          <label>{t('runtimeUrl')}<input required type="url" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} /></label>
          <label>{t('runtimeLabel')}<input value={form.label} placeholder="Python worker" onChange={event => setForm({ ...form, label: event.target.value })} /></label>
          <label>{t('runtimeToken')}<input type="password" autoComplete="off" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} /></label>
          <button type="submit" className="awwo-primary" disabled={busy !== ''}>{t('plugIn')}</button>
        </form>
        {error ? <p className="awwo-warning" role="alert">{error}</p> : null}

        <details className="awwo-raw-details">
          <summary>{t('apiToken')}{hasApiToken() ? ' ✓' : ''}</summary>
          <p className="awwo-muted">{t('apiTokenHint')}</p>
          <div className="awwo-inline-form">
            <input type="password" autoComplete="off" aria-label={t('apiToken')} value={apiToken} onChange={event => setApiToken(event.target.value)} />
            <button type="button" className="awwo-ghost" onClick={() => { saveApiToken(apiToken); setApiToken(''); onChanged(); }}>{t('save')}</button>
          </div>
        </details>
      </div>
    </section>
  </div>;
}
