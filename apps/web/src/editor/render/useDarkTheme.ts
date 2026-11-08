import { useEffect, useState } from 'react';

/** Whether the app shows its dark theme (html[data-theme]), following changes. */
export function useDarkTheme(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setDark(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}
