  // The theme before the page shows (see settings in the module below)
  try {
    const theme = JSON.parse(localStorage.getItem('texpresso.settings'))?.theme ?? 'auto';
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch {}
