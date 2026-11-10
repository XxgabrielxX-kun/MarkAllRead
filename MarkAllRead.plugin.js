/**
 * @name MarkAllRead
 * @author Gabriel
 * @description Mark all servers and DMs as read with one click / Marca todos os servidores e DMs como lidos com um clique.
 * @version 1.8.0
 */

const LOG = (...a) => console.log("%c[MarkAllRead]", "color:#5865f2;font-weight:bold", ...a);

// ---------- Traduções (segue o idioma do Discord: pt-BR ou en-US) ----------
const STRINGS = {
    "pt-BR": {
        menuLabel: "Marcar TUDO como lido",
        markNow: "Marcar tudo como lido agora",
        includeDMs: "Incluir DMs e grupos",
        enableHotkey: "Ativar atalho de teclado",
        hotkeyCurrent: (combo) => `Atalho atual: ${combo} (clique para mudar)`,
        hotkeyNone: "nenhum",
        hotkeyPress: "Pressione a nova combinação... (Esc cancela)",
        hotkeyNeedModifier: "Use pelo menos Ctrl, Alt ou Shift na combinação.",
        hotkeySet: (combo) => `Atalho definido: ${combo}`,
        diagnostics: "Diagnóstico",
        diagResult: (stores, http, scanned, unread) =>
            `Stores: ${stores ? "ok" : "FALTANDO"} | HTTP: ${http ? "ok" : "FALTANDO"} | analisados: ${scanned} | não lidos: ${unread}`,
        cantList: "Não consegui listar os canais (o Discord mudou?). Veja o console.",
        nothingUnread: (scanned) => `Nenhum canal não lido encontrado (${scanned} analisados).`,
        marking: (n) => `Marcando ${n} canais como lidos...`,
        partial: (done, total) => `Só ${done} de ${total} lotes funcionaram. Veja o console (Ctrl+Shift+I).`,
        success: (n) => `${n} canais marcados como lidos ✅`,
        successWithNew: (n, fresh) => `${n} canais marcados como lidos ✅ (${fresh} receberam mensagens novas agora)`,
        error: (msg) => `Erro: ${msg}`,
        httpMissing: "Módulo HTTP do Discord não encontrado.",
        serverStatus: (s) => `Servidor respondeu ${s}`,
    },
    "en-US": {
        menuLabel: "Mark EVERYTHING as read",
        markNow: "Mark everything as read now",
        includeDMs: "Include DMs and group chats",
        enableHotkey: "Enable keyboard shortcut",
        hotkeyCurrent: (combo) => `Current shortcut: ${combo} (click to change)`,
        hotkeyNone: "none",
        hotkeyPress: "Press the new key combination... (Esc cancels)",
        hotkeyNeedModifier: "Use at least Ctrl, Alt or Shift in the combination.",
        hotkeySet: (combo) => `Shortcut set: ${combo}`,
        diagnostics: "Diagnostics",
        diagResult: (stores, http, scanned, unread) =>
            `Stores: ${stores ? "ok" : "MISSING"} | HTTP: ${http ? "ok" : "MISSING"} | scanned: ${scanned} | unread: ${unread}`,
        cantList: "Couldn't list the channels (did Discord change?). Check the console.",
        nothingUnread: (scanned) => `No unread channels found (${scanned} scanned).`,
        marking: (n) => `Marking ${n} channels as read...`,
        partial: (done, total) => `Only ${done} of ${total} batches worked. Check the console (Ctrl+Shift+I).`,
        success: (n) => `${n} channels marked as read ✅`,
        successWithNew: (n, fresh) => `${n} channels marked as read ✅ (${fresh} just received new messages)`,
        error: (msg) => `Error: ${msg}`,
        httpMissing: "Discord's HTTP module was not found.",
        serverStatus: (s) => `Server responded ${s}`,
    },
};

module.exports = class MarkAllRead {
    constructor(meta) {
        this.meta = meta;
        this.defaults = { includeDMs: true, hotkeyEnabled: true, hotkeyCombo: "Ctrl+Shift+L", useNative: false };
        this.settings = Object.assign({}, this.defaults, BdApi.Data.load(meta.name, "settings") || {});
        this.onKeyDown = this.onKeyDown.bind(this);
        this.unpatchMenu = null;
        this.busy = false;
    }

    // ---------- Idioma ----------
    // Lê o idioma atual do Discord a cada uso, então acompanha a troca de idioma sem reiniciar.
    get locale() {
        let loc = null;
        try { loc = BdApi.Webpack.getStore("LocaleStore")?.locale; } catch (e) {}
        if (!loc) loc = document.documentElement.lang || navigator.language || "en-US";
        return String(loc).toLowerCase().startsWith("pt") ? "pt-BR" : "en-US";
    }

    get t() {
        return STRINGS[this.locale];
    }

    // ---------- Módulos do Discord (achados pelo comportamento, não pelo nome) ----------
    getStore(name) {
        try { return BdApi.Webpack.getStore(name); } catch (e) { return null; }
    }

    get Http() {
        if (this._http) return this._http;
        this._http = BdApi.Webpack.getModule(
            m => m && typeof m.get === "function" && typeof m.post === "function" &&
                 typeof m.put === "function" && typeof m.patch === "function",
            { searchExports: true }
        ) || null;
        return this._http;
    }

    get Dispatcher() {
        if (this._disp) return this._disp;
        const isDisp = d => d && typeof d.dispatch === "function" && typeof d.subscribe === "function";
        let d = null;
        // 1) Todo store do Discord guarda uma referência ao dispatcher
        for (const name of ["ReadStateStore", "ChannelStore", "GuildStore", "UserStore"]) {
            try {
                const s = this.getStore(name);
                if (isDisp(s?._dispatcher)) { d = s._dispatcher; break; }
            } catch (e) {}
        }
        // 2) Busca direta nos módulos
        if (!d) {
            try { d = BdApi.Webpack.getModule(isDisp, { searchExports: true }); } catch (e) {}
        }
        if (!d) d = BdApi.Webpack.getByKeys("dispatch", "subscribe") || null;
        this._disp = d;
        LOG("Dispatcher:", d ? "found" : "not found");
        return this._disp;
    }

    // ---------- Coleta de canais não lidos ----------
    getGuildChannels(guildId) {
        const CS = this.getStore("ChannelStore");
        const GCS = this.getStore("GuildChannelStore");
        let list = [];
        try {
            if (CS?.getMutableGuildChannelsForGuild) {
                list = Object.values(CS.getMutableGuildChannelsForGuild(guildId) || {});
            }
        } catch (e) {}
        if (!list.length && GCS?.getChannels) {
            try {
                const res = GCS.getChannels(guildId) || {};
                list = Object.values(res).flat().map(c => c?.channel || c).filter(Boolean);
            } catch (e) {}
        }
        return list;
    }

    getPrivateChannels() {
        const CS = this.getStore("ChannelStore");
        try {
            if (CS?.getSortedPrivateChannels) return CS.getSortedPrivateChannels();
            if (CS?.getMutablePrivateChannels) return Object.values(CS.getMutablePrivateChannels());
        } catch (e) {}
        return [];
    }

    buildItem(channel) {
        const RS = this.getStore("ReadStateStore");
        const CS = this.getStore("ChannelStore");
        if (!RS || !channel?.id) return null;
        let unread = false, mentions = 0;
        try { unread = !!RS.hasUnread(channel.id); } catch (e) {}
        try { mentions = RS.getMentionCount ? RS.getMentionCount(channel.id) : 0; } catch (e) {}
        if (!unread && !mentions) return null;

        let last = null;
        try { last = RS.lastMessageId ? RS.lastMessageId(channel.id) : null; } catch (e) {}
        if (!last) last = channel.lastMessageId || CS?.getChannel?.(channel.id)?.lastMessageId;
        if (!last) return null;
        return { channelId: channel.id, messageId: last, readStateType: 0 };
    }

    collect({ guildId = null, includeDMs = true } = {}) {
        const GS = this.getStore("GuildStore");
        const seen = new Set();
        const items = [];
        const push = (ch) => {
            if (!ch || seen.has(ch.id)) return;
            seen.add(ch.id);
            const it = this.buildItem(ch);
            if (it) items.push(it);
        };

        const guildIds = guildId ? [guildId] : Object.keys(GS?.getGuilds?.() || {});
        let scanned = 0;
        for (const gid of guildIds) {
            const chans = this.getGuildChannels(gid);
            scanned += chans.length;
            chans.forEach(push);
        }
        if (!guildId && includeDMs) {
            const dms = this.getPrivateChannels();
            scanned += dms.length;
            dms.forEach(push);
        }
        LOG(`Scanned: ${scanned} | unread found: ${items.length}`);
        return { items, scanned };
    }

    // ---------- Envio do ack ----------
    // Função nativa do Discord que marca em lote (achada pelo conteúdo do código, não pelo nome)
    get NativeBulkAck() {
        if (this._native !== undefined) return this._native;
        this._native = BdApi.Webpack.getModule(
            m => typeof m === "function" && (() => {
                try {
                    const s = m.toString();
                    return s.includes("BULK_ACK") && s.includes("read_states");
                } catch (e) { return false; }
            })(),
            { searchExports: true }
        ) || null;
        LOG("Native ack function:", this._native ? "found" : "not found");
        return this._native;
    }

    async sendChunk(chunk) {
        const native = this.settings.useNative ? this.NativeBulkAck : null;
        if (native) {
            await native(chunk);
            LOG(`Batch of ${chunk.length} sent via native function`);
            return;
        }

        const Http = this.Http;
        if (!Http) throw new Error(this.t.httpMissing);

        const res = await Http.post({
            url: "/read-states/ack-bulk",
            body: {
                read_states: chunk.map(c => ({
                    channel_id: c.channelId,
                    message_id: c.messageId,
                    read_state_type: c.readStateType
                }))
            }
        });
        LOG("Server response:", res?.status, res?.body);
        if (res && res.status && (res.status < 200 || res.status >= 300)) {
            throw new Error(this.t.serverStatus(res.status));
        }

        // Atualiza a interface local (some o ponto branco / contador)
        const D = this.Dispatcher;
        if (D) {
            try {
                D.dispatch({ type: "BULK_ACK", context: "APP", channels: chunk });
            } catch (e) {
                LOG("Failed to update local UI:", e);
            }
        }
    }

    async ackItems(items) {
        const size = 100;
        let done = 0;
        for (let i = 0; i < items.length; i += size) {
            const chunk = items.slice(i, i + size);
            try {
                await this.sendChunk(chunk);
                done += chunk.length;
            } catch (err) {
                LOG("Batch failed:", err);
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return done;
    }

    async markAll({ guildId = null } = {}) {
        if (this.busy) return;
        this.busy = true;
        try {
            const opts = { guildId, includeDMs: this.settings.includeDMs };
            const { items, scanned } = this.collect(opts);

            if (!scanned) {
                BdApi.UI.showToast(this.t.cantList, { type: "error" });
                return;
            }
            if (!items.length) {
                BdApi.UI.showToast(this.t.nothingUnread(scanned), { type: "info" });
                return;
            }

            BdApi.UI.showToast(this.t.marking(items.length), { type: "info" });
            const done = await this.ackItems(items);

            // Confere o resultado: canais muito ativos podem ter recebido mensagens novas no meio do caminho
            await new Promise(r => setTimeout(r, 2000));
            const after = this.collect(opts);

            if (done !== items.length) {
                BdApi.UI.showToast(this.t.partial(done, items.length), { type: "warning" });
                return;
            }
            if (after.items.length === 0) {
                BdApi.UI.showToast(this.t.success(done), { type: "success" });
                return;
            }

            // Marca uma segunda vez só quem recebeu mensagens novas durante a operação
            const sentIds = new Map(items.map(i => [i.channelId, i.messageId]));
            const late = after.items.filter(i => sentIds.get(i.channelId) !== i.messageId);
            if (late.length) {
                await this.ackItems(late);
                await new Promise(r => setTimeout(r, 1500));
            }
            const final = this.collect(opts);
            BdApi.UI.showToast(
                final.items.length
                    ? this.t.successWithNew(done, final.items.length)
                    : this.t.success(done),
                { type: "success" }
            );
        } catch (err) {
            LOG("Error:", err);
            BdApi.UI.showToast(this.t.error(err?.message || err), { type: "error" });
        } finally {
            this.busy = false;
        }
    }

    diagnose() {
        const stores = !!(this.getStore("ReadStateStore") && this.getStore("ChannelStore") && this.getStore("GuildStore"));
        const http = !!this.Http;
        const { items, scanned } = this.collect({ includeDMs: this.settings.includeDMs });
        LOG("Diagnostics:", { stores, http, dispatcher: !!this.Dispatcher, native: !!this.NativeBulkAck, locale: this.locale, scanned, unread: items.length });
        BdApi.UI.showToast(this.t.diagResult(stores, http, scanned, items.length), { type: "info", timeout: 8000 });
    }

    // ---------- Atalho de teclado ----------
    // Converte o evento de teclado em texto, ex.: "Ctrl+Shift+L" (usa e.code, então não é afetado pelo AltGr)
    comboFromEvent(e) {
        const code = e.code || "";
        if (/^(Control|Shift|Alt|Meta|AltGraph)/.test(code) || !code) return null;
        let key;
        if (code.startsWith("Key")) key = code.slice(3);
        else if (code.startsWith("Digit")) key = code.slice(5);
        else key = code;
        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Meta");
        parts.push(key);
        return parts.join("+");
    }

    onKeyDown(e) {
        if (!this.settings.hotkeyEnabled || this.capturing) return;
        const combo = this.comboFromEvent(e);
        if (combo && combo === this.settings.hotkeyCombo) {
            e.preventDefault();
            e.stopPropagation();
            this.markAll();
        }
    }

    // ---------- Ciclo de vida ----------
    start() {
        document.addEventListener("keydown", this.onKeyDown, true);
        try {
            this.unpatchMenu = BdApi.ContextMenu.patch("guild-context", (tree) => {
                // O rótulo é calculado a cada abertura do menu, então acompanha o idioma do Discord
                const item = BdApi.ContextMenu.buildItem({
                    type: "text",
                    label: this.t.menuLabel,
                    action: () => this.markAll()
                });
                const children = tree?.props?.children;
                if (Array.isArray(children)) {
                    children.push(BdApi.ContextMenu.buildItem({ type: "separator" }), item);
                }
            });
        } catch (e) { LOG("Couldn't add menu item:", e); }
        LOG("Plugin started (v1.8.0), language:", this.locale);
    }

    stop() {
        document.removeEventListener("keydown", this.onKeyDown, true);
        if (this.unpatchMenu) this.unpatchMenu();
        this.unpatchMenu = null;
    }

    // Botão que grava a nova combinação de teclas
    makeHotkeyButton(mkButton) {
        const label = () => this.t.hotkeyCurrent(this.settings.hotkeyCombo || this.t.hotkeyNone);
        const btn = mkButton(label(), () => {
            btn.textContent = this.t.hotkeyPress;
            this.capturing = true;
            const handler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") {
                    finish();
                    return;
                }
                const combo = this.comboFromEvent(e);
                if (!combo) return; // só apertou modificador, espera a tecla
                if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) {
                    BdApi.UI.showToast(this.t.hotkeyNeedModifier, { type: "warning" });
                    return;
                }
                this.settings.hotkeyCombo = combo;
                BdApi.Data.save(this.meta.name, "settings", this.settings);
                BdApi.UI.showToast(this.t.hotkeySet(combo), { type: "success" });
                finish();
            };
            const finish = () => {
                document.removeEventListener("keydown", handler, true);
                this.capturing = false;
                btn.textContent = label();
            };
            document.addEventListener("keydown", handler, true);
        });
        return btn;
    }

    // ---------- Painel de configurações ----------
    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "display:flex;flex-direction:column;gap:12px;padding:8px 0;";

        const mkButton = (text, onClick) => {
            const b = document.createElement("button");
            b.textContent = text;
            b.style.cssText = "padding:10px 16px;border:none;border-radius:6px;background:#5865f2;color:#fff;font-weight:600;cursor:pointer;width:fit-content;";
            b.onclick = onClick;
            return b;
        };
        const mkCheck = (label, key) => {
            const l = document.createElement("label");
            l.style.cssText = "color:var(--text-normal);display:flex;gap:8px;align-items:center;cursor:pointer;";
            const c = document.createElement("input");
            c.type = "checkbox";
            c.checked = !!this.settings[key];
            c.onchange = () => {
                this.settings[key] = c.checked;
                BdApi.Data.save(this.meta.name, "settings", this.settings);
            };
            l.append(c, label);
            return l;
        };

        panel.append(
            mkButton(this.t.markNow, () => this.markAll()),
            mkCheck(this.t.includeDMs, "includeDMs"),
            mkCheck(this.t.enableHotkey, "hotkeyEnabled"),
            this.makeHotkeyButton(mkButton),
            mkButton(this.t.diagnostics, () => this.diagnose())
        );
        return panel;
    }
};
