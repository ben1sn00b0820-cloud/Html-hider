/* 墨序 1.0.2 — content-aware HTML source hiding. No chat writes or polling. */
(() => {
    'use strict';
    const GLOBAL_KEY = '__MOXU_SOURCE_GUARD__';
    const SETTINGS_KEY = 'moxu_source_guard';
    const HIDDEN_CLASS = 'moxu-source-guard-hidden';
    const UI_ID = 'moxu-source-guard-settings';
    const CONTENT_SELECTOR = '.mes_text, .mes_reasoning';
    const EMBED_SELECTOR = 'iframe, object, embed';
    const PREFIX_LIMIT = 2048;
    const BATCH_DELAY = 100;

    function start() {
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context?.extensionSettings || typeof context.saveSettingsDebounced !== 'function') {
            console.warn('[Moxu] SillyTavern extension context is unavailable. No chat content was changed.');
            return;
        }
        globalThis[GLOBAL_KEY]?.dispose?.();
        let settings = context.extensionSettings[SETTINGS_KEY];
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            settings = context.extensionSettings[SETTINGS_KEY] = { enabled: true };
        }
        if (typeof settings.enabled !== 'boolean') settings.enabled = true;

        let disposed = false;
        let chat = null;
        let observer = null;
        let startupObserver = null;
        let startupTimeout = null;
        let batchTimer = null;
        let ui = null;
        let enabled = settings.enabled;
        const pending = new Set();
        const marked = new Set();
        const stats = { fullScans: 0, batches: 0, candidatesChecked: 0 };
        const eventBindings = [];

        function save() {
            context.saveSettingsDebounced();
        }

        // Read a bounded prefix, not the entire document for every streamed token.
        function prefixOf(element) {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    return node.parentElement?.closest('.code-copy, button, .moxu-source-guard-ui')
                        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                },
            });
            let prefix = '';
            let node;
            while (prefix.length < PREFIX_LIMIT && (node = walker.nextNode())) {
                prefix += (node.nodeValue || '').slice(0, PREFIX_LIMIT - prefix.length);
            }
            return prefix;
        }

        function normalizePrefix(prefix) {
            // Decode a single HTML-escaped layer for recognition only; never write it back.
            const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
            let value = prefix.replace(/&(?:#(x[0-9a-f]+|\d+)|(lt|gt|quot|apos|amp));/gi, (match, number, name) => {
                if (name) return named[name.toLowerCase()];
                const point = /^x/i.test(number) ? parseInt(number.slice(1), 16) : Number(number);
                return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
            }).replace(/^\uFEFF/, '').trimStart();
            value = value.replace(/^(?:`{3,}|~{3,})[ \t]*(?:html|htm|xhtml|xml|text|txt|plaintext)?[ \t]*\r?\n/i, '').trimStart();
            return value;
        }

        function standaloneCode(element, prefix) {
            if (element.tagName !== 'CODE' || element.closest('pre')) return false;
            // Single inline mentions such as <code>&lt;html&gt;</code> must remain visible.
            if (!/[\r\n]/.test(prefix) && !/<(?:head|body)\b|<\/html\s*>/i.test(normalizePrefix(prefix))) return false;
            const parent = element.parentElement;
            if (!parent) return false;
            for (const sibling of parent.childNodes) {
                if (sibling === element) continue;
                if (sibling.nodeType === Node.TEXT_NODE && sibling.nodeValue.trim()) return false;
                if (sibling.nodeType === Node.ELEMENT_NODE && !sibling.matches('br, .code-copy, button')) {
                    // Keep inline/prose examples; only a genuinely standalone code block qualifies.
                    if (prefixOf(sibling).trim()) return false;
                }
            }
            return true;
        }

        function inChatContent(element) {
            if (!chat || !element?.isConnected || !chat.contains(element)) return false;
            const scope = element.closest(CONTENT_SELECTOR);
            return !!scope && chat.contains(scope);
        }

        function shouldHide(element) {
            if (!inChatContent(element) || element.querySelector(EMBED_SELECTOR)) return false;
            const prefix = prefixOf(element);
            if (element.tagName !== 'PRE' && !standaloneCode(element, prefix)) return false;
            return /^(?:<!doctype\s+html\b|<html(?=[\s>]))/i.test(normalizePrefix(prefix));
        }

        function applyCandidate(element) {
            stats.candidatesChecked++;
            const hide = enabled && shouldHide(element);
            element.classList.toggle(HIDDEN_CLASS, hide);
            if (hide) marked.add(element);
            else marked.delete(element);
        }

        function updateStatus() {
            const label = ui?.querySelector('[data-moxu-status]');
            const status = enabled ? `目前隱藏 ${marked.size} 個 HTML 原始碼區塊` : '已關閉，原始碼恢復顯示';
            if (label && label.textContent !== status) label.textContent = status;
            const checkbox = ui?.querySelector('input');
            if (checkbox && checkbox.checked !== enabled) checkbox.checked = enabled;
        }

        function flush() {
            batchTimer = null;
            if (disposed || !enabled) { pending.clear(); return; }
            stats.batches++;
            for (const element of pending) applyCandidate(element);
            pending.clear();
            for (const element of marked) {
                if (!element.isConnected || !chat?.contains(element)) {
                    element.classList.remove(HIDDEN_CLASS);
                    marked.delete(element);
                }
            }
            updateStatus();
        }

        function queue(element) {
            if (!enabled || disposed || !element) return;
            pending.add(element);
            if (batchTimer === null) batchTimer = setTimeout(flush, BATCH_DELAY);
        }

        function consider(node) {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!element || !chat?.contains(element)) return;
            const closestPre = element.closest('pre');
            if (closestPre) { if (inChatContent(closestPre)) queue(closestPre); return; }
            const closestCode = element.closest('code');
            if (closestCode) { if (inChatContent(closestCode)) queue(closestCode); return; }
            // Only the added subtree is searched, never the complete chat on each token.
            for (const candidate of element.querySelectorAll('pre, code')) {
                if (candidate.tagName === 'CODE' && candidate.closest('pre')) continue;
                if (inChatContent(candidate)) queue(candidate);
            }
        }

        function onMutations(records) {
            for (const record of records) {
                if (record.type === 'characterData') { consider(record.target); continue; }
                // A removed/added iframe can change whether its existing source block is hidden.
                const parent = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
                const ancestor = parent?.closest('pre, code');
                if (ancestor) consider(ancestor);
                for (const node of record.addedNodes) consider(node);
                if (record.removedNodes.length && marked.size && batchTimer === null) batchTimer = setTimeout(flush, BATCH_DELAY);
            }
        }

        function clearStartupWait() {
            startupObserver?.disconnect(); startupObserver = null;
            if (startupTimeout !== null) clearTimeout(startupTimeout);
            startupTimeout = null;
        }

        function clearPending() {
            if (batchTimer !== null) clearTimeout(batchTimer);
            batchTimer = null;
            pending.clear();
        }

        function restoreMarked() {
            for (const element of marked) element.classList.remove(HIDDEN_CLASS);
            marked.clear();
        }

        function scan() {
            if (disposed) return 0;
            renderUI();
            bindChat(false);
            if (!enabled || !chat) { updateStatus(); return 0; }
            stats.fullScans++;
            for (const candidate of chat.querySelectorAll('pre, code')) {
                if (candidate.tagName === 'CODE' && candidate.closest('pre')) continue;
                if (inChatContent(candidate)) applyCandidate(candidate);
            }
            for (const element of marked) {
                if (!element.isConnected || !chat.contains(element)) {
                    element.classList.remove(HIDDEN_CLASS);
                    marked.delete(element);
                }
            }
            updateStatus();
            return marked.size;
        }

        function bindChat(scanOnChange = true) {
            if (disposed) return;
            const next = document.getElementById('chat');
            if (next === chat && (!enabled || observer)) return;
            observer?.disconnect(); observer = null;
            clearPending();
            if (next !== chat) restoreMarked();
            chat = next;
            if (!enabled || !chat) return;
            clearStartupWait();
            observer = new MutationObserver(onMutations);
            observer.observe(chat, { childList: true, subtree: true, characterData: true });
            if (scanOnChange) scan();
        }

        function waitForChatOnce() {
            if (!enabled || disposed || chat || startupObserver) return;
            startupObserver = new MutationObserver(() => {
                if (document.getElementById('chat')) { clearStartupWait(); bindChat(); renderUI(); }
            });
            startupObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
            // Bounded startup discovery only; subsequent chat changes use the native event.
            startupTimeout = setTimeout(clearStartupWait, 10000);
        }

        function enable(value, persist = true) {
            if (disposed) return false;
            enabled = !!value;
            settings.enabled = enabled;
            if (!enabled) {
                observer?.disconnect(); observer = null;
                clearStartupWait(); clearPending(); restoreMarked();
            } else {
                bindChat(false);
                if (!chat) waitForChatOnce();
                else scan();
            }
            if (persist) save();
            updateStatus();
            return enabled;
        }

        function renderUI() {
            if (ui?.isConnected || disposed) return;
            const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
            if (!container) return;
            document.getElementById(UI_ID)?.remove();
            ui = document.createElement('div');
            ui.id = UI_ID;
            ui.className = 'extension_container';
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = '墨序 1.0.2｜HTML 原始碼隱藏';
            const controls = document.createElement('div');
            controls.className = 'moxu-source-guard-controls';
            const label = document.createElement('label');
            label.className = 'checkbox_label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.checked = enabled;
            checkbox.addEventListener('change', () => enable(checkbox.checked));
            const text = document.createElement('span'); text.textContent = '隱藏完整 HTML 原始碼';
            label.append(checkbox, text);
            const rescan = document.createElement('button');
            rescan.type = 'button'; rescan.className = 'menu_button'; rescan.textContent = '重新掃描';
            rescan.addEventListener('click', scan);
            controls.append(label, rescan);
            const status = document.createElement('div'); status.dataset.moxuStatus = '';
            status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            const note = document.createElement('p'); note.className = 'moxu-source-guard-note';
            note.textContent = '只隱藏以 DOCTYPE html 或 <html 起頭的程式碼區塊；未閉合的文件也會辨識。正文與原始內容不刪除。關閉開關即可恢復顯示。';
            details.append(summary, controls, status, note); ui.append(details); container.append(ui);
            updateStatus();
        }

        function onChatChanged() {
            renderUI(); bindChat(false);
            if (enabled) { if (chat) scan(); else waitForChatOnce(); }
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect(); observer = null;
            clearStartupWait(); clearPending(); restoreMarked();
            for (const [source, type, listener] of eventBindings) {
                if (typeof source.removeListener === 'function') source.removeListener(type, listener);
                else if (typeof source.off === 'function') source.off(type, listener);
            }
            ui?.remove(); ui = null;
            if (globalThis[GLOBAL_KEY] === api) delete globalThis[GLOBAL_KEY];
        }

        const api = {
            version: '1.0.2', scan, enable, dispose,
            stats() { return { version: '1.0.2', enabled, hiddenCount: marked.size, observing: !!observer, startupWaiting: !!startupObserver, queued: pending.size, ...stats }; },
            get enabled() { return enabled; },
            get hiddenCount() { return marked.size; },
            get diagnostics() { return { ...stats, observing: !!observer, startupWaiting: !!startupObserver, pending: pending.size }; },
        };
        globalThis[GLOBAL_KEY] = api;
        const events = context.eventTypes || context.event_types;
        if (context.eventSource?.on && events) {
            for (const type of new Set([events.CHAT_CHANGED, events.APP_READY].filter(Boolean))) {
                context.eventSource.on(type, onChatChanged);
                eventBindings.push([context.eventSource, type, onChatChanged]);
            }
        }
        renderUI(); bindChat(false);
        if (chat && enabled) scan();
        else if (!chat) waitForChatOnce();
        // Explicit UI/API toggles persist through the native settings API; chat data is never written.
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
