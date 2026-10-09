import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The theme follows the system; the reused AwwO stylesheets key off :root[data-theme].
const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
const applyTheme = () => { document.documentElement.dataset.theme = scheme?.matches ? 'dark' : 'light'; };
applyTheme();
scheme?.addEventListener?.('change', applyTheme);

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');
createRoot(root).render(<StrictMode><App /></StrictMode>);
