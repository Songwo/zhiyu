/** Web 复用桌面身份与分析服务；授权预览、分析任务按网页登录会话隔离。 */
import { join } from "node:path";
import { MainIdentityService } from "../electron/services/main-identity.mjs";
import { DocumentAnalysisService } from "../electron/services/document-analysis.mjs";
import { identityPostsDocument } from "../electron/services/identity-documents.mjs";

export function createWebResearch({
  serverDir,
  secureStorage,
  fetchImpl,
  documents,
  emit,
  sessionActive,
  analysisBaseUrl,
}) {
  const identity = new MainIdentityService({
    file: join(serverDir, "main-identity.enc"),
    safeStorage: secureStorage,
    fetchImpl,
    browser: true,
  });
  const analysis = new DocumentAnalysisService({
    file: join(serverDir, "document-analysis.json"),
    secureStorage,
    fetchImpl,
    ...(analysisBaseUrl ? { baseUrl: analysisBaseUrl } : {}),
    emit(event) {
      const job = jobs.get(event.id);
      if (job) {
        job.event = event;
        if (!sessionActive(job.owner)) analysis.cancel(event.id);
      }
    },
  });
  const previews = new Map();
  const jobs = new Map();
  const ttl = 5 * 60_000;
  const validOwner = (owner) => {
    if (!owner || !sessionActive(owner)) throw new Error("网页登录已过期，请重新登录。");
  };
  const ownPreview = (id, owner) => {
    const preview = previews.get(id);
    if (!preview || preview.owner !== owner || preview.expiresAt <= Date.now())
      throw new Error("本次授权不属于当前网页登录会话或已经过期。");
    return preview;
  };
  const ownJob = (id, owner) => {
    const job = jobs.get(id);
    if (!job || job.owner !== owner || job.expiresAt <= Date.now())
      throw new Error("文档分析任务不存在或不属于当前网页登录会话。");
    return job;
  };
  const clean = () => {
    for (const [id, job] of jobs)
      if ((job.done && job.expiresAt <= Date.now()) || !sessionActive(job.owner)) {
        analysis.cancel(id);
        jobs.delete(id);
      }
    for (const [id, preview] of previews)
      if (preview.expiresAt <= Date.now() || !sessionActive(preview.owner)) {
        void identity.cancel(id);
        previews.delete(id);
      }
  };
  const handlers = {
    "main-identity:get": () => identity.get(),
    "main-identity:availability": () => identity.availability(),
    "main-identity:start": async (_args, owner) => {
      const result = await identity.start();
      if (!sessionActive(owner)) {
        await identity.cancel(result.id);
        validOwner(owner);
      }
      previews.clear();
      previews.set(result.id, { owner, expiresAt: result.expiresAt });
      return result;
    },
    "main-identity:status": ([id], owner) => {
      ownPreview(id, owner);
      return identity.status(id);
    },
    "main-identity:cancel": async ([id], owner) => {
      ownPreview(id, owner);
      previews.delete(id);
      await identity.cancel(id);
    },
    "main-identity:bind": async ([options], owner) => {
      ownPreview(options?.sessionId, owner);
      const result = await identity.bind(options);
      previews.clear();
      emit("profile:changed", {});
      return result;
    },
    "main-identity:save-posts": async ([input], owner) => {
      const current = await identity.get();
      const capture = identity.captureSession();
      const assertCurrent = () => {
        validOwner(owner);
        identity.assertCurrent(capture);
      };
      const result = await identity.readPosts(input?.postIds, { force: input?.force === true });
      assertCurrent();
      if (!result.items.length) return { documentId: null, imported: 0, errors: result.errors };
      const doc = identityPostsDocument({ profile: current.profile }, result.items);
      doc.bindings = [];
      const saved = await documents().save(doc, { assertCurrent });
      emit("documents:changed", { document: saved });
      return { documentId: saved.id, imported: result.items.length, errors: result.errors };
    },
    "document-analysis:config": () => analysis.config(),
    "document-analysis:saveConfig": ([input]) => analysis.saveConfig(input),
    "document-analysis:models": () => analysis.models(),
    "document-analysis:start": ([input], owner) => {
      if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id))
        throw new Error("文档分析任务标识无效。");
      if (jobs.has(input.id) || jobs.size >= 128) throw new Error("文档分析任务已存在或过多。");
      const job = {
        owner,
        done: false,
        expiresAt: Infinity,
        event: { id: input.id, items: [], results: [] },
      };
      jobs.set(input.id, job);
      void analysis
        .run(input)
        .then(
          (result) => {
            job.result = result;
          },
          (error) => {
            job.error = error.message;
          },
        )
        .finally(() => {
          job.done = true;
          job.expiresAt = Date.now() + ttl;
        });
      return { id: input.id };
    },
    "document-analysis:status": ([id], owner) => {
      const job = ownJob(id, owner);
      return {
        ...job.event,
        done: job.done,
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
      };
    },
    "document-analysis:cancel": ([id], owner) => {
      ownJob(id, owner);
      return analysis.cancel(id);
    },
  };
  for (const method of ["preferences", "refresh", "disconnect", "loadPosts"])
    handlers[`main-identity:${method}`] = async (args) => {
      const result = await identity[method](...args);
      if (method !== "loadPosts") emit("profile:changed", {});
      return result;
    };
  for (const method of ["quota", "records", "start", "status", "cancel", "checkout"])
    handlers[`research:${method}`] = ([input]) => identity.research(method, input ?? {});
  return {
    identity,
    channels: Object.keys(handlers),
    async call(channel, args, { sessionKey } = {}) {
      validOwner(sessionKey);
      clean();
      const result = await handlers[channel](Array.isArray(args) ? args : [], sessionKey);
      validOwner(sessionKey);
      return result;
    },
    dropSessions: clean,
    stop() {
      identity.stop();
      analysis.stop();
      previews.clear();
      jobs.clear();
    },
  };
}
