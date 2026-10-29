const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only surface the renderer gets.
 *
 * Nothing here takes a channel name from the caller, so the page cannot reach
 * an IPC route this file does not name. Every `invoke` returns the main
 * process's `{ok, data|error}` envelope; `unwrap` turns a failure into a thrown
 * Error so callers can just use try/catch.
 */
async function unwrap(promise) {
  const res = await promise;
  if (!res) throw new Error("主进程没有响应");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Subscribe to a push channel and hand back the unsubscribe. */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("sinan", {
  sync: {
    status: () => unwrap(ipcRenderer.invoke("sync:status")),
    pair: (input) => unwrap(ipcRenderer.invoke("sync:pair", input)),
    unpair: () => unwrap(ipcRenderer.invoke("sync:unpair")),
    syncNow: () => unwrap(ipcRenderer.invoke("sync:syncNow")),
    setScope: (scope) => unwrap(ipcRenderer.invoke("sync:setScope", scope)),
    acceptServerState: () => unwrap(ipcRenderer.invoke("sync:acceptServerState")),
    resolveVault: (choice) => unwrap(ipcRenderer.invoke("sync:resolveVault", choice)),
    onChanged: (handler) => on("sync:changed", handler),
  },
  integrations: {
    list: () => unwrap(ipcRenderer.invoke("integrations:list")),
    save: (input) => unwrap(ipcRenderer.invoke("integrations:save", input)),
    remove: (id) => unwrap(ipcRenderer.invoke("integrations:remove", id)),
    inventory: (id, force = false) =>
      unwrap(ipcRenderer.invoke("integrations:inventory", id, force)),
    bind: (input) => unwrap(ipcRenderer.invoke("integrations:bind", input)),
    importZones: (input) => unwrap(ipcRenderer.invoke("integrations:importZones", input)),
    syncZones: (id) => unwrap(ipcRenderer.invoke("integrations:syncZones", id)),
    unbind: (input) => unwrap(ipcRenderer.invoke("integrations:unbind", input)),
    dnsList: (id, zoneId, force = false) =>
      unwrap(ipcRenderer.invoke("integrations:dnsList", id, zoneId, force)),
    dnsPreview: (input) => unwrap(ipcRenderer.invoke("integrations:dnsPreview", input)),
    dnsApply: (ticket) => unwrap(ipcRenderer.invoke("integrations:dnsApply", ticket)),
    probeHistory: (id, hostId, range) =>
      unwrap(ipcRenderer.invoke("integrations:probeHistory", id, hostId, range)),
    probeCheckHistory: (id, checkId, range) =>
      unwrap(ipcRenderer.invoke("integrations:probeCheckHistory", id, checkId, range)),
    probeEnroll: (id, name) => unwrap(ipcRenderer.invoke("integrations:probeEnroll", id, name)),
    probeRevoke: (id, hostId) => unwrap(ipcRenderer.invoke("integrations:probeRevoke", id, hostId)),
    probeSaveCheck: (id, input) =>
      unwrap(ipcRenderer.invoke("integrations:probeSaveCheck", id, input)),
    probeDeleteCheck: (id, checkId) =>
      unwrap(ipcRenderer.invoke("integrations:probeDeleteCheck", id, checkId)),
  },
  documentAccounts: {
    preview: (documentId) => unwrap(ipcRenderer.invoke("document-accounts:preview", documentId)),
    commit: (input) => unwrap(ipcRenderer.invoke("document-accounts:commit", input)),
    cancel: (ticket) => unwrap(ipcRenderer.invoke("document-accounts:cancel", ticket)),
  },
  mainIdentity: {
    get: () => unwrap(ipcRenderer.invoke("main-identity:get")),
    availability: () => unwrap(ipcRenderer.invoke("main-identity:availability")),
    start: () => unwrap(ipcRenderer.invoke("main-identity:start")),
    status: (id) => unwrap(ipcRenderer.invoke("main-identity:status", id)),
    cancel: (id) => unwrap(ipcRenderer.invoke("main-identity:cancel", id)),
    bind: (input) => unwrap(ipcRenderer.invoke("main-identity:bind", input)),
    preferences: (input) => unwrap(ipcRenderer.invoke("main-identity:preferences", input)),
    refresh: () => unwrap(ipcRenderer.invoke("main-identity:refresh")),
    disconnect: () => unwrap(ipcRenderer.invoke("main-identity:disconnect")),
    loadPosts: (options) => unwrap(ipcRenderer.invoke("main-identity:loadPosts", options)),
    savePosts: (input) => unwrap(ipcRenderer.invoke("main-identity:save-posts", input)),
  },
  identities: {
    config: () => unwrap(ipcRenderer.invoke("identities:config")),
    configure: (input) => unwrap(ipcRenderer.invoke("identities:configure", input)),
    start: () => unwrap(ipcRenderer.invoke("identities:start")),
    status: (id) => unwrap(ipcRenderer.invoke("identities:status", id)),
    cancel: (id) => unwrap(ipcRenderer.invoke("identities:cancel", id)),
    commit: (input) => unwrap(ipcRenderer.invoke("identities:commit", input)),
    get: (id) => unwrap(ipcRenderer.invoke("identities:get", id)),
    refresh: (id) => unwrap(ipcRenderer.invoke("identities:refresh", id)),
    loadPosts: (id, options) => unwrap(ipcRenderer.invoke("identities:loadPosts", id, options)),
    disconnect: (id) => unwrap(ipcRenderer.invoke("identities:disconnect", id)),
    savePosts: (input) => unwrap(ipcRenderer.invoke("identities:save-posts", input)),
  },
  totp: {
    status: (id) => unwrap(ipcRenderer.invoke("totp:status", id)),
    configure: (input) => unwrap(ipcRenderer.invoke("totp:configure", input)),
    code: (id) => unwrap(ipcRenderer.invoke("totp:code", id)),
    remove: (id) => unwrap(ipcRenderer.invoke("totp:remove", id)),
  },
  passwords: {
    previewImport: () => unwrap(ipcRenderer.invoke("passwords:preview-import")),
    commitImport: (ticket) => unwrap(ipcRenderer.invoke("passwords:commit-import", ticket)),
    cancelImport: (ticket) => unwrap(ipcRenderer.invoke("passwords:cancel-import", ticket)),
    exportCsv: () => unwrap(ipcRenderer.invoke("passwords:export-csv")),
    onChanged: (handler) => on("passwords:changed", handler),
  },
  images: {
    status: () => unwrap(ipcRenderer.invoke("images:status")),
    configure: (input) => unwrap(ipcRenderer.invoke("images:configure", input)),
    upload: (input) => unwrap(ipcRenderer.invoke("images:upload", input)),
  },
  nodes: { check: (node) => unwrap(ipcRenderer.invoke("nodes:check", node)) },
  usage: {
    onChanged: (handler) => on("usage:changed", handler),
    list: () => unwrap(ipcRenderer.invoke("usage:list")),
    add: (value) => unwrap(ipcRenderer.invoke("usage:add", value)),
    update: (id, value) => unwrap(ipcRenderer.invoke("usage:update", id, value)),
    subscriptionDetails: (id) => unwrap(ipcRenderer.invoke("usage:subscription-details", id)),
    v2raynStatus: (force = false) => unwrap(ipcRenderer.invoke("usage:v2rayn-status", force)),
    chooseV2raynDirectory: () => unwrap(ipcRenderer.invoke("usage:v2rayn-directory")),
    remove: (id) => unwrap(ipcRenderer.invoke("usage:remove", id)),
    refresh: (id) => unwrap(ipcRenderer.invoke("usage:refresh", id)),
    refreshAll: () => unwrap(ipcRenderer.invoke("usage:refresh-all")),
    localStatus: () => unwrap(ipcRenderer.invoke("usage:local-status")),
    configureLocal: (input) => unwrap(ipcRenderer.invoke("usage:local-configure", input)),
    refreshLocal: () => unwrap(ipcRenderer.invoke("usage:local-refresh")),
  },
  documents: {
    onChanged: (handler) => on("documents:changed", handler),
    list: () => unwrap(ipcRenderer.invoke("documents:list")),
    get: (id) => unwrap(ipcRenderer.invoke("documents:get", id)),
    save: (doc) => unwrap(ipcRenderer.invoke("documents:save", doc)),
    remove: (id) => unwrap(ipcRenderer.invoke("documents:remove", id)),
  },
  capture: {
    list: () => unwrap(ipcRenderer.invoke("capture:list")),
    discard: (id) => unwrap(ipcRenderer.invoke("capture:discard", id)),
    onChanged: (handler) => on("capture:changed", handler),
  },
  extension: {
    status: () => unwrap(ipcRenderer.invoke("extension:status")),
    beginPairing: () => unwrap(ipcRenderer.invoke("extension:pair")),
    revoke: () => unwrap(ipcRenderer.invoke("extension:revoke")),
    list: () => unwrap(ipcRenderer.invoke("extension:list")),
    take: (id) => unwrap(ipcRenderer.invoke("extension:take", id)),
    discard: (id) => unwrap(ipcRenderer.invoke("extension:discard", id)),
    onChanged: (handler) => on("extension:changed", handler),
  },
  isDesktop: true,
  mailboxes: {
    check: (id) => unwrap(ipcRenderer.invoke("mailboxes:check", id)),
    validate: (connection) => unwrap(ipcRenderer.invoke("mailboxes:validate", connection)),
  },
  mailClient: {
    folders: (id) => unwrap(ipcRenderer.invoke("mail-client:folders", id)),
    messages: (id, options) => unwrap(ipcRenderer.invoke("mail-client:messages", id, options)),
    read: (id, selection) => unwrap(ipcRenderer.invoke("mail-client:read", id, selection)),
    seen: (id, selection, seen) =>
      unwrap(ipcRenderer.invoke("mail-client:seen", id, selection, seen)),
    send: (id, draft) => unwrap(ipcRenderer.invoke("mail-client:send", id, draft)),
    draft: (id) => unwrap(ipcRenderer.invoke("mail-client:draft", id)),
    saveDraft: (id, draft) => unwrap(ipcRenderer.invoke("mail-client:save-draft", id, draft)),
    validateSmtp: (value) => unwrap(ipcRenderer.invoke("mail-client:validate-smtp", value)),
    pickAttachments: () => unwrap(ipcRenderer.invoke("mail-client:pick-attachments")),
    download: (id, selection, index) =>
      unwrap(ipcRenderer.invoke("mail-client:download", id, selection, index)),
  },
  mailPush: {
    config: () => unwrap(ipcRenderer.invoke("mail-push:config")),
    save: (input) => unwrap(ipcRenderer.invoke("mail-push:save", input)),
    test: () => unwrap(ipcRenderer.invoke("mail-push:test")),
  },
  backup: {
    info: () => unwrap(ipcRenderer.invoke("backup:info")),
    create: (input) => unwrap(ipcRenderer.invoke("backup:create", input)),
    pick: () => unwrap(ipcRenderer.invoke("backup:pick")),
    inspect: (ticket, password) => unwrap(ipcRenderer.invoke("backup:inspect", ticket, password)),
    cancel: (ticket) => unwrap(ipcRenderer.invoke("backup:cancel", ticket)),
    restore: (ticket, password) => unwrap(ipcRenderer.invoke("backup:restore", ticket, password)),
    autoStatus: () => unwrap(ipcRenderer.invoke("backup:auto-status")),
    autoConfigure: (input) => unwrap(ipcRenderer.invoke("backup:auto-configure", input)),
    autoDirectory: () => unwrap(ipcRenderer.invoke("backup:auto-directory")),
    autoRun: () => unwrap(ipcRenderer.invoke("backup:auto-run")),
  },
  storage: {
    stats: () => unwrap(ipcRenderer.invoke("storage:stats")),
    clear: (scope) => unwrap(ipcRenderer.invoke("storage:clear", scope)),
  },
  aiAccounts: {
    list: () => unwrap(ipcRenderer.invoke("ai-accounts:list")),
    start: (provider) => unwrap(ipcRenderer.invoke("ai-accounts:start", provider)),
    status: (id) => unwrap(ipcRenderer.invoke("ai-accounts:status", id)),
    finish: (id, code) => unwrap(ipcRenderer.invoke("ai-accounts:finish", id, code)),
    cancel: (id) => unwrap(ipcRenderer.invoke("ai-accounts:cancel", id)),
    refresh: (id) => unwrap(ipcRenderer.invoke("ai-accounts:refresh", id)),
    remove: (id) => unwrap(ipcRenderer.invoke("ai-accounts:remove", id)),
  },
  profile: {
    get: () => unwrap(ipcRenderer.invoke("profile:get")),
    save: (value) => unwrap(ipcRenderer.invoke("profile:save", value)),
  },
  agent: {
    applyProposal: (id) => unwrap(ipcRenderer.invoke("agent:apply-proposal", id)),
    discardProposal: (id) => unwrap(ipcRenderer.invoke("agent:discard-proposal", id)),
    config: () => unwrap(ipcRenderer.invoke("agent:config")),
    saveConfig: (config) => unwrap(ipcRenderer.invoke("agent:save-config", config)),
    models: () => unwrap(ipcRenderer.invoke("agent:models")),
    test: () => unwrap(ipcRenderer.invoke("agent:test")),
    run: (request) => unwrap(ipcRenderer.invoke("agent:run", request)),
    cancel: (id) => unwrap(ipcRenderer.invoke("agent:cancel", id)),
    knowledge: () => unwrap(ipcRenderer.invoke("agent:knowledge")),
    rebuild: () => unwrap(ipcRenderer.invoke("agent:rebuild")),
    importDocument: () => unwrap(ipcRenderer.invoke("agent:import-document")),
    removeDocument: (id) => unwrap(ipcRenderer.invoke("agent:remove-document", id)),
    onEvent: (handler) => on("agent:event", handler),
  },

  info: () => unwrap(ipcRenderer.invoke("app:info")),
  checkUpdate: () => unwrap(ipcRenderer.invoke("app:check-update")),
  updates: {
    status: () => unwrap(ipcRenderer.invoke("app:update-status")),
    download: () => unwrap(ipcRenderer.invoke("app:download-update")),
    install: () => unwrap(ipcRenderer.invoke("app:install-update")),
    onStatus: (handler) => on("app:update-status", handler),
  },
  openDataDir: () => unwrap(ipcRenderer.invoke("shell:open-path", "userData")),
  openExternal: (url) => unwrap(ipcRenderer.invoke("shell:open-external", url)),
  pickJson: () => unwrap(ipcRenderer.invoke("dialog:pick-json")),
  display: {
    get: () => unwrap(ipcRenderer.invoke("display:get")),
    set: (zoomPercent) => unwrap(ipcRenderer.invoke("display:set", zoomPercent)),
    onChanged: (handler) => on("display:changed", handler),
    onError: (handler) => on("display:error", handler),
  },
  preferences: {
    get: () => unwrap(ipcRenderer.invoke("preferences:get")),
    set: (patch) => unwrap(ipcRenderer.invoke("preferences:set", patch)),
  },
  onAttention: (handler) => on("app:attention", handler),
  onVaultChanged: (handler) => on("vault:changed", handler),
  metrics: {
    list: (id, since) => unwrap(ipcRenderer.invoke("metrics:list", id, since)),
    onUpdated: (handler) => on("metrics:updated", handler),
    onError: (handler) => on("metrics:error", handler),
  },
  sftp: {
    list: (id, path) => unwrap(ipcRenderer.invoke("sftp:list", id, path)),
    download: (id, path) => unwrap(ipcRenderer.invoke("sftp:download", id, path)),
  },

  store: {
    onChanged: (handler) => on("assets:changed", handler),
    addDemo: () => unwrap(ipcRenderer.invoke("store:add-demo")),
    load: () => unwrap(ipcRenderer.invoke("store:load")),
    save: (snapshot) => unwrap(ipcRenderer.invoke("store:save", snapshot)),
    loadConversations: () => unwrap(ipcRenderer.invoke("store:load-conversations")),
    saveConversations: (value) => unwrap(ipcRenderer.invoke("store:save-conversations", value)),
  },

  vault: {
    status: () => unwrap(ipcRenderer.invoke("vault:status")),
    create: (master) => unwrap(ipcRenderer.invoke("vault:create", master)),
    unlock: (master) => unwrap(ipcRenderer.invoke("vault:unlock", master)),
    lock: () => unwrap(ipcRenderer.invoke("vault:lock")),
    changePassword: (oldMaster, newMaster) =>
      unwrap(ipcRenderer.invoke("vault:change-password", oldMaster, newMaster)),
    set: (id, secret) => unwrap(ipcRenderer.invoke("vault:set", id, secret)),
    get: (id) => unwrap(ipcRenderer.invoke("vault:get", id)),
    remove: (id) => unwrap(ipcRenderer.invoke("vault:remove", id)),
    list: () => unwrap(ipcRenderer.invoke("vault:list")),
  },

  ssh: {
    ...(process.platform === "win32"
      ? {
          nativeOpen: (target, appearance, bounds) =>
            unwrap(ipcRenderer.invoke("ssh:native-open", target, appearance, bounds)),
          nativeUpdate: (id, message) =>
            unwrap(ipcRenderer.invoke("ssh:native-update", id, message)),
          nativeClose: (id) => unwrap(ipcRenderer.invoke("ssh:native-close", id)),
          onNativeEvent: (handler) => on("ssh:native-event", handler),
        }
      : {}),
    open: (target, size) => unwrap(ipcRenderer.invoke("ssh:open", target, size)),
    probe: (target) => unwrap(ipcRenderer.invoke("ssh:probe", target)),
    test: (target, credential) => unwrap(ipcRenderer.invoke("ssh:test", target, credential)),
    resetHostKey: (target) => unwrap(ipcRenderer.invoke("ssh:reset-host-key", target)),
    close: (sessionId) => unwrap(ipcRenderer.invoke("ssh:close", sessionId)),
    write: (sessionId, data) => ipcRenderer.send("ssh:write", sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send("ssh:resize", sessionId, cols, rows),
    onData: (handler) => on("ssh:data", handler),
    onExit: (handler) => on("ssh:exit", handler),
  },

  win: {
    state: () => unwrap(ipcRenderer.invoke("window:state")),
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    onMaximized: (handler) => on("window:maximized", handler),
  },

  mail: {
    providers: () => unwrap(ipcRenderer.invoke("mail:providers")),
    guess: (address) => unwrap(ipcRenderer.invoke("mail:guess", address)),
    test: (options) => unwrap(ipcRenderer.invoke("mail:test", options)),
    oauthProviders: () => unwrap(ipcRenderer.invoke("mail:oauth-providers")),
    oauthSignIn: (options) => unwrap(ipcRenderer.invoke("mail:oauth-sign-in", options)),
  },

  domain: {
    probe: (name) => unwrap(ipcRenderer.invoke("domain:probe", name)),
  },

  cert: {
    probe: (host, port, servername) =>
      unwrap(ipcRenderer.invoke("cert:probe", host, port, servername)),
    parsePem: (pem) => unwrap(ipcRenderer.invoke("cert:parse-pem", pem)),
  },
});
