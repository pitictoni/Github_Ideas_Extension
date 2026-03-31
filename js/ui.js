import { state } from './state.js';

// ============================================================================
// showPopover — unified positioning engine for tooltips, menus & dropdowns
// ============================================================================

(function () {
    const CONTAINER_SEL = '.container';
    const GAP = 4;
    const EDGE = 8;

    function applyPosition(el, anchorRect, { alignRight = false } = {}) {
        const containerRect = document.querySelector(CONTAINER_SEL).getBoundingClientRect();
        const elRect = el.getBoundingClientRect();

        let top = anchorRect.bottom + GAP;
        if (top + elRect.height > containerRect.bottom) top = anchorRect.top - elRect.height - GAP;
        if (top < containerRect.top) {
            top = containerRect.top + EDGE;
            el.style.maxHeight = `${containerRect.height - EDGE * 2}px`;
            el.style.overflowY = 'auto';
        }

        let left = alignRight ? anchorRect.right - elRect.width : anchorRect.left;
        left = Math.min(left, containerRect.right - elRect.width - EDGE);
        left = Math.max(left, containerRect.left + EDGE);

        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
    }

    // Tooltip portal
    const portal = document.createElement('div');
    portal.id = 'popover-portal';
    portal.classList.add('tooltip');
    document.body.appendChild(portal);

    let hideTimer = null;
    const HARDCODED = { avatarWrapper: 'Logout' };

    function getTooltipLabel(el) {
        return el.dataset.tooltip || el.dataset._title || HARDCODED[el.id] || null;
    }

    document.addEventListener('mouseover', e => {
        const anchor = e.target.closest('[data-tooltip], [title], #avatarWrapper');
        if (!anchor) return;
        if (anchor.title) { anchor.dataset._title = anchor.title; anchor.removeAttribute('title'); }
        const label = getTooltipLabel(anchor);
        if (!label) return;
        clearTimeout(hideTimer);
        portal.textContent = label;
        portal.style.position = 'fixed';
        portal.style.maxHeight = '';
        portal.style.overflowY = '';
        requestAnimationFrame(() => {
            applyPosition(portal, anchor.getBoundingClientRect(), { alignRight: false });
            portal.classList.add('visible');
        });
    });

    document.addEventListener('mouseout', e => {
        const anchor = e.target.closest('[data-tooltip], [data-_title], #avatarWrapper');
        if (!anchor) return;
        if (anchor.dataset._title) { anchor.title = anchor.dataset._title; delete anchor.dataset._title; }
        hideTimer = setTimeout(() => portal.classList.remove('visible'), 80);
    });

    // Panel (menus & dropdowns)
    window.showPopover = function ({ anchor, element, alignRight = false, onClose } = {}) {
        element.style.position = 'fixed';
        element.style.zIndex = '10000';
        element.style.maxHeight = '';
        element.style.overflowY = '';
        document.body.appendChild(element);
        requestAnimationFrame(() => applyPosition(element, anchor.getBoundingClientRect(), { alignRight }));
        if (onClose) {
            setTimeout(() => {
                function handler(e) {
                    if (!element.contains(e.target)) { onClose(); document.removeEventListener('click', handler); }
                }
                document.addEventListener('click', handler);
            }, 0);
        }
    };
})();

// ============================================================================
// Status messages
// ============================================================================

export function showStatus(message, type = 'info') {
    const statusEl = document.getElementById('statusMessage');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type}`;
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 3000);
}

// ============================================================================
// Modal helpers
// ============================================================================

export function openModal(modalId) {
    document.getElementById(modalId).style.display = 'flex';
}

export function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

export function openDeleteConfirmModal(message, callback) {
    document.getElementById('deleteConfirmMessage').textContent = message;
    state.deleteCallback = callback;
    openModal('deleteConfirmModal');
}

export async function confirmDeleteAction() {
    if (state.deleteCallback) {
        await state.deleteCallback();
        state.deleteCallback = null;
    }
    closeModal('deleteConfirmModal');
}

// ============================================================================
// Color and field utilities
// ============================================================================

export function githubColorToCSS(githubColor) {
    const colorMap = {
        'GRAY': '#6b7280', 'RED': '#ef4444', 'GREEN': '#22c55e',
        'BLUE': '#3b82f6', 'YELLOW': '#eab308', 'PURPLE': '#a855f7',
        'PINK': '#ec4899', 'ORANGE': '#f97316'
    };
    return colorMap[githubColor] || '#6b7280';
}

export function extractFieldDefinitions(project) {
    const fieldDefs = { status: null, other: [] };
    if (!project.fields?.nodes) return fieldDefs;

    project.fields.nodes.forEach(field => {
        if (field.options) {
            const fieldInfo = {
                id: field.id, name: field.name, dataType: field.dataType,
                options: field.options.map(opt => ({ id: opt.id, name: opt.name, color: opt.color, description: opt.description }))
            };
            if (field.name.toLowerCase() === 'status') fieldDefs.status = fieldInfo;
            else fieldDefs.other.push(fieldInfo);
        }
    });
    return fieldDefs;
}

export function formatDurationMs(durationMs) {
    if (typeof durationMs !== 'number') return '—';
    return `${(durationMs / 1000).toFixed(2)} s`;
}

// No-op — benchmark UI is hidden from users
export function updateBenchmarkStateUI() { }
export async function refreshBenchmarkLogsIfVisible() { }
