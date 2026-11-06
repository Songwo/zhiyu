// 完整业务语义的合成资料，只供宣传片拍摄使用。
export function filmSnapshot(sample) {
  const date = (days) => new Date(Date.now() + days * 86400000).toISOString();
  const common = {
    demo: true,
    status: "online",
    tags: ["星桥项目"],
    notes: "项目演示资料，不连接真实账号。",
  };
  const api = {
    ...common,
    id: "starbridge-api",
    name: "星桥 API",
    category: "custom",
    provider: "Docker",
    url: "https://api.starbridge.example",
    endpoint: {
      serverId: "demo-server-0",
      port: 443,
      proto: "tcp",
      container: "starbridge-api",
      domainId: "demo-domain-1",
    },
  };
  const card = {
    ...common,
    id: "starbridge-card",
    name: "星桥项目支出卡",
    category: "custom",
    provider: "项目支出 U 卡",
    url: "",
    billing: { amount: 5, currency: "USD", cycle: "month" },
    card: {
      kind: "payment",
      network: "mastercard",
      funding: "借记卡",
      formFactor: "虚拟卡",
      last4: "6088",
      expiryMonth: "2028-09",
      region: "香港",
      regionGroup: "hmt",
    },
  };
  const esim = {
    ...common,
    id: "starbridge-esim",
    name: "亚洲差旅 eSIM",
    category: "custom",
    provider: "区域漫游套餐",
    url: "",
    billing: { amount: 68, currency: "CNY", cycle: "month" },
    card: {
      kind: "esim",
      last4: "3726",
      phone: "+852 5123 0188",
      plan: "亚洲 12 地 · 20 GB",
      carrier: "区域漫游",
      region: "香港、日本、新加坡",
      regionGroup: "overseas",
      dataGb: 20,
      planExpiresAt: date(23),
      keepAliveAt: date(178),
    },
  };
  const phone = {
    id: "starbridge-phone",
    number: "+852 5123 0188",
    label: "项目账号验证号码",
    provider: "香港移动通讯",
    expiresAt: date(178),
    notes: "用于项目订阅和差旅联络。演示号码。",
    subscriptionIds: ["demo-ai-1"],
    createdAt: date(-90),
    updatedAt: date(-1),
    billing: { amount: 38, currency: "CNY", cycle: "month" },
  };
  sample.servers[0].serviceScan = {
    collectedAt: date(0),
    ports: [
      { proto: "tcp", port: 443, scope: "public", address: "0.0.0.0", process: "caddy", pid: 1826 },
      {
        proto: "tcp",
        port: 3000,
        scope: "local",
        address: "127.0.0.1",
        process: "node",
        pid: 2140,
      },
      {
        proto: "tcp",
        port: 5432,
        scope: "private",
        address: "10.0.1.8",
        process: "postgres",
        pid: 2521,
      },
    ],
    docker: {
      available: true,
      containers: [
        {
          id: "api-6088",
          name: "starbridge-api",
          image: "starbridge/api:1.8.2",
          state: "running",
          status: "Up 18 days",
          health: "healthy",
          restartCount: 0,
          cpu: 12.6,
          memoryPct: 24.8,
          memoryUsage: "496 MiB / 2 GiB",
          ports: [{ containerPort: 3000, proto: "tcp", hostPort: 3000, hostIp: "127.0.0.1" }],
        },
        {
          id: "edge-3726",
          name: "edge-caddy",
          image: "caddy:2.9",
          state: "running",
          status: "Up 18 days",
          restartCount: 0,
          cpu: 1.8,
          memoryPct: 4.1,
          memoryUsage: "84 MiB / 2 GiB",
          ports: [{ containerPort: 443, proto: "tcp", hostPort: 443, hostIp: "0.0.0.0" }],
        },
      ],
    },
  };
  sample.servers[0].billing = { amount: 12, currency: "USD", cycle: "month" };
  sample.domains[1].billing = { amount: 72, currency: "CNY", cycle: "year" };
  return {
    ...sample,
    services: [api, card, esim],
    phoneNumbers: [phone],
    reminders: [
      {
        id: "renew-tls",
        title: "核对星桥 API 证书续期",
        note: "确认 DNS 验证与自动续期日志。",
        dueAt: date(5).slice(0, 10),
        repeat: "month",
        leadDays: 7,
      },
    ],
    links: [
      ...sample.links,
      { from: { kind: "service", id: api.id }, to: { kind: "server", id: "demo-server-0" } },
      { from: { kind: "service", id: api.id }, to: { kind: "domain", id: "demo-domain-1" } },
    ],
  };
}

// 使用真实组件回放合成的供应商进度，片中持续标注离线演示。
export async function installFilmBridge(page) {
  await page.evaluate(() => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const config = {
      enabled: true,
      model: "jev-latest",
      mode: "highlight",
      threshold: 0.75,
      fontSize: 18,
      lineHeight: 1.8,
      width: "comfortable",
      hasApiKey: true,
      rules: [
        { id: "important", label: "重要信息", description: "服务架构与关键配置", color: "#3569e8" },
        { id: "warning", label: "待办提醒", description: "续费、备份与证书维护", color: "#d38a23" },
      ],
    };
    window.__filmAnalysis = config;
    let handler = () => {};
    let searchTime = 0;
    let searchQuery = "";
    const labels = ["整理检索问题", "搜索公开资料", "读取来源摘要", "整理检索结果"];
    const results = [
      {
        title: "Docker restart policies",
        url: "https://docs.docker.com/engine/containers/start-containers-automatically/",
        publishedDate: "",
        highlights: ["按容器退出状态选择重启策略，并注意手动停止与 daemon 重启的行为。"],
      },
      {
        title: "Docker container logs",
        url: "https://docs.docker.com/reference/cli/docker/container/logs/",
        publishedDate: "",
        highlights: ["通过日志定位异常退出原因，结合时间范围查看最近输出。"],
      },
      {
        title: "Let's Encrypt integration guide",
        url: "https://letsencrypt.org/docs/integration-guide/",
        publishedDate: "",
        highlights: ["在证书到期前自动续期，核对 ACME 验证和部署后的证书。"],
      },
    ];
    const job = () => {
      const step = Math.min(4, Math.floor((Date.now() - searchTime) / 1350));
      return {
        id: "starbridge-research",
        query: searchQuery,
        state: step === 4 ? "complete" : "searching",
        free: true,
        price: "0",
        purchaseUnits: 0,
        paymentUrl: null,
        items: labels
          .slice(0, Math.min(4, step + 1))
          .map((label, index) => ({
            id: `search-${index}`,
            label,
            status: index < step ? "done" : "running",
            startedAt: searchTime + index * 1350,
            ...(index < step ? { endedAt: searchTime + (index + 1) * 1350 } : {}),
          })),
        ...(step === 4 ? { results } : {}),
      };
    };
    window.sinan = {
      isDesktop: true,
      win: {
        state: async () => ({ platform: "win32", maximized: false }),
        onMaximized: () => () => {},
      },
      preferences: { set: async () => ({}) },
      vault: { status: async () => ({ exists: false, unlocked: false }) },
      onVaultChanged: () => () => {},
      metrics: { list: async () => [], onUpdated: () => () => {}, onError: () => () => {} },
      documentAnalysis: {
        config: async () => ({ ...config }),
        saveConfig: async (next) => Object.assign(config, next),
        models: async () => ({ models: ["jev-latest"] }),
        cancel: async () => true,
        onEvent: (callback) => {
          handler = callback;
          return () => {
            handler = () => {};
          };
        },
        run: async ({ id, blocks }) => {
          const items = [],
            marked = [];
          for (let index = 0; index < blocks.length; index++) {
            const startedAt = Date.now();
            items.push({
              id: `paragraph-${index}`,
              label: `分析第 ${index + 1} / ${blocks.length} 段`,
              status: "running",
              startedAt,
            });
            handler({ id, items: structuredClone(items), results: [...marked] });
            await wait(620);
            const choice = /续期|备份|到期|清单/.test(blocks[index].text) ? "warning" : "important";
            marked.push({ id: blocks[index].id, choice, confidence: index % 2 ? 0.94 : 0.97 });
            items[index] = { ...items[index], status: "done", endedAt: Date.now() };
            handler({ id, items: structuredClone(items), results: [...marked] });
          }
          return { items, results: marked };
        },
      },
      research: {
        quota: async () => ({
          configured: true,
          freeRemaining: searchTime && Date.now() - searchTime > 5400 ? 36 : 37,
          freeUsed: 13,
          freeLimit: 50,
          paidRemaining: 100,
          paidTotal: 100,
          paidUsed: 0,
          price: "10.00",
          purchaseUnits: 100,
          paymentConfigured: false,
          purchaseGuardConfigured: false,
          exaStatus: "ready",
          balanceKnown: true,
          pendingJobId: null,
        }),
        records: async () => ({ entries: [], nextOffset: null }),
        start: async ({ query }) => {
          searchTime = Date.now();
          searchQuery = query;
          return job();
        },
        status: async () => job(),
        cancel: async () => true,
      },
    };
  });
}
