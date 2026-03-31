import { CONFIG, getParticipantId } from './config.js';

// ============================================================================
// Benchmark Tracking
// ============================================================================

const BENCHMARK_STORAGE_KEY = 'benchmarkLogs';
const BENCHMARK_MAX_LOGS = 200;

export const benchmarkTracker = {
    armedTask: null,
    activeRun: null,

    createId(task) {
        return `${task}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    },

    async getLogs() {
        const result = await chrome.storage.local.get([BENCHMARK_STORAGE_KEY]);
        return Array.isArray(result[BENCHMARK_STORAGE_KEY]) ? result[BENCHMARK_STORAGE_KEY] : [];
    },

    async saveLogs(logs) {
        await chrome.storage.local.set({ [BENCHMARK_STORAGE_KEY]: logs.slice(-BENCHMARK_MAX_LOGS) });
    },

    async appendLog(log) {
        const participantId = await getParticipantId();
        const enrichedLog = { ...log, participantId };

        const logs = await this.getLogs();
        logs.push(enrichedLog);
        await this.saveLogs(logs);

        const { metadata, ...safeLog } = enrichedLog;
        fetch(`${CONFIG.BACKEND_URL}/api/benchmark`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(safeLog)
        }).catch(err => console.warn('[Benchmark] Remote sync failed:', err.message));
    },

    arm(task) {
        this.armedTask = { task, armedAt: Date.now() };
        this.activeRun = null;
    },

    async cancel(reason) {
        if (this.activeRun) {
            this.activeRun.completedAt = Date.now();
            this.activeRun.durationMs = this.activeRun.completedAt - this.activeRun.startedAt;
            this.activeRun.cancelled = true;
            this.activeRun.cancelReason = reason;
            await this.appendLog(this.activeRun);
            this.activeRun = null;
        }
        this.armedTask = null;
    },

    async clear() {
        this.activeRun = null;
        this.armedTask = null;
        await chrome.storage.local.remove([BENCHMARK_STORAGE_KEY]);
    },

    ensureTask(task) {
        return this.activeRun?.task === task || this.armedTask?.task === task;
    },

    recordInteraction(interaction) {
        if (!this.activeRun) return;

        const entry = {
            ts: interaction?.ts || Date.now(),
            type: interaction?.type || 'interaction',
            target: interaction?.target || null,
            synthetic: !!interaction?.synthetic
        };

        this.activeRun.steps.push(entry);

        if (entry.type === 'click') {
            this.activeRun.rawClickCount++;
            this.activeRun.clickCount++;
        } else if (entry.type === 'select_change') {
            this.activeRun.clickCount++;
        }
    },

    noteInput(field) {
        if (!this.activeRun) return;
        if (!this.activeRun.inputFields.includes(field)) {
            this.activeRun.inputFields.push(field);
            this.activeRun.steps.push({ ts: Date.now(), type: 'input_started', field });
        }
    },

    async complete() {
        if (!this.activeRun) return;
        this.activeRun.completedAt = Date.now();
        this.activeRun.durationMs = this.activeRun.completedAt - this.activeRun.startedAt;
        this.activeRun.success = true;
        await this.appendLog(this.activeRun);
        this.activeRun = null;
    }
};

// ============================================================================
// Helpers
// ============================================================================

export function autoStartBenchmark(task) {
    if (benchmarkTracker.activeRun) return;

    benchmarkTracker.activeRun = {
        id: benchmarkTracker.createId(task),
        task,
        platform: 'extension',
        armedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
        success: false,
        cancelled: false,
        cancelReason: null,
        clickCount: 1,
        rawClickCount: 1,
        inputFields: [],
        steps: [{
            ts: Date.now(),
            type: 'click',
            target: `auto_start:${task}`,
            synthetic: false
        }]
    };

    benchmarkTracker.armedTask = null;
}

export async function completeBenchmarkTask(task) {
    if (benchmarkTracker.ensureTask(task)) {
        await benchmarkTracker.complete();
    }
}

export async function cancelBenchmarkTask(task, reason) {
    if (benchmarkTracker.ensureTask(task)) {
        await benchmarkTracker.cancel(reason);
    }
}

export function isBenchmarkControlElement(element) {
    if (!element) return false;
    return !!element.closest('#openBenchmarkModalBtn, #benchmarkStateBadge, #startBenchmarkModal');
}

export function describeBenchmarkTarget(element) {
    if (!element) return { target: 'unknown' };
    const id = element.id ? `#${element.id}` : null;
    const cls = element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.')
        : null;
    return { target: id || cls || element.tagName.toLowerCase() };
}

export function attachBenchmarkUIHandlers() {
    document.addEventListener('click', event => {
        if (!benchmarkTracker.activeRun) return;
        if (isBenchmarkControlElement(event.target)) return;
        if (event.target === document || event.target === document.body) return;

        const info = describeBenchmarkTarget(event.target);
        benchmarkTracker.recordInteraction({
            ts: Date.now(), type: 'click', target: info.target, synthetic: false
        });
    }, true);

    document.addEventListener('click', event => {
        const select = event.target.closest('select');
        if (!select || isBenchmarkControlElement(select)) return;

        const info = describeBenchmarkTarget(select);
        benchmarkTracker.recordInteraction({
            ts: Date.now(), type: 'click', target: info.target, synthetic: true
        });
    }, true);

    document.addEventListener('change', event => {
        const select = event.target.closest('select');
        if (!select || isBenchmarkControlElement(select)) return;

        benchmarkTracker.recordInteraction({
            ts: Date.now(),
            type: 'select_change',
            target: select.id ? `#${select.id}` : 'select',
            synthetic: true
        });
    }, true);

    document.addEventListener('input', event => {
        const field = event.target.closest('input, textarea');
        if (!field || isBenchmarkControlElement(field)) return;
        const fieldName = field.id || field.name || field.placeholder || field.tagName.toLowerCase();
        benchmarkTracker.noteInput(fieldName);
    }, true);
}

window.debugBenchmarkLogs = async function () {
    const logs = await benchmarkTracker.getLogs();
    console.log(logs);
    return logs;
};
