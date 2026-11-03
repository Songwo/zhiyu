import { useEffect, useMemo, useRef, useState } from "react";
import {
  CreditCard,
  Plus,
  Search,
  Smartphone,
  Wifi,
  Pencil,
  ArrowUpRight,
  CalendarClock,
  Link2,
  Layers,
  Rotate3D,
  Copy,
  Globe2,
  Radio,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { ManagedCard, ServiceAsset } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useVault } from "@/lib/vault-state";
import { copyText } from "@/lib/utils";
import { CardPrivate } from "./card-private";
import { BrandIcon } from "./brand-icon";
import { bankMetadataPatch, detectChinaBank } from "@/lib/card-identity.mjs";
import {
  cardAppearance,
  cardRegionGroup,
  CARD_REGIONS,
  findChinaBank,
} from "../../electron/services/card-issuers.mjs";
import { uid } from "@/lib/utils";
import { parseTags } from "@/lib/tags";
import { billingFormValues } from "@/lib/billing";
import {
  CARD_NETWORKS,
  CARD_PROVIDERS,
  ESIM_PROVIDERS,
  detectCardNetwork,
  identifyCardDescription,
  esimPlanEnd,
  managedCardDue,
  managedCardExpiry,
  normalizeManagedCard,
} from "../../electron/services/managed-cards.mjs";
import { normalizeService } from "../../electron/services/service-assets.mjs";
import { billingFromForm } from "../../electron/services/renewals.mjs";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input, Label, Select, Textarea } from "./ui/input";
import { EditorDialog } from "./ui/editor-dialog";
import { BillingFields } from "./billing-fields";
import "./managed-cards.css";

const FUNDING = ["待确认", "信用卡", "借记卡", "预付卡", "加密货币消费卡", "其他"];
const FORMS = ["待确认", "虚拟卡", "实体卡"];
const REGION_LABELS: Record<string, string> = {
  mainland: "中国大陆",
  hmt: "港澳台",
  overseas: "海外",
  global: "全球 / 多地区",
  unknown: "未设置地区",
};

function useCardClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function CardFace({ data, onOpen }: { data: ServiceAsset; onOpen?: () => void }) {
  const card = data.card!;
  const esim = card.kind === "esim";
  const now = useCardClock();
  const deadline = managedCardExpiry(card);
  const due = managedCardDue(deadline, now);
  const appearance = cardAppearance(data.provider || "", card.network || "", card.kind);
  const region = cardRegionGroup(card);
  return (
    <button
      type="button"
      className="managed-card-face"
      data-kind={card.kind}
      data-network={card.network ?? ""}
      data-state={due.state}
      data-palette={appearance.palette}
      data-motif={appearance.motif}
      onClick={onOpen}
      aria-label={t("查看卡片 {0}", data.name)}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse") return;
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty(
          "--glare-x",
          `${((event.clientX - rect.left) / rect.width) * 100}%`,
        );
        event.currentTarget.style.setProperty(
          "--glare-y",
          `${((event.clientY - rect.top) / rect.height) * 100}%`,
        );
      }}
    >
      <span className="card-sheen" aria-hidden="true" />
      <span className="card-engraving" aria-hidden="true" />
      <span className="managed-card-top">
        <span className="managed-card-provider">
          <span className="card-issuer-mark" aria-hidden="true">
            <BrandIcon identity={{ provider: data.provider }} fallback={appearance.mark} />
          </span>
          <span>{data.provider || (esim ? "eSIM" : t("我的卡片"))}</span>
        </span>
        <span className="managed-card-form">
          {esim ? <Wifi size={20} /> : <Radio size={20} aria-hidden="true" />}
        </span>
      </span>
      <span className="card-title-line">
        <span className="managed-card-name">{data.name}</span>
        <span className="card-face-region">
          <Globe2 aria-hidden="true" />
          {t(REGION_LABELS[region])}
        </span>
      </span>
      <span className="managed-card-mid">
        <span className="card-chip" aria-hidden="true">
          <span />
        </span>
        <span className="managed-card-number">
          {esim ? (
            card.phone || card.region || t("数据套餐")
          ) : (
            <>
              <span className="card-number-mask" aria-hidden="true">
                •••• •••• ••••
              </span>
              <span className="card-number-last4">{card.last4 || "••••"}</span>
            </>
          )}
        </span>
      </span>
      <span className="managed-card-bottom">
        <span>
          <span className="card-micro">{esim ? t("最近期限") : t("有效期至")}</span>
          <span className="card-validity">
            {esim
              ? deadline || t("未设置")
              : (card.expiryMonth
                  ? `${card.expiryMonth.slice(5)} / ${card.expiryMonth.slice(2, 4)}`
                  : "") || t("未设置")}
          </span>
          {!esim && <span className="card-face-format">{t(card.formFactor || "待确认")}</span>}
        </span>
        <span className="card-network">
          <span className="network-emblem" aria-hidden="true" />
          {!esim && (
            <BrandIcon identity={{ provider: card.network }} className="card-network-brand" />
          )}
          {esim ? card.plan || "eSIM" : card.network || t("自定义卡片")}
        </span>
      </span>
    </button>
  );
}

function DueText({ date, now }: { date: string; now: Date }) {
  const due = managedCardDue(date, now);
  return (
    <span className="card-deadline" data-state={due.state}>
      {due.days === null
        ? t("未设置期限")
        : due.days < 0
          ? t("已过期 {0} 天", -due.days)
          : due.days === 0
            ? t("今天到期")
            : t("还有 {0} 天", due.days)}
    </span>
  );
}

export function ManagedCardsWorkspace({ kind }: { kind: ManagedCard["kind"] }) {
  const services = useAppStore((s) => s.services);
  const links = useAppStore((s) => s.links);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const now = useCardClock();
  const esim = kind === "esim";
  const records = useMemo(
    () => services.filter((asset) => asset.card?.kind === kind),
    [services, kind],
  );
  const visible = records.filter((asset) => {
    const haystack = [
      asset.name,
      asset.provider,
      asset.card?.network,
      asset.card?.last4,
      asset.card?.phone,
      asset.card?.region,
      ...asset.tags,
    ]
      .join(" ")
      .toLocaleLowerCase();
    const state = managedCardDue(managedCardExpiry(asset.card!), now).state;
    return (
      haystack.includes(query.trim().toLocaleLowerCase()) &&
      (regionFilter === "all" || cardRegionGroup(asset.card!) === regionFilter) &&
      (filter === "all" ||
        (filter === "attention"
          ? state === "expired" || state === "due"
          : asset.card?.formFactor === filter || asset.card?.network === filter))
    );
  });
  const upcoming = records.filter((x) =>
    ["expired", "due"].includes(managedCardDue(managedCardExpiry(x.card!), now).state),
  ).length;
  const add = () => useAppStore.getState().openComposer("service", null, { _cardKind: kind });
  const open = (asset: ServiceAsset) =>
    useAppStore
      .getState()
      .setExpanded({ kind: "service", id: asset.id, origin: { x: 0, y: 0, w: 0, h: 0 } });
  return (
    <section className="cards-workspace" aria-label={esim ? t("eSIM 卡") : t("U 卡与支付卡")}>
      <header className="cards-page-header">
        <div>
          <p className="cards-page-context">{esim ? t("连接下一程") : t("每一张卡，都有归处")}</p>
          <h1>{esim ? t("eSIM 卡") : t("U 卡与支付卡")}</h1>
          <p>
            {esim
              ? t("套餐和保号期限分开记，关联设备、账号与出行资料。")
              : t("卡组织、发卡服务商与有效期，一眼看清。")}
          </p>
        </div>
        <Button onClick={add}>
          <Plus className="size-4" />
          {esim ? t("添加 eSIM") : t("添加支付卡")}
        </Button>
      </header>
      <div className="cards-summary">
        <span>
          <Layers />
          {t("共 {0} 张卡片", records.length)}
        </span>
        <span>
          <CalendarClock />
          {t("30 天内到期或已过期 {0} 张", upcoming)}
        </span>
        <span>
          <Link2 />
          {t("支持关联资产与文档")}
        </span>
      </div>
      <div className="cards-controls">
        <div className="cards-search">
          <Search aria-hidden="true" />
          <Input
            aria-label={t("搜索卡片")}
            placeholder={t("搜索名称、服务商、尾号或地区")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          aria-label={t("筛选地域")}
          value={regionFilter}
          onValueChange={setRegionFilter}
          options={[
            { value: "all", label: t("全部地域") },
            ...Object.entries(REGION_LABELS).map(([value, label]) => ({
              value,
              label: `${t(label)} (${records.filter((asset) => cardRegionGroup(asset.card!) === value).length})`,
            })),
          ]}
        />
        <Select
          aria-label={t("筛选卡片")}
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: t("全部卡片") },
            { value: "attention", label: t("即将到期与已过期") },
            ...(!esim ? FORMS.slice(1).map((value) => ({ value, label: t(value) })) : []),
          ]}
        />
      </div>
      {visible.length ? (
        <div className="managed-cards-grid">
          {visible.map((asset) => {
            const card = asset.card!;
            const related = links.filter(
              (link) =>
                (link.from.kind === "service" && link.from.id === asset.id) ||
                (link.to.kind === "service" && link.to.id === asset.id),
            ).length;
            return (
              <article key={asset.id} className="managed-card-entry" data-asset-id={asset.id}>
                <CardFace data={asset} onOpen={() => open(asset)} />
                <div className="card-entry-meta">
                  <span className="card-entry-classification">
                    <span>{t(REGION_LABELS[cardRegionGroup(card)])}</span>
                    <span>
                      {esim ? card.region || t("未设置地区") : t(card.funding || "待确认")}
                    </span>
                  </span>
                  <DueText date={managedCardExpiry(card)} now={now} />
                </div>
                {esim && (
                  <div className="esim-deadlines">
                    <span>
                      {t("套餐到期")}
                      <b>{esimPlanEnd(card) || t("未设置")}</b>
                    </span>
                    <span>
                      {t("保号截止")}
                      <b>{card.keepAliveAt || t("未设置")}</b>
                    </span>
                  </div>
                )}
                <div className="card-entry-footer">
                  <button type="button" onClick={() => open(asset)}>
                    <Link2 />
                    {t("{0} 项关联", related)}
                  </button>
                  <div>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("编辑卡片 {0}", asset.name)}
                      onClick={() => useAppStore.getState().openComposer("service", asset.id)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("查看卡片 {0}", asset.name)}
                      onClick={() => open(asset)}
                    >
                      <ArrowUpRight />
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="cards-empty">
          {esim ? <Smartphone /> : <CreditCard />}
          <h2>
            {records.length
              ? t("没有匹配的卡片")
              : esim
                ? t("把下一程放进口袋")
                : t("建立你的卡片收藏")}
          </h2>
          <p>
            {records.length
              ? t("试试其他关键词或筛选条件。")
              : t("添加第一张卡片，记录期限并连接相关资产。")}
          </p>
          {!records.length && (
            <Button variant="outline" onClick={add}>
              {esim ? t("添加 eSIM") : t("添加支付卡")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function FormField({
  label,
  value,
  onChange,
  type = "text",
  list,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  list?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        aria-label={label}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={list}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  );
}

export function CardEditor({
  kind,
  existing,
  onClose,
}: {
  kind: ManagedCard["kind"];
  existing?: ServiceAsset;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>(() => ({
    name: existing?.name ?? "",
    provider: existing?.provider ?? "",
    url: existing?.url ?? "",
    notes: existing?.notes ?? "",
    tags: existing?.tags.join(", ") ?? "",
    ...billingFormValues(existing?.billing),
    ...Object.fromEntries(
      Object.entries(existing?.card ?? {}).map(([key, value]) => [key, String(value)]),
    ),
  }));
  const [number, setNumber] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const esim = kind === "esim";
  const set = (key: string, value: string) => setForm((old) => ({ ...old, [key]: value }));
  const detected = detectCardNetwork(number);
  const detectedBank = detectChinaBank(number);
  const preview: ServiceAsset = {
    id: "preview",
    name: form.name || (esim ? t("我的 eSIM") : t("我的卡片")),
    category: "custom",
    provider: form.provider,
    url: "",
    notes: "",
    tags: [],
    status: "online",
    card: { ...form, kind },
  };
  const submit = async () => {
    if (saving) return;
    setError("");
    try {
      if (!form.name.trim()) throw new Error(t("请填写卡片名称"));
      const card = normalizeManagedCard({ ...form, kind });
      const state = useAppStore.getState();
      if (existing && !state.services.some((x) => x.id === existing.id))
        throw new Error(t("该资产已被删除，请重新打开"));
      const data = normalizeService({
        ...existing,
        id: existing?.id ?? uid(),
        name: form.name,
        category: "custom",
        provider: form.provider,
        url: form.url,
        notes: form.notes,
        tags: parseTags(form.tags),
        status: "online",
        billing: billingFromForm({
          amount: form.billingAmount,
          currency: form.billingCurrency,
          cycle: form.billingCycle,
        }),
        card,
      });
      setSaving(true);
      state.upsertService(data);
      state.log(t("保存了卡片 {0}", data.name), "service");
      setNumber("");
      onClose();
      state.setExpanded({ kind: "service", id: data.id, origin: { x: 0, y: 0, w: 0, h: 0 } });
      toast.success(t("卡片已保存"));
    } catch (failure) {
      setSaving(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <EditorDialog
      title={existing ? t("编辑卡片") : esim ? t("添加 eSIM") : t("添加支付卡")}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="card-editor-form"
      >
        <div className="editor-scroll">
          <div className="card-editor-preview">
            <CardFace data={preview} />
          </div>
          <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("卡片名称")}
              value={form.name}
              onChange={(value) => set("name", value)}
              placeholder={esim ? t("例如：日本出行卡") : t("例如：日常订阅卡")}
            />
            <FormField
              label={esim ? t("eSIM 服务商") : t("发卡服务商")}
              value={form.provider}
              onChange={(value) => {
                const bank = !esim && findChinaBank(value);
                setForm((old) => ({
                  ...old,
                  provider: value,
                  ...(bank && !old.region && !old.regionGroup
                    ? { region: "中国大陆", regionGroup: "mainland" }
                    : {}),
                }));
              }}
              list="card-provider-options"
              placeholder={t("选择预设或输入自己的服务商")}
            />
            <datalist id="card-provider-options">
              {(esim ? ESIM_PROVIDERS : CARD_PROVIDERS).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <div>
              <Label>{t("地域分组")}</Label>
              <Select
                aria-label={t("地域分组")}
                value={form.regionGroup || "auto"}
                onValueChange={(value) => set("regionGroup", value === "auto" ? "" : value)}
                options={[
                  { value: "auto", label: t("按地区自动分组") },
                  ...Object.entries(REGION_LABELS).map(([value, label]) => ({
                    value,
                    label: t(label),
                  })),
                ]}
              />
            </div>
            <datalist id="card-region-options">
              {CARD_REGIONS.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            {!esim ? (
              <>
                <div className="card-recognition sm:col-span-2">
                  <Label>{t("粘贴卡片说明以识别类型（可选）")}</Label>
                  <Input
                    aria-label={t("卡片说明")}
                    value={description}
                    maxLength={2000}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDescription(value);
                      setForm((previous) => ({ ...previous, ...identifyCardDescription(value) }));
                    }}
                    placeholder="Wise Visa virtual debit card"
                  />
                  <p>{t("从说明提取服务商、卡组织与明确标注的类型，保存前可修改。")}</p>
                </div>
                <div>
                  <Label>{t("卡片形态")}</Label>
                  <Select
                    aria-label={t("卡片形态")}
                    value={form.formFactor || "待确认"}
                    onValueChange={(value) => set("formFactor", value)}
                    options={FORMS.map((value) => ({ value, label: t(value) }))}
                  />
                </div>
                <FormField
                  label={t("资金类型")}
                  value={form.funding || ""}
                  onChange={(value) => set("funding", value)}
                  list="card-funding-options"
                  placeholder={t("支持预设与自定义类型")}
                />
                <datalist id="card-funding-options">
                  {FUNDING.map((value) => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </datalist>
                <FormField
                  label={t("卡组织")}
                  value={form.network || ""}
                  onChange={(value) => set("network", value)}
                  list="card-network-options"
                  placeholder={t("支持预设与自定义卡组织")}
                />
                <datalist id="card-network-options">
                  {CARD_NETWORKS.map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
                <FormField
                  label={t("卡号尾四位")}
                  value={form.last4 || ""}
                  onChange={(value) => set("last4", value.replace(/\D/g, "").slice(0, 4))}
                />
                <FormField
                  label={t("卡面有效月份")}
                  type="month"
                  value={form.expiryMonth || ""}
                  onChange={(value) => set("expiryMonth", value)}
                />
                <FormField
                  label={t("发行地区")}
                  value={form.region || ""}
                  onChange={(value) => set("region", value)}
                  list="card-region-options"
                />
                <div className="card-recognition sm:col-span-2">
                  <Label>{t("本机识别银行与卡组织（可选）")}</Label>
                  <Input
                    aria-label={t("用于识别的卡号")}
                    type="password"
                    autoComplete="off"
                    value={number}
                    maxLength={30}
                    onChange={(event) => {
                      const value = event.target.value;
                      setNumber(value);
                      const network = detectCardNetwork(value);
                      const digits = value.replace(/[\s-]/g, "");
                      const bank = /^\d{12,19}$/.test(digits) ? detectChinaBank(value) : undefined;
                      setForm((old) => ({
                        ...old,
                        ...(network && !old.network ? { network } : {}),
                        ...bankMetadataPatch(old, bank),
                        ...(/^\d{12,19}$/.test(digits) ? { last4: digits.slice(-4) } : {}),
                      }));
                    }}
                  />
                  <p>
                    {detected
                      ? t("已识别卡组织：{0}", detected)
                      : t("输入卡号可辅助识别卡组织，仅保存尾四位。")}
                  </p>
                  <div className="card-bank-result" role="status">
                    <p>
                      {detectedBank
                        ? t("参考号段识别：{0}，请核对。", detectedBank.provider)
                        : t("未识别到唯一的国内银行，可手动选择或填写。")}
                    </p>
                    {detectedBank && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setForm((old) => ({
                            ...old,
                            provider: detectedBank.provider,
                            region: detectedBank.region,
                            regionGroup: "mainland",
                            ...(detected ? { network: detected } : {}),
                          }))
                        }
                      >
                        {t("采用识别结果")}
                      </Button>
                    )}
                  </div>
                  <p>
                    {t("使用离线参考号段，不上传卡号；未填字段可自动补全，已有选择由你确认修改。")}
                  </p>
                  <p>
                    {t("虚拟或实体、信用或借记需要按卡片资料确认；有效期按卡面月份最后一天记录。")}
                  </p>
                </div>
              </>
            ) : (
              <>
                <FormField
                  label={t("套餐名称")}
                  value={form.plan || ""}
                  onChange={(value) => set("plan", value)}
                />
                <FormField
                  label={t("覆盖国家或地区")}
                  value={form.region || ""}
                  onChange={(value) => set("region", value)}
                  list="card-region-options"
                />
                <FormField
                  label={t("运营商")}
                  value={form.carrier || ""}
                  onChange={(value) => set("carrier", value)}
                />
                <FormField
                  label={t("绑定号码（可选）")}
                  value={form.phone || ""}
                  onChange={(value) => set("phone", value)}
                />
                <FormField
                  label={t("ICCID 尾四位（可选）")}
                  value={form.last4 || ""}
                  onChange={(value) => set("last4", value.replace(/\D/g, "").slice(0, 4))}
                />
                <FormField
                  label={t("套餐流量 GB（可选）")}
                  type="number"
                  value={form.dataGb || ""}
                  onChange={(value) => set("dataGb", value)}
                />
                <FormField
                  label={t("实际激活日期")}
                  type="date"
                  value={form.activatedAt || ""}
                  onChange={(value) => set("activatedAt", value)}
                />
                <FormField
                  label={t("套餐有效天数")}
                  type="number"
                  value={form.validityDays || ""}
                  onChange={(value) => set("validityDays", value)}
                />
                <FormField
                  label={t("套餐到期日（以此为准）")}
                  type="date"
                  value={form.planExpiresAt || ""}
                  onChange={(value) => set("planExpiresAt", value)}
                />
                <FormField
                  label={t("保号截止日期")}
                  type="date"
                  value={form.keepAliveAt || ""}
                  onChange={(value) => set("keepAliveAt", value)}
                />
                <p className="card-form-help sm:col-span-2">
                  {t(
                    "优先使用服务商给出的到期日。按天估算从实际激活当天计为第 1 天；未激活时不推算期限。",
                  )}
                </p>
              </>
            )}
            <FormField
              label={t("管理或续费网址")}
              type="url"
              value={form.url}
              onChange={(value) => set("url", value)}
            />
            <FormField
              label={t("标签")}
              value={form.tags}
              onChange={(value) => set("tags", value)}
            />
            <BillingFields values={form} set={set} />
            <div className="sm:col-span-2">
              <Label>{t("备注")}</Label>
              <Textarea
                aria-label={t("备注")}
                value={form.notes}
                onChange={(event) => set("notes", event.target.value)}
              />
            </div>
          </fieldset>
          <p className="card-form-help">
            {t("保存后可关联账号、邮箱、订阅和文档。密码、CVV 与激活码请放在详情的加密凭据中。")}
          </p>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="card-editor-footer">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("正在保存…") : t("保存卡片")}
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

/** 共用资产详情页，继续使用已有文档、关联、加密凭据与 AI 入口。 */
export function ManagedCardDetail({ data }: { data: ServiceAsset }) {
  const card = data.card!;
  const now = useCardClock();
  const [flipped, setFlipped] = useState(false);
  const unlocked = useVault((state) => state.unlocked);
  const flipButton = useRef<HTMLButtonElement>(null);
  const appearance = cardAppearance(data.provider || "", card.network || "", card.kind);
  useEffect(() => {
    if (!unlocked) setFlipped(false);
  }, [unlocked]);
  const flip = (value: boolean) => {
    setFlipped(value);
    requestAnimationFrame(() => flipButton.current?.focus({ preventScroll: true }));
  };
  const rows =
    card.kind === "esim"
      ? [
          [t("套餐名称"), card.plan],
          [t("覆盖国家或地区"), card.region],
          [t("运营商"), card.carrier],
          [t("绑定号码（可选）"), card.phone],
          [t("套餐到期"), esimPlanEnd(card)],
          [t("保号截止"), card.keepAliveAt],
          [t("套餐流量 GB（可选）"), card.dataGb == null ? "" : `${card.dataGb} GB`],
        ]
      : [
          [t("卡组织"), card.network],
          [t("资金类型"), t(card.funding || "待确认")],
          [t("卡片形态"), t(card.formFactor || "待确认")],
          [t("发行地区"), card.region],
          [t("地域分组"), t(REGION_LABELS[cardRegionGroup(card)])],
          [t("有效期至"), managedCardExpiry(card)],
        ];
  return (
    <div className="managed-card-detail">
      <div className="card-display-stage">
        <div
          className="card-3d-scene"
          data-flipped={flipped}
          onPointerMove={(event) => {
            if (event.pointerType !== "mouse") return;
            const box = event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty(
              "--card-tilt-y",
              `${((event.clientX - box.left) / box.width - 0.5) * 5}deg`,
            );
            event.currentTarget.style.setProperty(
              "--card-tilt-x",
              `${(0.5 - (event.clientY - box.top) / box.height) * 5}deg`,
            );
          }}
          onPointerLeave={(event) => {
            event.currentTarget.style.setProperty("--card-tilt-x", "0deg");
            event.currentTarget.style.setProperty("--card-tilt-y", "0deg");
          }}
        >
          <div className="card-3d-object">
            <div className="card-flip-front" aria-hidden={flipped} inert={flipped}>
              <CardFace data={data} onOpen={() => flip(true)} />
            </div>
            <div
              className="card-flip-back managed-card-face"
              data-kind={card.kind}
              data-network={card.network || ""}
              data-palette={appearance.palette}
              data-motif={appearance.motif}
              aria-hidden={!flipped}
              inert={!flipped}
            >
              <div className="card-magnetic-stripe" aria-hidden="true" />
              <CardPrivate key={data.id} data={data} active={flipped} />
            </div>
          </div>
        </div>
        <div className="card-detail-tools">
          <button
            type="button"
            className="card-flip-toggle"
            ref={flipButton}
            aria-pressed={flipped}
            aria-label={flipped ? t("翻回正面") : t("翻到背面")}
            onClick={() => flip(!flipped)}
          >
            <Rotate3D className="size-4" />
            {flipped ? t("翻回正面") : t("翻到背面")}
          </button>
          {data.card?.last4 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void copyText(data.card!.last4!)
                  .then(() => toast.success(t("已复制尾号")))
                  .catch((error) => toast.error(String(error.message)))
              }
            >
              <Copy className="size-3.5" />
              {t("复制尾号")}
            </Button>
          )}
        </div>
        <p className="card-flip-hint">
          {flipped
            ? t("完整资料按需显示，点击右侧按钮即可复制。")
            : t("轻点卡片翻转，查看加密资料与快捷操作。")}
        </p>
      </div>
      <div className="card-entry-meta">
        <span>{data.provider}</span>
        <DueText date={managedCardExpiry(card)} now={now} />
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || t("未设置")}</dd>
          </div>
        ))}
      </dl>
      {data.url && (
        <a href={data.url} target="_blank" rel="noreferrer" className="card-manage-link">
          {t("前往管理或续费")}
          <ArrowUpRight />
        </a>
      )}
      {data.notes && <p className="whitespace-pre-wrap text-sm text-muted">{data.notes}</p>}
    </div>
  );
}
