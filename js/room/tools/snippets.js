/**
 * SeeMyGame - SnippetsManager
 * 
 * Gerenciador de Snippets de Código Colaborativo para Salas SeeMyGame:
 * - Compartilhamento de binds, scripts, configs e macros
 * - Concorrência com licença de edição temporária (Lease) concedida pelo coordenador
 * - Preservação automática de rascunho local em caso de conflito ou perda de licença
 * - Renderização estritamente textual (zero execução de código/XSS)
 * - Allowlist de linguagens, cópia para clipboard e exportação de arquivo
 * - Orçamento controlado (<=64 KiB por snippet, <=128 KiB agregado)
 */

export const ALLOWED_LANGUAGES = Object.freeze([
  'javascript',
  'typescript',
  'python',
  'rust',
  'html',
  'css',
  'json',
  'bash',
  'sql',
  'markdown',
  'plaintext'
]);

export const MAX_SNIPPET_BYTES = 65536; // 64 KiB
export const MAX_AGGREGATE_BYTES = 131072; // 128 KiB
export const LEASE_DURATION_MS = 30000; // 30s

export class SnippetsManager {
  constructor(options = {}) {
    this.service = options.service || null;
    this.getLocalPeerId = options.getLocalPeerId || (() => 'me');
    this.getDisplayName = options.getDisplayName || (() => 'Jogador');
    this.isHost = typeof options.isHost === 'function' ? options.isHost : () => Boolean(options.isHost);
    this.getIsReadonly = typeof options.getIsReadonly === 'function'
      ? options.getIsReadonly
      : () => Boolean(options.isReadonly);

    this.snippets = new Map(); // id -> snippet object
    this.localDrafts = new Map(); // id -> { content, title, language, lastSaved }
    this.activeSnippetId = null;
    this.leaseHeartbeatTimer = null;
    this.listeners = new Set();
    this.modalEl = null;

    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  setService(service) {
    this.service = service;
    if (this.service) {
      this._bindWithService(this.service);
    }
  }

  _bindWithService(service) {
    service.registerFeature('snippets', {
      maxEntityBytes: MAX_SNIPPET_BYTES,
      maxAggregateBytes: MAX_AGGREGATE_BYTES,
      applyProposal: (payload, meta) => this._applyProposalOnHost(payload, meta),
      applyConfirm: (payload, meta) => this._applyConfirmOnClient(payload, meta),
      getSnapshot: () => this.getSnapshot(),
      applySnapshot: (snapshot) => this.applySnapshot(snapshot)
    });
  }

  sanitizeLanguage(lang) {
    const raw = String(lang || '').toLowerCase().trim();
    return ALLOWED_LANGUAGES.includes(raw) ? raw : 'plaintext';
  }

  calculateTotalBytes() {
    let bytes = 0;
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    for (const s of this.snippets.values()) {
      const text = `${s.title}${s.content}`;
      bytes += encoder ? encoder.encode(text).length : text.length;
    }
    return bytes;
  }

  _applyProposalOnHost(payload, { authorPeerId, entityId }) {
    const { action } = payload;
    const now = Date.now();

    switch (action) {
      case 'create': {
        const title = String(payload.title || 'Snippet sem título').slice(0, 100);
        const language = this.sanitizeLanguage(payload.language);
        const content = String(payload.content || '');

        const textLen = (title + content).length;
        if (textLen > MAX_SNIPPET_BYTES) {
          return { success: false, reason: 'size_limit_exceeded' };
        }
        if (this.calculateTotalBytes() + textLen > MAX_AGGREGATE_BYTES) {
          return { success: false, reason: 'aggregate_limit_exceeded' };
        }

        const id = entityId || `snip_${now}_${Math.random().toString(36).slice(2, 7)}`;
        const snippet = {
          id,
          title,
          language,
          content,
          authorPeerId,
          revision: 1,
          editorPeerId: null,
          leaseExpiresAt: 0,
          updatedAt: now
        };

        this.snippets.set(id, snippet);
        return { success: true, payload: { action: 'create', snippet } };
      }

      case 'request_lease': {
        const snippet = this.snippets.get(entityId);
        if (!snippet) return { success: false, reason: 'snippet_not_found' };

        // Se outro participante tiver licença ativa não expirada, recusa
        if (snippet.editorPeerId && snippet.editorPeerId !== authorPeerId && snippet.leaseExpiresAt > now) {
          return {
            success: false,
            reason: 'already_leased',
            payload: { activeEditor: snippet.editorPeerId, expiresAt: snippet.leaseExpiresAt }
          };
        }

        snippet.editorPeerId = authorPeerId;
        snippet.leaseExpiresAt = now + LEASE_DURATION_MS;
        snippet.updatedAt = now;
        return {
          success: true,
          payload: {
            action: 'lease_granted',
            id: entityId,
            editorPeerId: authorPeerId,
            leaseExpiresAt: snippet.leaseExpiresAt
          }
        };
      }

      case 'release_lease': {
        const snippet = this.snippets.get(entityId);
        if (!snippet) return { success: false, reason: 'snippet_not_found' };

        if (snippet.editorPeerId === authorPeerId || this.isHost()) {
          snippet.editorPeerId = null;
          snippet.leaseExpiresAt = 0;
          snippet.updatedAt = now;
          return {
            success: true,
            payload: { action: 'lease_released', id: entityId }
          };
        }
        return { success: false, reason: 'not_lease_holder' };
      }

      case 'update': {
        const snippet = this.snippets.get(entityId);
        if (!snippet) return { success: false, reason: 'snippet_not_found' };

        // Permitido se for o detentor da licença ou o host coordenador
        const isHolder = snippet.editorPeerId === authorPeerId && snippet.leaseExpiresAt > now;
        if (!isHolder && !this.isHost()) {
          return { success: false, reason: 'lease_expired_or_invalid' };
        }

        const title = payload.title !== undefined ? String(payload.title).slice(0, 100) : snippet.title;
        const language = payload.language !== undefined ? this.sanitizeLanguage(payload.language) : snippet.language;
        const content = payload.content !== undefined ? String(payload.content) : snippet.content;

        const textLen = (title + content).length;
        if (textLen > MAX_SNIPPET_BYTES) {
          return { success: false, reason: 'size_limit_exceeded' };
        }

        snippet.title = title;
        snippet.language = language;
        snippet.content = content;
        snippet.revision++;
        snippet.updatedAt = now;
        if (payload.releaseLease) {
          snippet.editorPeerId = null;
          snippet.leaseExpiresAt = 0;
        }

        return {
          success: true,
          payload: { action: 'update', snippet: { ...snippet } }
        };
      }

      case 'delete': {
        const snippet = this.snippets.get(entityId);
        if (!snippet) return { success: false, reason: 'snippet_not_found' };

        if (snippet.authorPeerId !== authorPeerId && !this.isHost()) {
          return { success: false, reason: 'unauthorized_deletion' };
        }

        this.snippets.delete(entityId);
        return { success: true, payload: { action: 'delete', id: entityId } };
      }

      case 'duplicate': {
        const snippet = this.snippets.get(entityId);
        if (!snippet) return { success: false, reason: 'snippet_not_found' };

        const dupId = `snip_${now}_${Math.random().toString(36).slice(2, 7)}`;
        const dupSnippet = {
          id: dupId,
          title: `Cópia de ${snippet.title}`.slice(0, 100),
          language: snippet.language,
          content: snippet.content,
          authorPeerId,
          revision: 1,
          editorPeerId: null,
          leaseExpiresAt: 0,
          updatedAt: now
        };

        this.snippets.set(dupId, dupSnippet);
        return { success: true, payload: { action: 'create', snippet: dupSnippet } };
      }

      default:
        return { success: false, reason: 'unknown_action' };
    }
  }

  _applyConfirmOnClient(payload) {
    if (!payload || !payload.action) return;
    const { action } = payload;

    switch (action) {
      case 'create': {
        if (payload.snippet) {
          this.snippets.set(payload.snippet.id, payload.snippet);
        }
        break;
      }
      case 'lease_granted': {
        const s = this.snippets.get(payload.id);
        if (s) {
          s.editorPeerId = payload.editorPeerId;
          s.leaseExpiresAt = payload.leaseExpiresAt;
        }
        break;
      }
      case 'lease_released': {
        const s = this.snippets.get(payload.id);
        if (s) {
          s.editorPeerId = null;
          s.leaseExpiresAt = 0;
        }
        break;
      }
      case 'update': {
        if (payload.snippet) {
          this.snippets.set(payload.snippet.id, payload.snippet);
          // Se sou o autor local e o servidor confirmou, podemos limpar rascunho
          if (this.localDrafts.has(payload.snippet.id)) {
            this.localDrafts.delete(payload.snippet.id);
          }
        }
        break;
      }
      case 'delete': {
        this.snippets.delete(payload.id);
        this.localDrafts.delete(payload.id);
        if (this.activeSnippetId === payload.id) {
          this.activeSnippetId = null;
        }
        break;
      }
    }
    this._notify();
  }

  getSnapshot() {
    return Array.from(this.snippets.values());
  }

  applySnapshot(snapshot) {
    if (!Array.isArray(snapshot)) return;
    this.snippets.clear();
    for (const item of snapshot) {
      if (item && item.id) {
        this.snippets.set(item.id, { ...item });
      }
    }
    this._notify();
  }

  async createSnippet({ title, language, content }) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = {
      action: 'create',
      title: title || 'Novo Snippet',
      language: this.sanitizeLanguage(language),
      content: content || ''
    };

    if (this.service) {
      return this.service.propose('snippets', { payload });
    }
    // Modo local / standalone
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId() });
  }

  async requestEditLease(snippetId) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    const payload = { action: 'request_lease' };
    let res = null;
    if (this.service) {
      res = await this.service.propose('snippets', { entityId: snippetId, payload });
    } else {
      res = this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: snippetId });
    }

    if (res?.success) {
      this.activeSnippetId = snippetId;
      this._startLeaseHeartbeat(snippetId);
    }
    return res;
  }

  async releaseEditLease(snippetId) {
    this._stopLeaseHeartbeat();
    const payload = { action: 'release_lease' };
    if (this.service) {
      return this.service.propose('snippets', { entityId: snippetId, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: snippetId });
  }

  async updateSnippet(snippetId, { title, language, content, releaseLease = false }) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };

    // Salvar rascunho local de segurança antes do envio
    this.localDrafts.set(snippetId, { title, language, content, timestamp: Date.now() });

    const payload = {
      action: 'update',
      title,
      language: this.sanitizeLanguage(language),
      content,
      releaseLease
    };

    let res = null;
    if (this.service) {
      res = await this.service.propose('snippets', { entityId: snippetId, payload });
    } else {
      res = this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: snippetId });
    }

    if (res?.success) {
      this.localDrafts.delete(snippetId);
      if (releaseLease) {
        this._stopLeaseHeartbeat();
        if (this.activeSnippetId === snippetId) this.activeSnippetId = null;
      }
    }
    return res;
  }

  async deleteSnippet(snippetId) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'delete' };
    if (this.service) {
      return this.service.propose('snippets', { entityId: snippetId, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: snippetId });
  }

  async duplicateSnippet(snippetId) {
    if (this.getIsReadonly()) return { success: false, reason: 'readonly_not_permitted' };
    const payload = { action: 'duplicate' };
    if (this.service) {
      return this.service.propose('snippets', { entityId: snippetId, payload });
    }
    return this._applyProposalOnHost(payload, { authorPeerId: this.getLocalPeerId(), entityId: snippetId });
  }

  _startLeaseHeartbeat(snippetId) {
    this._stopLeaseHeartbeat();
    this.leaseHeartbeatTimer = setInterval(() => {
      const s = this.snippets.get(snippetId);
      if (s && s.editorPeerId === this.getLocalPeerId()) {
        // Envia renovação de lease
        if (this.service) {
          this.service.propose('snippets', {
            entityId: snippetId,
            payload: { action: 'request_lease' }
          }).catch(() => {});
        }
      } else {
        this._stopLeaseHeartbeat();
      }
    }, 15000);
  }

  _stopLeaseHeartbeat() {
    if (this.leaseHeartbeatTimer) {
      clearInterval(this.leaseHeartbeatTimer);
      this.leaseHeartbeatTimer = null;
    }
  }

  handlePeerDisconnected(peerId) {
    if (!peerId) return;
    // Se o peer que desconectou tinha uma licença ativa, o coordenador libera
    let changed = false;
    for (const snippet of this.snippets.values()) {
      if (snippet.editorPeerId === peerId) {
        snippet.editorPeerId = null;
        snippet.leaseExpiresAt = 0;
        changed = true;
      }
    }
    if (changed && this.isHost()) {
      this.service?.broadcastFullSync();
      this._notify();
    }
  }

  async copyToClipboard(snippetId) {
    const s = this.snippets.get(snippetId);
    if (!s) return false;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(s.content);
        return true;
      } catch (_) {}
    }
    return false;
  }

  exportFile(snippetId) {
    if (typeof document === 'undefined') return false;
    const s = this.snippets.get(snippetId);
    if (!s) return false;

    const extMap = {
      javascript: 'js',
      typescript: 'ts',
      python: 'py',
      rust: 'rs',
      html: 'html',
      css: 'css',
      json: 'json',
      bash: 'sh',
      sql: 'sql',
      markdown: 'md',
      plaintext: 'txt'
    };
    const ext = extMap[s.language] || 'txt';
    const blob = new Blob([s.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'snippet'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    return true;
  }

  getSnippetsList() {
    return Array.from(this.snippets.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSnippet(id) {
    return this.snippets.get(id) || null;
  }

  getLocalDraft(id) {
    return this.localDrafts.get(id) || null;
  }

  onChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notify() {
    this.listeners.forEach(fn => {
      try { fn(this.getSnippetsList()); } catch (_) {}
    });
  }

  dispose() {
    this._stopLeaseHeartbeat();
    this.snippets.clear();
    this.localDrafts.clear();
    this.listeners.clear();
  }
}
