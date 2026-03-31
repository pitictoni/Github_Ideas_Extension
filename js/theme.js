(function () {
    const toggleBtn = document.getElementById('themeToggleBtn');

    function getInitialTheme() {
        return new Promise((resolve) => {
            chrome.storage.local.get('theme', (result) => {
                if (result.theme) {
                    resolve(result.theme);
                } else {
                    const prefersDark = window.matchMedia &&
                        window.matchMedia('(prefers-color-scheme: dark)').matches;
                    resolve(prefersDark ? 'dark' : 'light');
                }
            });
        });
    }


    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        chrome.storage.local.set({ theme });
        if (toggleBtn) {
            toggleBtn.classList.remove('light', 'dark');
            toggleBtn.classList.add(theme === 'dark' ? 'dark' : 'light');
        }
    }

    getInitialTheme().then(initialTheme => {
        applyTheme(initialTheme);
    });

    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            applyTheme(next);
        });
    }

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            chrome.storage.local.get('theme', (result) => {
                if (!result.theme) {
                    applyTheme(e.matches ? 'dark' : 'light');
                }
            });
        });
    }
})();