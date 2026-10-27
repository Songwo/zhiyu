import { hostBridge } from "./web-bridge";
import { canProbeServer } from "./server-observation.mjs";
import { ProbeFlights, currentProbeAsset } from "./probe-guard";
import { shouldRefreshProbe } from "./probe-cache.mjs";
import { create } from "zustand";
import { formatUptime } from "./desktop";
import { useLive } from "./live";
import { expiryStatus } from "./status";
import { useAppStore } from "./store";
import type { Certificate, Domain, Server, Status } from "./types";

/** Which assets have a probe in flight, so the UI can show it spinning. */
interface ProbeState {
  busy: Record<string, boolean>;
  set: (id: string, busy: boolean) => void;
}

export const useProbeState = create<ProbeState>((set) => ({
  busy: {},
  set: (id, busy) =>
    set((s) => {
      const next = { ...s.busy };
      if (busy) next[id] = true;
      else delete next[id];
      return { busy: next };
    }),
}));

const flights = new ProbeFlights();

const busy = (id: string, on: boolean) => useProbeState.getState().set(id, on);

/** A host is "warning" while it is loaded, "offline" only when unreachable. */
function hostStatus(cpu?: number, memory?: number, disk?: number): Status {
  const hot = [cpu, memory, disk].filter((n): n is number => typeof n === "number");
  if (hot.some((n) => n >= 90)) return "offline";
  if (hot.some((n) => n >= 78)) return "warning";
  return "online";
}

/**
 * SSH into one host, read its real numbers, write them back onto the card.
 *
 * A failure is recorded on the asset rather than thrown: the card should say
 * why it is red, and the caller (a "refresh all" sweep) must not stop at the
 * first unreachable box.
 */
export function refreshServer(server: Server): Promise<void> {
  return flights.run("server:" + server.id, () => probeServer(server));
}

async function probeServer(server: Server): Promise<void> {
  if (server.demo || !canProbeServer(server)) return;
  const bridge = hostBridge();
  if (!bridge) return;
  busy(server.id, true);
  const store = useAppStore.getState();
  try {
    const probe = await bridge.ssh.probe({
      id: server.id,
      host: server.host,
      port: server.port,
      username: server.username,
    });
    const current = currentProbeAsset(useAppStore.getState().servers, server, [
      "host",
      "port",
      "username",
    ]);
    if (!current) return;
    const next: Server = {
      ...current,
      os: probe.os ?? current.os,
      kernel: probe.kernel,
      cpu: probe.cpu ?? current.cpu,
      memory: probe.memory ?? current.memory,
      disk: probe.disk ?? current.disk,
      uptime: formatUptime(probe.uptimeSeconds) ?? current.uptime,
      loadavg: probe.loadavg,
      memTotalKb: probe.memTotalKb,
      diskTotalKb: probe.diskTotalKb,
      status: hostStatus(probe.cpu, probe.memory, probe.disk),
      lastSeen: probe.at,
      probedAt: probe.at,
      probeError: undefined,
    };
    store.upsertServer(next);
    // The cards read live metrics from here, so keep the two in step.
    useLive.getState().set(server.id, next.cpu, next.memory);
  } catch (err) {
    const current = currentProbeAsset(useAppStore.getState().servers, server, [
      "host",
      "port",
      "username",
    ]);
    if (!current) return;

    store.upsertServer({
      ...current,
      status: "offline",
      probedAt: new Date().toISOString(),
      probeError: message(err),
    });
  } finally {
    busy(server.id, false);
  }
}

export function refreshDomain(domain: Domain): Promise<void> {
  return flights.run("domain:" + domain.id, () => probeDomain(domain));
}

async function probeDomain(domain: Domain): Promise<void> {
  if (domain.demo) return;
  const bridge = hostBridge();
  if (!bridge) return;
  busy(domain.id, true);
  const store = useAppStore.getState();
  try {
    const probe = await bridge.domain.probe(domain.name);
    const current = currentProbeAsset(useAppStore.getState().domains, domain, ["name"]);
    if (!current) return;
    const expiresAt = probe.expiresAt ?? current.expiresAt;
    store.upsertDomain({
      ...current,
      registrar: probe.registrar ?? current.registrar,
      expiresAt,
      dns: probe.dns ?? current.dns,
      nameservers: probe.nameservers.length ? probe.nameservers : current.nameservers,
      autoRenew: probe.autoRenew ?? current.autoRenew,
      statuses: probe.statuses,
      createdAt: probe.createdAt,
      status: expiryStatus(expiresAt),
      probedAt: probe.at,
      probeError: undefined,
    });
  } catch (err) {
    const current = currentProbeAsset(useAppStore.getState().domains, domain, ["name"]);
    if (!current) return;

    store.upsertDomain({
      ...current,
      probedAt: new Date().toISOString(),
      probeError: message(err),
    });
  } finally {
    busy(domain.id, false);
  }
}

/** Where to actually open the TLS connection for a certificate row. */
export function certHost(cert: Certificate): string {
  return (cert.host ?? cert.cn).replace(/^\*\./, "");
}

export function refreshCert(cert: Certificate): Promise<void> {
  return flights.run("cert:" + cert.id, () => probeCert(cert));
}

async function probeCert(cert: Certificate): Promise<void> {
  if (cert.demo) return;
  const bridge = hostBridge();
  if (!bridge) return;
  busy(cert.id, true);
  const store = useAppStore.getState();
  try {
    const probe = await bridge.cert.probe(certHost(cert), cert.port ?? 443);
    const current = currentProbeAsset(useAppStore.getState().certs, cert, ["host", "cn", "port"]);
    if (!current) return;
    store.upsertCert({
      ...current,
      cn: probe.cn || cert.cn,
      issuer: probe.issuer,
      expiresAt: probe.expiresAt,
      sans: probe.sans.length ? probe.sans : cert.sans,
      trusted: probe.trusted,
      untrustedReason: probe.untrustedReason,
      protocol: probe.protocol,
      // An untrusted chain is a problem even when the dates are fine.
      status: probe.trusted ? expiryStatus(probe.expiresAt) : "offline",
      probedAt: probe.at,
      probeError: undefined,
    });
  } catch (err) {
    const current = currentProbeAsset(useAppStore.getState().certs, cert, ["host", "cn", "port"]);
    if (!current) return;

    store.upsertCert({
      ...current,
      probedAt: new Date().toISOString(),
      probeError: message(err),
    });
  } finally {
    busy(cert.id, false);
  }
}

/** Which asset kinds have something real to go and check. */
export const PROBEABLE = ["server", "domain", "cert"] as const;
export type ProbeKind = (typeof PROBEABLE)[number];

/** Refresh a single asset by kind and id — used by the detail sheet. */
export async function refreshById(kind: ProbeKind, id: string): Promise<void> {
  const s = useAppStore.getState();
  if (kind === "server") {
    const x = s.servers.find((v) => v.id === id);
    if (x) await refreshServer(x);
  } else if (kind === "domain") {
    const x = s.domains.find((v) => v.id === id);
    if (x) await refreshDomain(x);
  } else {
    const x = s.certs.find((v) => v.id === id);
    if (x) await refreshCert(x);
  }
}

/** Refresh every asset of one kind, a few at a time so 30 hosts do not stampede. */
export async function refreshAll(
  kind: "server" | "domain" | "cert",
  options: { force?: boolean; minAgeMs?: number } = {},
): Promise<number> {
  const bridge = hostBridge();
  if (!bridge) return 0;
  const s = useAppStore.getState();
  const jobs: Array<() => Promise<void>> =
    kind === "server"
      ? s.servers
          .filter((x) => !x.demo && canProbeServer(x) && shouldRefreshProbe(x, options))
          .map((x) => () => refreshServer(x))
      : kind === "domain"
        ? s.domains
            .filter((x) => !x.demo && shouldRefreshProbe(x, options))
            .map((x) => () => refreshDomain(x))
        : s.certs
            .filter((x) => !x.demo && shouldRefreshProbe(x, options))
            .map((x) => () => refreshCert(x));

  const CONCURRENCY = 4;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        await job();
      }
    }),
  );
  return jobs.length;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
