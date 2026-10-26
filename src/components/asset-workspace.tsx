import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Network,
  Pencil,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useAppStore } from "@/lib/store";
import { useSettings } from "@/lib/settings";
import { useDocuments } from "@/lib/documents";
import { confirmedRelations, relatedResources, resourceRows } from "@/lib/resource-relations.mjs";
import { assetRows, filterAssetRows, VIEW_ASSET_KIND, type AssetRow } from "@/lib/asset-view";
import type { AssetKind } from "@/lib/types";
import { formatBilling } from "@/lib/billing";
import { refKey } from "@/lib/operations";
import { KIND_LABEL } from "@/lib/status";
import { t, getLocale, intlLocale } from "@/lib/i18n";
import { daysUntil, formatDate, formatUsd } from "@/lib/utils";
import { openFromEvent } from "./asset-card";
import { Button } from "./ui/button";
import { Select } from "./ui/input";
import { StatusBadge } from "./ui/status-badge";
import { DnsManager } from "./integrations/dns-manager";

const AssetGraph = lazy(() => import("./asset-graph"));

export function AssetWorkspace() {
  const s = useAppStore();
  const configuredLayout = useSettings((state) => state.assetLayout);
  const layout = s.view === "relations" ? "graph" : configuredLayout;
  const kind = VIEW_ASSET_KIND[s.view];
  const documents = useDocuments((state) => state.list);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (layout === "graph") void useDocuments.getState().load();
  }, [layout]);
  const rows = useMemo(
    () => filterAssetRows(assetRows(s), s.view, s.query, s.filter === "attention", s.tagFilter),
    [s],
  );
  const resources = useMemo(() => resourceRows(assetRows(s), documents, s), [s, documents]);
  const relations = useMemo(
    () => confirmedRelations(resources, s.links, documents),
    [resources, s.links, documents],
  );
  const graphRows =
    s.view === "relations" || all
      ? resources.filter((row) => !s.query || row.search.includes(s.query.toLocaleLowerCase()))
      : relatedResources(resources, relations, rows);
  return (
    <div className="asset-workspace">
      <div className="workspace-summary flex flex-wrap items-center justify-between gap-2">
        <span>
          {layout === "graph"
            ? t("{0} 项资源", graphRows.length.toLocaleString(intlLocale()))
            : t("{0} 项资产", rows.length.toLocaleString(intlLocale()))}
        </span>
        {layout === "graph" && s.view !== "relations" && (
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
            {t(all ? "当前资产与关联资源" : "全部资源")}
          </Button>
        )}
      </div>
      {layout === "graph" ? (
        <Suspense
          fallback={
            <p className="workspace-empty" role="status">
              {t("读取中…")}
            </p>
          }
        >
          <AssetGraph rows={graphRows} resources={resources} relations={relations} />
        </Suspense>
      ) : rows.length === 0 ? (
        <p className="workspace-empty">{t("没有匹配的资产")}</p>
      ) : (
        <AssetTable key={kind ?? "all"} rows={rows} kind={kind} />
      )}
    </div>
  );
}

/** 各类资产在表格里关心的列不同：主机看 CPU 与内存，AI 订阅看用量与续费，域名看注册商与 NS。 */
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 声明合并要求泛型参数与原接口一致
  interface ColumnMeta<TData, TValue> {
    width?: number;
  }
}

const SECRET_KIND_LABEL: Record<string, string> = {
  api: "API 密钥",
  ssh: "SSH 密钥",
  password: "密码",
  token: "访问令牌",
  account: "账号",
};
const MAIL_KIND_LABEL: Record<string, string> = {
  mailbox: "邮箱",
  alias: "别名",
  forward: "转发",
};
const SERVICE_CATEGORY_LABEL: Record<string, string> = {
  worker: "Workers",
  blog: "博客",
  mail: "邮件",
  custom: "自建服务",
};

function AssetTable({ rows, kind }: { rows: AssetRow[]; kind?: AssetKind }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [dns, setDns] = useState<AssetRow | null>(null);
  const locale = getLocale();
  const columns = useMemo<ColumnDef<AssetRow>[]>(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    const dash = "-";
    const name = (header: string): ColumnDef<AssetRow> => ({
      accessorKey: "name",
      header,
      meta: { width: 210 },
      sortingFn: (a, b) => collator.compare(a.original.name, b.original.name),
      cell: ({ row }) => (
        <button
          className="asset-name"
          onClick={(e) => openFromEvent(e, row.original.kind, row.original.id)}
        >
          <span>{row.original.name}</span>
          <small>{row.original.detail}</small>
        </button>
      ),
    });
    const type: ColumnDef<AssetRow> = {
      accessorKey: "kind",
      header: t("类型"),
      meta: { width: 90 },
      cell: ({ row }) => t(KIND_LABEL[row.original.kind]),
    };
    const status: ColumnDef<AssetRow> = {
      accessorKey: "status",
      header: t("状态"),
      meta: { width: 90 },
      sortingFn: (a, b) =>
        ({ offline: 0, warning: 1, online: 2 })[a.original.status] -
        { offline: 0, warning: 1, online: 2 }[b.original.status],
      cell: ({ row }) => (
        <StatusBadge status={row.original.status} pending={row.original.pending} />
      ),
    };
    const expires = (header: string): ColumnDef<AssetRow> => ({
      accessorKey: "expires",
      header,
      meta: { width: 140 },
      sortUndefined: "last",
      cell: ({ row }) => {
        const value = row.original.expires;
        if (!value) return dash;
        const days = daysUntil(value);
        return (
          <span className="table-stack">
            <span>{formatDate(value)}</span>
            {Number.isFinite(days) && (
              <small className={days <= 7 ? "table-stack-warn" : undefined}>
                {days <= 0 ? t("已过期") : t("{0} 天后", days)}
              </small>
            )}
          </span>
        );
      },
    });
    const metric = (id: "cpu" | "memory" | "disk", header: string): ColumnDef<AssetRow> => ({
      accessorKey: id,
      header,
      meta: { width: 76 },
      sortUndefined: "last",
      cell: ({ row }) => percent(row.original[id]),
    });
    const text = (
      id: string,
      header: string,
      value: (row: AssetRow) => string | undefined,
      width = 110,
    ): ColumnDef<AssetRow> => ({
      id,
      header,
      meta: { width },
      accessorFn: (row) => value(row) ?? "",
      sortingFn: (a, b) => collator.compare(value(a.original) ?? "", value(b.original) ?? ""),
      cell: ({ row }) => <span className="table-ellipsis">{value(row.original) || dash}</span>,
    });
    const cost: ColumnDef<AssetRow> = {
      id: "cost",
      header: t("费用"),
      meta: { width: 100 },
      accessorFn: (row) => row.billing?.amount ?? row.monthlyUsd ?? -1,
      cell: ({ row }) =>
        row.original.billing
          ? formatBilling(row.original.billing)
          : row.original.monthlyUsd === undefined
            ? dash
            : formatUsd(row.original.monthlyUsd),
    };
    const tags: ColumnDef<AssetRow> = {
      id: "tags",
      header: t("标签"),
      meta: { width: 110 },
      enableSorting: false,
      cell: ({ row }) => (
        <div className="table-tags">
          {row.original.tags.map((tag) => (
            <button key={tag} title={tag} onClick={() => useAppStore.getState().toggleTag(tag)}>
              {tag}
            </button>
          ))}
        </div>
      ),
    };
    const actions: ColumnDef<AssetRow> = {
      id: "actions",
      header: t("操作"),
      meta: { width: kind === "domain" ? 128 : 94 },
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex items-center">
          {row.original.kind === "domain" &&
            row.original.integration?.provider === "cloudflare" &&
            row.original.integration.resourceType === "zone" && (
              <Button
                size="icon-sm"
                variant="ghost"
                title={t("管理 DNS")}
                aria-label={t("管理 {0} 的 DNS", row.original.name)}
                onClick={() => setDns(row.original)}
              >
                <Network className="size-4" />
              </Button>
            )}
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("资产详情")}
            aria-label={t("查看 {0}", row.original.name)}
            onClick={(e) => openFromEvent(e, row.original.kind, row.original.id)}
          >
            <ExternalLink className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("编辑")}
            aria-label={t("编辑 {0}", row.original.name)}
            onClick={() => useAppStore.getState().openComposer(row.original.kind, row.original.id)}
          >
            <Pencil className="size-4" />
          </Button>
        </div>
      ),
    };
    switch (kind) {
      case "server":
        return [
          name(t("主机")),
          status,
          metric("cpu", "CPU"),
          metric("memory", t("内存")),
          metric("disk", t("磁盘")),
          text("system", t("系统 / 地区"), (r) => [r.os, r.region].filter(Boolean).join(" · ")),
          expires(t("到期 / 续费")),
          cost,
          tags,
          actions,
        ];
      case "domain":
        return [
          name(t("域名")),
          status,
          expires(t("到期时间")),
          text("registrar", t("注册商"), (r) => r.registrar),
          text("dns", t("DNS 服务商"), (r) => r.dns),
          text("autoRenew", t("续费方式"), (r) =>
            r.autoRenew === undefined ? undefined : r.autoRenew ? t("自动续费") : t("手动续费"),
          ),
          cost,
          tags,
          actions,
        ];
      case "cert":
        return [
          name(t("证书域名")),
          status,
          expires(t("到期时间")),
          text("issuer", t("颁发者"), (r) => r.issuer, 180),
          tags,
          actions,
        ];
      case "ai":
        return [
          name(t("账号")),
          status,
          text("provider", t("服务商"), (r) => r.provider),
          text("plan", t("套餐"), (r) => r.plan),
          text("usage", t("额度 / 用量"), (r) => r.usageText, 150),
          expires(t("续费日")),
          {
            accessorKey: "monthlyUsd",
            header: t("月费"),
            meta: { width: 94 },
            sortUndefined: "last",
            cell: ({ row }) =>
              row.original.monthlyUsd === undefined ? dash : formatUsd(row.original.monthlyUsd),
          },
          tags,
          actions,
        ];
      case "mail":
        return [
          name(t("邮箱地址")),
          status,
          text(
            "mailKind",
            t("类型"),
            (r) => (r.mailKind ? t(MAIL_KIND_LABEL[r.mailKind]) : undefined),
            90,
          ),
          {
            accessorKey: "mailUsedPct",
            header: t("容量已用"),
            meta: { width: 100 },
            sortUndefined: "last",
            cell: ({ row }) => percent(row.original.mailUsedPct),
          },
          tags,
          actions,
        ];
      case "secret":
        return [
          name(t("名称")),
          text(
            "secretKind",
            t("类型"),
            (r) => (r.secretKind ? t(SECRET_KIND_LABEL[r.secretKind] ?? r.secretKind) : undefined),
            110,
          ),
          {
            accessorKey: "lastRotated",
            header: t("上次轮换"),
            meta: { width: 130 },
            sortUndefined: "last",
            cell: ({ row }) =>
              row.original.lastRotated ? formatDate(row.original.lastRotated) : dash,
          },
          tags,
          actions,
        ];
      case "service":
        return [
          name(t("名称")),
          status,
          text(
            "category",
            t("类型"),
            (r) =>
              r.serviceTypeName ??
              (r.serviceCategory
                ? t(SERVICE_CATEGORY_LABEL[r.serviceCategory] ?? r.serviceCategory)
                : undefined),
          ),
          text("provider", t("服务商"), (r) => r.provider),
          text("url", t("地址"), (r) => r.url?.replace(/^https?:\/\//, ""), 170),
          expires(t("到期 / 续费")),
          cost,
          tags,
          actions,
        ];
      default:
        return [name(t("名称")), type, status, expires(t("到期 / 续费")), cost, tags, actions];
    }
  }, [locale, kind]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getRowId: refKey,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
  return (
    <>
      <div className="asset-table-scroll" tabIndex={0} role="region" aria-label={t("资产表格")}>
        <table
          className="asset-table"
          style={{
            minWidth: table
              .getVisibleLeafColumns()
              .reduce((sum, column) => sum + (column.columnDef.meta?.width ?? 120), 0),
          }}
        >
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    style={{ width: header.column.columnDef.meta?.width }}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    {header.column.getCanSort() ? (
                      <button onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown />
                        ) : (
                          <ArrowUpDown />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} data-asset-id={row.original.id} data-asset-kind={row.original.kind}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-pagination">
        <Select
          className="w-36 text-meta"
          aria-label={t("每页条数")}
          value={String(pagination.pageSize)}
          onValueChange={(value) => table.setPageSize(Number(value))}
          options={[25, 50, 100].map((n) => ({ value: String(n), label: t("每页 {0} 项", n) }))}
        />
        <span className="ml-auto" aria-live="polite">
          {t("第 {0} / {1} 页", pagination.pageIndex + 1, table.getPageCount())}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("上一页")}
          aria-label={t("上一页")}
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title={t("下一页")}
          aria-label={t("下一页")}
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      {dns?.integration && (
        <DnsManager
          connectionId={dns.integration.connectionId}
          zoneId={dns.integration.remoteId}
          name={dns.name}
          onClose={() => setDns(null)}
        />
      )}
    </>
  );
}

function percent(value?: number) {
  return value === undefined
    ? "-"
    : `${value.toLocaleString(intlLocale(), { maximumFractionDigits: 1 })}%`;
}
