(function () {
    const themeToggle = document.getElementById('themeToggle');

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
        themeToggle.checked = theme === 'dark';
        chrome.storage.local.set({ theme });
    }

    getInitialTheme().then(initialTheme => {
        applyTheme(initialTheme);
    });

    themeToggle.addEventListener('change', function () {
        const newTheme = this.checked ? 'dark' : 'light';
        applyTheme(newTheme);
    });

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