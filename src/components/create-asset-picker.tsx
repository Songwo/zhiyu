import { Bot, FileText, Globe, KeyRound, Mail, Phone, Plus, Server, Shield } from "lucide-react";
import { useState } from "react";
import { typeIcon } from "@/lib/asset-types";
import type { AssetType } from "@/lib/types";
import { createAsset, CREATE_LABELS, type CreateTarget } from "@/lib/create-asset";
import { useAppStore } from "@/lib/store";
import { t } from "@/lib/i18n";
import {
  SUBSCRIPTION_TEMPLATES,
  TEMPLATE_GROUPS,
  templatePreset,
  type SubscriptionTemplate,
} from "@/lib/subscription-templates";
import { formatBilling } from "@/lib/billing";
import { EditorDialog } from "./ui/editor-dialog";
import { AssetTypeManager } from "./asset-type-manager";

const targets = [
  { target: "document", Icon: FileText, detail: "记录图片、链接与资产说明" },
  { target: "phone", Icon: Phone, detail: "查看到期日与关联订阅" },
  { target: "ai", Icon: Bot, detail: "管理订阅与月度开支" },
  { target: "mail", Icon: Mail, detail: "管理邮箱与账号归属" },
  { target: "server", Icon: Server, detail: "记录主机，按需配置连接" },
  { target: "service", Icon: Globe, detail: "管理 Workers、博客与自建服务" },
  { target: "domain", Icon: Globe, detail: "跟踪域名与续费日期" },
  { target: "cert", Icon: Shield, detail: "记录证书与到期时间" },
  { target: "secret", Icon: KeyRound, detail: "保存账号与加密凭据" },
] satisfies { target: CreateTarget; Icon: typeof Server; detail: string }[];

/** 从模板新建：AI 工具进 AI 订阅，其余作为服务资产，带好费用与下次续费日。 */
function startFromTemplate(template: SubscriptionTemplate) {
  const state = useAppStore.getState();
  state.setCreatePickerOpen(false);
  state.openComposer(template.kind, null, templatePreset(template, new Date()));
}

/** 自定义类型：直接进入服务资产的表单并选好类型。 */
function startFromType(type: AssetType) {
  const state = useAppStore.getState();
  state.setCreatePickerOpen(false);
  state.openComposer("service", null, { category: "custom", typeId: type.id });
}

export function CreateAssetPicker() {
  const open = useAppStore((state) => state.createPickerOpen);
  const setOpen = useAppStore((state) => state.setCreatePickerOpen);
  const types = useAppStore((state) => state.assetTypes);
  const [creatingType, setCreatingType] = useState(false);
  if (creatingType) {
    // 新建类型后直接用它添加第一项资产。
    return (
      <AssetTypeManager
        startNew
        onSaved={(type) => startFromType(type)}
        onClose={() => {
          setCreatingType(false);
          useAppStore.getState().setCreatePickerOpen(false);
        }}
      />
    );
  }
  if (!open) return null;
  return (
    <EditorDialog title={t("选择资产类型")} onClose={() => setOpen(false)}>
      <div className="editor-scroll">
        <p className="mb-4 text-sm text-muted">{t("选择这次要记录的内容。")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {targets.map(({ target, Icon, detail }) => (
            <button
              type="button"
              key={target}
              className="create-type-option"
              aria-label={t(CREATE_LABELS[target])}
              onClick={() => void createAsset(target)}
            >
              <Icon className="size-5 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{t(CREATE_LABELS[target])}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">{t(detail)}</span>
              </span>
            </button>
          ))}
        </div>

        <section className="custom-type-section" aria-labelledby="custom-types-title">
          <h3 id="custom-types-title">{t("自定义资产")}</h3>
          <p>
            {t("清单里没有的东西，自己定义类型和字段来记录，比如家用 NAS、游戏账号、设备保修。")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="create-type-option custom-type-new"
              aria-label={t("新建自定义类型")}
              onClick={() => setCreatingType(true)}
            >
              <Plus className="size-5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{t("新建自定义类型")}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted">
                  {t("定义名称、图标和字段")}
                </span>
              </span>
            </button>
            {types.map((type) => {
              const Icon = typeIcon(type.icon);
              return (
                <button
                  type="button"
                  key={type.id}
                  className="create-type-option"
                  aria-label={t("添加自定义资产 {0}", type.name)}
                  onClick={() => startFromType(type)}
                >
                  <Icon className="size-5 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{type.name}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted">
                      {t("自定义 · {0} 个字段", type.fields.length)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="template-section" aria-labelledby="subscription-templates-title">
          <h3 id="subscription-templates-title">{t("从常用订阅开始")}</h3>
          <p>
            {t("选一个模板，金额、周期和下次续费日都已填好，保存前可以修改。价格以实际账单为准。")}
          </p>
          {TEMPLATE_GROUPS.map((group) => (
            <div key={group.id} className="template-group" role="group" aria-label={t(group.label)}>
              <span className="template-group-label">{t(group.label)}</span>
              <div className="template-chips">
                {SUBSCRIPTION_TEMPLATES.filter((item) => item.group === group.id).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="template-chip"
                    data-group={item.group}
                    aria-label={t("用模板添加 {0}", item.name)}
                    onClick={() => startFromTemplate(item)}
                  >
                    <span className="template-chip-name">{item.name}</span>
                    <span className="template-chip-price">
                      {formatBilling({
                        amount: item.amount,
                        currency: item.currency,
                        cycle: item.cycle,
                      })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </EditorDialog>
  );
}
