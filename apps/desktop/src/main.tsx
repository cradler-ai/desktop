import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { inTauri } from './clients';
import { pickLocale, setLocale, t } from '@cradler-desktop/core';
import './messages';

if (inTauri) document.documentElement.classList.add('is-tauri');

// Follow the system language (WebKit reports the user's preferred languages).
const locale = pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
setLocale(locale);
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
document.title = t('app.name');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
