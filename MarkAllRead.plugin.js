/**
 * @name MarkAllRead
 * @author Gabriel
 * @description Marca todos os servidores e DMs como lidos com um clique (menu do servidor, configurações ou atalho Ctrl+Alt+R).
 * @version 1.6.1
 */

const LOG = (...a) => console.log("%c[MarkAllRead]", "color:#5865f2;font-weight:bold", ...a);

module.exports = class MarkAllRead {
    constructor(meta) {
        this.meta = meta;
        this.defaults = { includeDMs: true, hotkey: true, useNative: false };
        this.settings = Object.assign({}, this.defaults, BdApi.Data.load(meta.name, "settings") || {});
        this.onKeyDown = this.onKeyDown.bind(this);
        this.unpatchMenu = null;
        this.busy = false;
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
        LOG("Dispatcher:", d ? "encontrado" : "não encontrado");
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
        LOG(`Canais analisados: ${scanned} | não lidos encontrados: ${items.length}`);
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
        LOG("Função nativa de ack:", this._native ? "encontrada" : "não encontrada");
        return this._native;
    }

    async sendChunk(chunk) {
        const native = this.settings.useNative ? this.NativeBulkAck : null;
        if (native) {
            await native(chunk);
            LOG(`Lote de ${chunk.length} enviado pela função nativa`);
            return;
        }

        const Http = this.Http;
        if (!Http) throw new Error("Módulo HTTP do Discord não encontrado.");

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
        LOG("Resposta do servidor:", res?.status, res?.body);
        let bodyTxt = "";
        try { bodyTxt = JSON.stringify(res?.body)?.slice(0, 200) ?? ""; } catch (e) {}
        this.lastHttp = { status: res?.status, body: bodyTxt };
        if (res && res.status && (res.status < 200 || res.status >= 300)) {
            throw new Error(`Servidor respondeu ${res.status}`);
        }

        // Atualiza a interface local (some o ponto branco / contador)
        const D = this.Dispatcher;
        if (D) {
            try {
                D.dispatch({ type: "BULK_ACK", context: "APP", channels: chunk });
                this.lastDispatch = "ok";
            } catch (e) {
                LOG("Falha ao atualizar UI local:", e);
                this.lastDispatch = "erro: " + (e?.message || e);
            }
        } else {
            this.lastDispatch = "dispatcher não encontrado";
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
                LOG("Falha em um lote:", err);
                this.lastError = err;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        return done;
    }

    async markAll({ guildId = null } = {}) {
        if (this.busy) return;
        this.busy = true;
        try {
            const { items, scanned } = this.collect({ guildId, includeDMs: this.settings.includeDMs });

            if (!scanned) {
                BdApi.UI.showToast("Não consegui listar os canais (Discord mudou?). Veja o console.", { type: "error" });
                return;
            }
            if (!items.length) {
                BdApi.UI.showToast(`Nenhum canal não lido encontrado (${scanned} analisados).`, { type: "info" });
                return;
            }

            BdApi.UI.showToast(`Marcando ${items.length} canais como lidos...`, { type: "info" });
            const done = await this.ackItems(items);

            // Confere se o Discord realmente passou a considerar os canais como lidos
            await new Promise(r => setTimeout(r, 2000));
            const after = this.collect({ guildId, includeDMs: this.settings.includeDMs });
            this.logRemaining(after.items);

            if (done !== items.length) {
                BdApi.UI.showToast(`Só ${done} de ${items.length} lotes funcionaram. Veja o console (Ctrl+Shift+I).`, { type: "warning" });
            } else if (after.items.length === 0) {
                BdApi.UI.showToast(`${done} canais marcados como lidos ✅`, { type: "success" });
            } else {
                // Canais que receberam mensagens novas durante a operação: marca uma segunda vez
                const sentIds = new Map(items.map(i => [i.channelId, i.messageId]));
                const late = after.items.filter(i => sentIds.get(i.channelId) !== i.messageId);
                if (late.length) {
                    await this.ackItems(late);
                    await new Promise(r => setTimeout(r, 1500));
                }
                const final = this.collect({ guildId, includeDMs: this.settings.includeDMs });
                const stillOld = final.items.filter(i => sentIds.get(i.channelId) === i.messageId || !late.some(l => l.channelId === i.channelId));

                if (final.items.length === 0 || stillOld.length === 0) {
                    BdApi.UI.showToast(
                        `${done} canais marcados como lidos ✅` +
                        (final.items.length ? ` (${final.items.length} receberam mensagens novas agora)` : ""),
                        { type: "success" }
                    );
                } else {
                    BdApi.UI.showToast(
                        `${done} canais marcados como lidos ✅ (${stillOld.length} receberam mensagens novas agora)`,
                        { type: "success" }
                    );
                }
            }
        } catch (err) {
            LOG("Erro:", err);
            BdApi.UI.showToast(`Erro: ${err?.message || err}`, { type: "error" });
        } finally {
            this.busy = false;
        }
    }

    showReport(sent, remaining) {
        const RS = this.getStore("ReadStateStore");
        const CS = this.getStore("ChannelStore");
        const GS = this.getStore("GuildStore");
        const lines = [];
        lines.push(`Versão do plugin: 1.6.0`);
        lines.push(`Resposta do servidor: status=${this.lastHttp?.status} corpo=${this.lastHttp?.body}`);
        lines.push(`Atualização local (dispatch): ${this.lastDispatch}`);
        lines.push(`Enviados: ${sent.length} | ainda não lidos: ${remaining.length}`);
        lines.push("");
        lines.push("Amostra dos que continuam não lidos:");
        remaining.slice(0, 8).forEach((it, i) => {
            const ch = CS?.getChannel?.(it.channelId);
            const g = ch?.guild_id ? (GS?.getGuild?.(ch.guild_id)?.name || ch.guild_id) : "DM";
            let ack = "?", men = "?", cnt = "?";
            try { ack = RS.ackMessageId ? RS.ackMessageId(it.channelId) : "n/d"; } catch (e) {}
            try { men = RS.getMentionCount ? RS.getMentionCount(it.channelId) : "n/d"; } catch (e) {}
            try { cnt = RS.getUnreadCount ? RS.getUnreadCount(it.channelId) : "n/d"; } catch (e) {}
            lines.push(`${i + 1}. #${ch?.name ?? "?"} | ${g} | tipo=${ch?.type} | ack=${ack} | ultima=${it.messageId} | menções=${men} | nãoLidas=${cnt}`);
        });
        const text = lines.join("\n");
        LOG(text);
        BdApi.UI.alert(
            "MarkAllRead — relatório",
            BdApi.React.createElement("pre", {
                style: { whiteSpace: "pre-wrap", userSelect: "text", fontSize: "12px", maxHeight: "50vh", overflow: "auto", color: "var(--text-normal)" }
            }, text)
        );
    }

    logRemaining(items) {
        const RS = this.getStore("ReadStateStore");
        const CS = this.getStore("ChannelStore");
        const GS = this.getStore("GuildStore");
        const sample = items.slice(0, 15).map(it => {
            const ch = CS?.getChannel?.(it.channelId);
            const g = ch?.guild_id ? GS?.getGuild?.(ch.guild_id)?.name : "(DM)";
            let ack = null, mentions = null;
            try { ack = RS.ackMessageId ? RS.ackMessageId(it.channelId) : null; } catch (e) {}
            try { mentions = RS.getMentionCount ? RS.getMentionCount(it.channelId) : null; } catch (e) {}
            return { canal: ch?.name, servidor: g, tipo: ch?.type, ackMessageId: ack, ultimaMsg: it.messageId, mencoes: mentions };
        });
        LOG(`Ainda não lidos após o ack: ${items.length}. Amostra:`);
        console.table(sample);
    }

    diagnose() {
        const info = {
            ReadStateStore: !!this.getStore("ReadStateStore"),
            ChannelStore: !!this.getStore("ChannelStore"),
            GuildStore: !!this.getStore("GuildStore"),
            Http: !!this.Http,
            Dispatcher: !!this.Dispatcher,
            FuncaoNativa: !!this.NativeBulkAck,
        };
        const { items, scanned } = this.collect({ includeDMs: this.settings.includeDMs });
        info.canaisAnalisados = scanned;
        info.naoLidos = items.length;
        LOG("Diagnóstico:", info);
        BdApi.UI.showToast(
            `Stores: ${info.ReadStateStore && info.ChannelStore && info.GuildStore ? "ok" : "FALTANDO"} | HTTP: ${info.Http ? "ok" : "FALTANDO"} | analisados: ${scanned} | não lidos: ${items.length}`,
            { type: "info", timeout: 8000 }
        );
    }

    // ---------- Atalho: Ctrl + Alt + R ----------
    onKeyDown(e) {
        if (!this.settings.hotkey) return;
        if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key || "").toLowerCase() === "r") {
            e.preventDefault();
            this.markAll();
        }
    }

    // ---------- Ciclo de vida ----------
    start() {
        document.addEventListener("keydown", this.onKeyDown);
        try {
            this.unpatchMenu = BdApi.ContextMenu.patch("guild-context", (tree) => {
                const item = BdApi.ContextMenu.buildItem({
                    type: "text",
                    label: "Marcar TUDO como lido",
                    action: () => this.markAll()
                });
                const children = tree?.props?.children;
                if (Array.isArray(children)) {
                    children.push(BdApi.ContextMenu.buildItem({ type: "separator" }), item);
                }
            });
        } catch (e) { LOG("Não consegui adicionar item no menu:", e); }
        LOG("Plugin iniciado (v1.1.0)");
    }

    stop() {
        document.removeEventListener("keydown", this.onKeyDown);
        if (this.unpatchMenu) this.unpatchMenu();
        this.unpatchMenu = null;
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
            mkButton("Marcar tudo como lido agora", () => this.markAll()),
            mkCheck("Incluir DMs e grupos", "includeDMs"),
            mkCheck("Atalho Ctrl + Alt + R", "hotkey"),
            mkButton("Diagnóstico", () => this.diagnose())
        );
        return panel;
    }
};
