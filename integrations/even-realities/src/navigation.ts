// Phone navigation is available while the glasses bridge connects.
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-page]'));
    const selectPage = (page: string) => {
      for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.page === page));
      for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== page;
    };
    for (const tab of tabs) tab.addEventListener('click', () => selectPage(tab.dataset.page || 'home'));
    document.getElementById('setupLink')?.addEventListener('click', () => selectPage('settings'));
