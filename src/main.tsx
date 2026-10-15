import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startWorkingCopy } from './model/store';
import './styles.css';

// What was in the editor is read from this browser before anything is shown.
void startWorkingCopy().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
