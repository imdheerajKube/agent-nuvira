import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyTheme, loadTheme } from './theme';
import './styles/themes.css';
import './styles/dashboard.css';

// Applied BEFORE the first render. Setting the theme from inside React would
// paint the default palette for a frame and then flash to the user's own, which
// is exactly the kind of thing that makes a dashboard feel cheap.
applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
