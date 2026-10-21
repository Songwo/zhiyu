import { uploadImage, type ImageBedStatus } from "@/lib/image-bed";
import { ImageBedSettings } from "./image-bed-settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Quote,
  Code2,
  Link2,
  ImagePlus,
  Undo2,
  Redo2,
  Plus,
  FileText,
  Search,
  Save,
  Download,
  Trash2,
  X,
  Paperclip,
  ArrowLeft,
  MoreHorizontal,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Check,
  ScanText,
} from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import {
  useDocuments,
  documentImage,
  type DocumentAsset,
  type DocumentSummary,
} from "@/lib/documents";
import { assetEntries, refKey } from "@/lib/operations";
import { useAppStore } from "@/lib/store";
import { KIND_LABEL } from "@/lib/status";
import { desktop } from "@/lib/desktop";
import { downloadJson, downloadText } from "@/lib/utils";
import { Button } from "./ui/button";
import { EditorDialog } from "./ui/editor-dialog";
import { t } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import { DocumentMarkdownImport } from "./document-markdown-import";
import { MARKDOWN_IMPORTED } from "@/lib/document-import-events";
import { DocumentNavigation } from "./document-navigation";
import { Markdown } from "./markdown";
import { DocumentMarkdownEditor } from "./document-markdown-editor";
import { documentMarkdown, markdownContent } from "@/lib/document-markdown.mjs";
import { DocumentAccountExtract } from "./document-account-extract";
import "./document-reading.css";
import "./document-actions.css";

const fail = (error: unknown) =>
  toast.error(error instanceof Error ? error.message : String(error));
type DeleteTarget = Pick<DocumentAsset, "id" | "title"> & { returnFocus: HTMLElement | null };
export function DocumentsWorkspace() {
  const { list, selected, drafts, load, open, create } = useDocuments();
  const listCollapsed = useSettings((s) => s.documentListCollapsed);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [newDocumentId, setNewDocumentId] = useState<string | null>(null);
  const [wideLayout, setWideLayout] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  useEffect(() => {
    const imported = () => {
      setQuery("");
      setFilter("all");
      setBrowsing(false);
      setNewDocumentId(null);
    };
    window.addEventListener(MARKDOWN_IMPORTED, imported);
    return () => window.removeEventListener(MARKDOWN_IMPORTED, imported);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1101px)");
    const update = () => setWideLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setBrowsing(false);
    setNewDocumentId((id) => (id === selected ? id : null));
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    if (!window.matchMedia("(max-width: 1100px)").matches) return;
    // 窄屏切换面板时让焦点跟随可见内容，阅读时不自动唤起输入键盘。
    const frame = requestAnimationFrame(() => {
      const target = browsing
        ? listRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
        : workspaceRef.current?.querySelector<HTMLElement>(".document-reader-scroll");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, browsing]);
  const newDocument = async () => {
    try {
      await create();
      setNewDocumentId(useDocuments.getState().selected);
      setQuery("");
      setFilter("all");
      setBrowsing(false);
    } catch (cause) {
      fail(cause);
    }
  };
  useEffect(() => {
    void load().catch((e) => setError(String(e.message)));
    return () => {
      const s = useDocuments.getState();
      if (s.selected) void s.flush(s.selected).catch(fail);
    };
  }, [load]);
  const filtered = list.filter(
    (doc) =>
      (filter !== "unbound" || doc.bindings.length === 0) &&
      (doc.title + doc.excerpt).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div
      ref={workspaceRef}
      className="documents-workspace"
      data-pane={!selected || browsing ? "list" : "editor"}
      data-library-collapsed={Boolean(selected && listCollapsed)}
    >
      <h1 className="sr-only">{t("文档资产")}</h1>
      <aside
        id="document-library"
        className="documents-list"
        aria-label={t("我的文档")}
        inert={Boolean(wideLayout && selected && listCollapsed)}
      >
        <div className="documents-library-titlebar">
          <h2 className="documents-library-title">
            <FileText className="size-4" aria-hidden="true" />
            {t("文档资产")} <span className="documents-count">{list.length}</span>
          </h2>
          <DocumentMarkdownImport onCreate={() => void newDocument()} />
        </div>
        <div className="documents-list-heading">
          <label className="documents-search">
            <Search className="size-4" />
            <input
              aria-label={t("搜索文档")}
              placeholder={t("搜索文档")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="documents-filters" data-filter={filter}>
            {[
              ["all", "全部文档"],
              ["unbound", "未关联"],
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                className={filter === value ? "doc-filter active" : "doc-filter"}
                onClick={() => setFilter(value)}
              >
                {t(label)}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-crit">
              {error}
            </p>
          )}
        </div>
        <div
          ref={listRef}
          className="documents-list-scroll"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(".document-list-item"),
            );
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                    );
            buttons[next]?.focus();
          }}
        >
          {filtered.map((doc) => (
            <DocumentListRow
              key={doc.id}
              doc={doc}
              selected={selected === doc.id}
              onOpen={() =>
                void open(doc.id)
                  .then(() => setBrowsing(false))
                  .catch(fail)
              }
              onDelete={(returnFocus) =>
                setDeleteTarget({ id: doc.id, title: doc.title, returnFocus })
              }
            />
          ))}
          {!filtered.length && (
            <p className="py-6 text-center text-sm text-muted">{t("暂无匹配文档")}</p>
          )}
        </div>
        <div className="documents-list-footer">{t("{0} 篇文档", filtered.length)}</div>
      </aside>
      {selected && drafts[selected] ? (
        <DocumentEditor
          key={selected}
          doc={drafts[selected]}
          initiallyEditing={newDocumentId === selected}
          onBrowse={() => setBrowsing(true)}
          onDelete={(returnFocus) =>
            setDeleteTarget({ id: selected, title: drafts[selected].title, returnFocus })
          }
        />
      ) : (
        <div className="document-welcome">
          <FileText className="size-10 text-muted" />
          <h2 className="text-2xl font-semibold">{t("把资料留在资产旁边")}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted">
            {t("部署笔记、项目方案、照片和参考链接，都可以保存成文档。关联资产是可选的。")}
          </p>
          <Button onClick={() => void newDocument()}>
            <Plus />
            {t("创建第一篇文档")}
          </Button>
        </div>
      )}
      {deleteTarget && (
        <DocumentDeleteDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          fallbackFocus={() =>
            workspaceRef.current?.querySelector<HTMLElement>(
              '.document-list-item[aria-current="page"]',
            ) ??
            workspaceRef.current?.querySelector<HTMLElement>(".document-list-item") ??
            workspaceRef.current?.querySelector<HTMLElement>(".documents-create-button") ??
            null
          }
        />
      )}
    </div>
  );
}

function DocumentListRow({
  doc,
  selected,
  onOpen,
  onDelete,
}: {
  doc: DocumentSummary;
  selected: boolean;
  onOpen: () => void;
  onDelete: (returnFocus: HTMLElement | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openingDialog = useRef(false);
  const restoreMenuFocus = useRef(true);
  const title = doc.title || t("未命名文档");
  const openMenu = (trigger: HTMLElement) => {
    returnFocus.current = trigger;
    openingDialog.current = false;
    restoreMenuFocus.current = true;
    setMenuOpen(true);
  };
  return (
    <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      <div
        className="document-list-row"
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(rowRef.current!);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            event.stopPropagation();
            openMenu(event.target as HTMLElement);
          }
        }}
      >
        <button
          ref={rowRef}
          type="button"
          aria-current={selected ? "page" : undefined}
          className={selected ? "document-list-item active" : "document-list-item"}
          onClick={onOpen}
        >
          <span className="document-list-row-heading flex items-start gap-2">
            <span className="document-list-icon">
              <FileText className="size-4" aria-hidden="true" />
            </span>
            <strong className="min-w-0 flex-1 line-clamp-2 text-sm">{title}</strong>
          </span>
          <span className="mt-2 line-clamp-2 text-xs text-muted">
            {doc.excerpt || t("开始记录你的想法")}
          </span>
          <span className="mt-3 flex justify-between text-xs text-muted">
            <span>
              {doc.bindings.length ? t("关联 {0} 项资产", doc.bindings.length) : t("独立文档")}
            </span>
            <span>
              {doc.imageCount > 0
                ? t("{0} 张图片", doc.imageCount)
                : new Date(doc.updatedAt).toLocaleDateString()}
            </span>
          </span>
        </button>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="document-more-button"
            aria-label={t("文档操作：{0}", title)}
            title={t("文档操作：{0}", title)}
            onPointerDown={(event) => {
              returnFocus.current = event.currentTarget;
              openingDialog.current = false;
              restoreMenuFocus.current = true;
            }}
            onKeyDown={(event) => {
              returnFocus.current = event.currentTarget;
              openingDialog.current = false;
              restoreMenuFocus.current = true;
            }}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="document-actions-menu"
            align="end"
            sideOffset={4}
            collisionPadding={8}
            aria-label={t("文档操作：{0}", title)}
            onKeyDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            onInteractOutside={() => {
              restoreMenuFocus.current = false;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !openingDialog.current &&
                restoreMenuFocus.current &&
                returnFocus.current?.isConnected &&
                returnFocus.current.getClientRects().length
              )
                returnFocus.current.focus({ preventScroll: true });
            }}
          >
            <DropdownMenu.Label className="document-actions-label">{title}</DropdownMenu.Label>
            <DropdownMenu.Item className="document-actions-item" onSelect={onOpen}>
              <FileText className="size-4" aria-hidden="true" />
              {t("打开文档")}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="document-actions-separator" />
            <DropdownMenu.Item
              className="document-actions-item document-actions-danger"
              onSelect={() => {
                openingDialog.current = true;
                onDelete(returnFocus.current ?? rowRef.current);
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t("删除文档")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </div>
    </DropdownMenu.Root>
  );
}

function DocumentDeleteDialog({
  target,
  onClose,
  fallbackFocus,
}: {
  target: DeleteTarget;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const deletingRef = useRef(false);
  const remove = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError("");
    try {
      // 固定确认时的目标；只有目标保存及删除都成功后才关闭确认框。
      await useDocuments.getState().remove(target.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("删除失败，请重试。"));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && !deletingRef.current && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="editor-backdrop document-delete-backdrop" />
        <AlertDialog.Content
          className="document-delete-dialog"
          aria-busy={deleting}
          onEscapeKeyDown={(event) => {
            if (deletingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              const trigger = target.returnFocus;
              const next =
                trigger?.isConnected && trigger.getClientRects().length ? trigger : fallbackFocus();
              next?.focus({ preventScroll: true });
            });
          }}
        >
          <AlertDialog.Title className="text-lg font-semibold">
            {t("删除「{0}」？", target.title || t("未命名文档"))}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm leading-relaxed text-muted">
            {t("删除后无法恢复，关联的资产不会受影响。")}
          </AlertDialog.Description>
          {error && (
            <p role="alert" className="text-sm text-crit">
              {error}
            </p>
          )}
          <div className="document-delete-buttons">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={deleting}>
                {t("取消")}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                disabled={deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                {t(deleting ? "正在删除…" : "删除文档")}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function DocumentEditor({
  doc,
  initiallyEditing,
  onBrowse,
  onDelete,
}: {
  doc: DocumentAsset;
  initiallyEditing: boolean;
  onBrowse: () => void;
  onDelete: (returnFocus: HTMLElement) => void;
}) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [editMode, setEditMode] = useState<"rich" | "source" | "preview">(
    typeof doc.markdown === "string" ? "source" : "rich",
  );
  const [convertOpen, setConvertOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const richEditing = editing && editMode === "rich" && typeof doc.markdown !== "string";
  const [finishing, setFinishing] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initiallyEditing) setEditing(true);
  }, [initiallyEditing]);
  const listCollapsed = useSettings((s) => s.documentListCollapsed);
  const setListCollapsed = useSettings((s) => s.setDocumentListCollapsed);
  const change = useDocuments((s) => s.change);
  const flush = useDocuments((s) => s.flush);
  const status = useDocuments((s) => s.status[doc.id]);
  const error = useDocuments((s) => s.errors[doc.id]);
  const snapshot = useAppStore(
    useShallow((s) => ({
      servers: s.servers,
      domains: s.domains,
      mailboxes: s.mailboxes,
      aiAssets: s.aiAssets,
      secrets: s.secrets,
      certs: s.certs,
      services: s.services,
    })),
  );
  const assets = assetEntries(snapshot);
  const [bindingQuery, setBindingQuery] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageStatus, setImageStatus] = useState<ImageBedStatus | null>(null);
  const [imageStatusError, setImageStatusError] = useState("");
  const [uploadResult, setUploadResult] = useState("");
  const [retryMigration, setRetryMigration] = useState(false);
  const handleImageStatus = useCallback((next: ImageBedStatus) => {
    setImageStatus(next);
    setImageStatusError("");
  }, []);
  useEffect(() => {
    const api = desktop()?.images;
    if (api)
      void api
        .status()
        .then(handleImageStatus)
        .catch((cause) =>
          setImageStatusError(cause instanceof Error ? cause.message : String(cause)),
        );
  }, [handleImageStatus]);
  const [uploadError, setUploadError] = useState("");
  const [retryFiles, setRetryFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState("");
  const uploadingRef = useRef(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, protocols: ["http", "https"] },
      }),
      Image.configure({
        allowBase64: true,
        HTMLAttributes: { referrerpolicy: "no-referrer", loading: "lazy" },
      }),
    ],
    content: doc.content,
    editable: richEditing && !finishing,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "document-prose",
        role: richEditing ? "textbox" : "region",
        "aria-label": t("文档正文"),
        ...(richEditing ? { "aria-multiline": "true", "aria-readonly": String(finishing) } : {}),
      },
      handleClick: (view, _pos, event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (anchor && (!view.editable || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          const href = anchor.getAttribute("href");
          if (href && /^https?:\/\//i.test(href)) {
            try {
              const url = new URL(href);
              if (url.username || url.password) return true;
              const bridge = desktop();
              if (bridge) void bridge.openExternal(url.href).catch(fail);
              else window.open(url.href, "_blank", "noopener,noreferrer");
            } catch {
              return true;
            }
          }
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const latest = useDocuments.getState().drafts[doc.id];
      if (latest && typeof latest.markdown !== "string")
        change({ ...latest, content: editor.getJSON() });
    },
  });
  useEffect(() => {
    editor?.setEditable(richEditing && !finishing, false);
  }, [editor, richEditing, finishing]);
  useEffect(() => {
    // 切换文档期间完成的图片上传也需要同步到重新打开的正文。
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(doc.content))
      editor.commands.setContent(doc.content, { emitUpdate: false });
  }, [editor, doc.content]);
  const finishEditing = async () => {
    if (uploadingRef.current || finishing) return;
    setFinishing(true);
    try {
      await flush(doc.id);
      setLink(null);
      setEditing(false);
      requestAnimationFrame(() => readerRef.current?.focus({ preventScroll: true }));
    } catch (cause) {
      fail(cause);
    } finally {
      setFinishing(false);
    }
  };
  useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive("bold"),
            italic: editor.isActive("italic"),
            heading: editor.isActive("heading"),
            list: editor.isActive("bulletList"),
            ordered: editor.isActive("orderedList"),
            quote: editor.isActive("blockquote"),
            code: editor.isActive("codeBlock"),
            undo: editor.can().undo(),
            redo: editor.can().redo(),
          }
        : null,
  });
  const update = (patch: Partial<DocumentAsset>) =>
    change({ ...useDocuments.getState().drafts[doc.id], ...patch });
  const toolbar = [
    {
      label: "粗体",
      Icon: Bold,
      active: editor?.isActive("bold"),
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "斜体",
      Icon: Italic,
      active: editor?.isActive("italic"),
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "标题",
      Icon: Heading2,
      active: editor?.isActive("heading"),
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "无序列表",
      Icon: List,
      active: editor?.isActive("bulletList"),
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "有序列表",
      Icon: ListOrdered,
      active: editor?.isActive("orderedList"),
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "引用",
      Icon: Quote,
      active: editor?.isActive("blockquote"),
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      label: "代码块",
      Icon: Code2,
      active: editor?.isActive("codeBlock"),
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
  ];
  const insertImages = async (files: File[]) => {
    if (uploadingRef.current || !richEditing || finishing) return;
    if (files.length > 20) {
      fail(new Error("每次最多上传 20 张图片"));
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    setUploadError("");
    setUploadResult("");
    setRetryMigration(false);
    setRetryFiles([]);
    let completed = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      setUploadProgress(t("正在插入图片 {0} / {1}", index + 1, files.length));
      try {
        const src = await documentImage(file);
        if (editor && !editor.isDestroyed && useDocuments.getState().selected === doc.id)
          editor.chain().focus().setImage({ src, alt: file.name }).createParagraphNear().run();
        else {
          const latest = useDocuments.getState().drafts[doc.id];
          if (latest)
            change({
              ...latest,
              content: {
                ...latest.content,
                content: [
                  ...(latest.content.content ?? []),
                  { type: "image", attrs: { src, alt: file.name } },
                ],
              },
            });
        }
        completed++;
        void useDocuments.getState().flush(doc.id).catch(fail);
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : String(e));
        setRetryFiles(files.slice(index));
        break;
      }
    }
    if (completed) setUploadResult(t("已插入 {0} 张图片", completed));
    uploadingRef.current = false;
    setUploading(false);
    setUploadProgress("");
  };
  const migrateImages = async () => {
    const api = desktop()?.images;
    if (!api) return;
    if (!(await api.status()).enabled) {
      fail(new Error("请先启用图床上传"));
      return;
    }
    if (uploadingRef.current) return;
    const sources = new Map<string, string>();
    const walk = (node: import("@tiptap/react").JSONContent) => {
      if (node.type === "image" && node.attrs?.src?.startsWith("data:image/"))
        sources.set(node.attrs.src, node.attrs.alt ?? "image");
      node.content?.forEach(walk);
    };
    walk(useDocuments.getState().drafts[doc.id].content);
    if (!sources.size) {
      fail(new Error("当前文档没有内嵌图片"));
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    setUploadError("");
    setUploadResult("");
    setRetryMigration(false);
    setRetryFiles([]);
    let completed = 0;
    try {
      for (const [source, name] of sources) {
        setUploadProgress(t("正在迁移图片 {0} / {1}", ++completed, sources.size));
        const url = await uploadImage(source, name, "document");
        const latest = useDocuments.getState().drafts[doc.id];
        if (!latest) break;
        const replace = (
          node: import("@tiptap/react").JSONContent,
        ): import("@tiptap/react").JSONContent => ({
          ...node,
          ...(node.type === "image" && node.attrs?.src === source
            ? { attrs: { ...node.attrs, src: url } }
            : {}),
          ...(node.content ? { content: node.content.map(replace) } : {}),
        });
        const content = replace(latest.content);
        change({ ...latest, content });
        if (editor && !editor.isDestroyed && useDocuments.getState().selected === doc.id)
          editor.commands.setContent(content, { emitUpdate: false });
        await useDocuments.getState().flush(doc.id);
      }
      setUploadResult(t("已迁移 {0} 张图片", completed));
    } catch (e) {
      setUploadError(
        (e instanceof Error ? e.message : String(e)) + t("；已迁移的图片已保留，可继续重试。"),
      );
      setRetryMigration(true);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      setUploadProgress("");
    }
  };
  const choices = assets.filter((a) => a.label.toLowerCase().includes(bindingQuery.toLowerCase()));
  return (
    <div className="document-detail" data-mode={editing ? "edit" : "read"}>
      <div className="document-context-bar">
        <button
          type="button"
          className="documents-library-toggle"
          aria-label={t(listCollapsed ? "展开文档列表" : "收起文档列表")}
          title={t(listCollapsed ? "展开文档列表" : "收起文档列表")}
          aria-expanded={!listCollapsed}
          aria-controls="document-library"
          onClick={() => setListCollapsed(!listCollapsed)}
        >
          <span
            className="sidebar-toggle-icon size-4"
            data-collapsed={listCollapsed}
            aria-hidden="true"
          >
            <PanelLeftClose className="sidebar-toggle-close" />
            <PanelLeftOpen className="sidebar-toggle-open" />
          </span>
          <span>{t("文档列表")}</span>
        </button>
        <button type="button" className="documents-back" onClick={onBrowse}>
          <ArrowLeft className="size-4" />
          {t("文档列表")}
        </button>
        <div className="document-context-title">
          <span className="document-context-divider" aria-hidden="true" />
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{doc.title || t("未命名文档")}</span>
        </div>
        <span className="sr-only" role="status">
          {t(editing ? "编辑模式" : "阅读模式")}
        </span>
        {editing ? (
          <Button
            size="sm"
            disabled={uploading || finishing || !editor}
            onClick={() => void finishEditing()}
          >
            <Check />
            {t(finishing ? "正在完成…" : "完成编辑")}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!editor}
            onClick={() => {
              if (typeof doc.markdown === "string") setEditMode("source");
              setEditing(true);
              requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
            }}
          >
            <Pencil />
            {t("编辑文档")}
          </Button>
        )}
        {desktop() && (
          <Button
            variant="ghost"
            size="sm"
            disabled={uploading || finishing}
            onClick={() => setExtractOpen(true)}
            aria-haspopup="dialog"
          >
            <ScanText />
            {t("提取账号")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setInfoOpen(true)} aria-haspopup="dialog">
          <Paperclip />
          {t("关联与设置")}
          {doc.bindings.length > 0 && (
            <span className="documents-count">{doc.bindings.length}</span>
          )}
        </Button>
      </div>
      {editing && (
        <div className="document-mode-toolbar">
          <div className="document-mode-tabs" role="group" aria-label={t("文档编辑方式")}>
            {(
              [
                ["rich", "富文本"],
                ["source", "Markdown 源码"],
                ["preview", "预览"],
              ] as const
            ).map(([mode, label]) => (
              <Button
                key={mode}
                size="sm"
                variant={editMode === mode ? "secondary" : "ghost"}
                aria-pressed={editMode === mode}
                disabled={uploading || finishing}
                onClick={() => {
                  setLink(null);
                  if (mode === "rich" && typeof doc.markdown === "string") setConvertOpen(true);
                  else setEditMode(mode);
                }}
              >
                {t(label)}
              </Button>
            ))}
          </div>
          {editMode !== "rich" && (
            <Button
              variant="outline"
              size="sm"
              disabled={finishing}
              onClick={() => void flush(doc.id).catch(fail)}
            >
              <Save />
              {t(status === "saved" ? "已保存" : status === "saving" ? "保存中…" : "保存")}
            </Button>
          )}
        </div>
      )}
      {richEditing && (
        <div className="document-toolbar" role="group" aria-label={t("文档格式")} inert={finishing}>
          <div className="flex flex-wrap items-center gap-1">
            {toolbar.map(({ label, Icon, active, run }) => (
              <button
                type="button"
                key={label}
                title={t(label)}
                aria-label={t(label)}
                aria-pressed={Boolean(active)}
                onClick={run}
              >
                <Icon className="size-4" />
              </button>
            ))}
            <span className="mx-1 h-5 border-l border-line" />
            <button
              type="button"
              title={t("插入链接")}
              aria-label={t("插入链接")}
              onClick={() => setLink(editor?.getAttributes("link").href ?? "")}
            >
              <Link2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t("撤销")}
              disabled={!editor?.can().undo()}
              onClick={() => editor?.chain().focus().undo().run()}
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t("重做")}
              disabled={!editor?.can().redo()}
              onClick={() => editor?.chain().focus().redo().run()}
            >
              <Redo2 className="size-4" />
            </button>
            <span className="mx-1 h-5 border-l border-line" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={uploading || !editor}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus />
              {uploading ? t("正在处理图片…") : t("插入图片")}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void insertImages(files);
              e.target.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={() => void flush(doc.id).catch(fail)}>
            <Save />
            {t(status === "saved" ? "已保存" : status === "saving" ? "保存中…" : "保存")}
          </Button>
        </div>
      )}
      <div
        ref={readerRef}
        className="document-reader-scroll"
        tabIndex={0}
        aria-label={t("文档阅读区")}
      >
        {(uploading || uploadResult) && (
          <p role="status" className="px-6 py-2 text-sm text-muted">
            {uploading ? uploadProgress : uploadResult}
          </p>
        )}
        {doc.id.startsWith("doc-legacy-server-") && typeof doc.markdown !== "string" && (
          <p className="border-b border-line px-4 py-3 text-sm text-muted">
            {t("旧 Markdown 已原样保存在代码块中；原始记录继续保留在服务器文档页。")}
          </p>
        )}
        {uploadError && (
          <div
            role="alert"
            className="m-4 space-y-2 rounded-md border border-crit p-3 text-sm text-crit"
          >
            <p className="break-words">{uploadError}</p>
            {retryFiles.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => void insertImages(retryFiles)}
              >
                {t("重试未完成的图片")}
              </Button>
            )}
            {retryMigration && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => void migrateImages().catch(fail)}
              >
                {t("继续迁移内嵌图片")}
              </Button>
            )}
          </div>
        )}
        {richEditing && link !== null && (
          <form
            className="document-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const url = new URL(link);
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                  throw new Error("链接只支持 HTTP 或 HTTPS");
                if (editor?.state.selection.empty)
                  editor
                    .chain()
                    .focus()
                    .insertContent({
                      type: "text",
                      text: link,
                      marks: [{ type: "link", attrs: { href: url.href } }],
                    })
                    .run();
                else
                  editor?.chain().focus().extendMarkRange("link").setLink({ href: url.href }).run();
                setLink(null);
              } catch (err) {
                fail(err);
              }
            }}
          >
            <input
              type="url"
              required
              autoFocus
              aria-label={t("链接地址")}
              placeholder="https://…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <Button size="sm" type="submit">
              {t("插入")}
            </Button>
            <button type="button" aria-label={t("取消")} onClick={() => setLink(null)}>
              <X className="size-4" />
            </button>
          </form>
        )}
        {error && (
          <div role="alert" className="m-4 rounded-md border border-crit p-3 text-sm text-crit">
            {t("保存失败，内容仍保留在编辑器中：")}
            {error}
          </div>
        )}
        <article className="document-paper">
          {editing ? (
            <input
              ref={titleRef}
              className="document-title"
              aria-label={t("文档标题")}
              placeholder={t("未命名文档")}
              value={doc.title}
              maxLength={160}
              readOnly={finishing}
              onChange={(e) => update({ title: e.target.value })}
            />
          ) : (
            <h2 className="document-title document-reading-title">
              {doc.title || t("未命名文档")}
            </h2>
          )}
          <div className="document-meta">
            {editing && <span>{t(desktop() ? "自动保存到本机" : "自动保存到当前浏览器")}</span>}
            {!editing && <ReadingMeta doc={doc} />}
            <span>
              {t("更新于")} {new Date(doc.updatedAt).toLocaleString()}
            </span>
          </div>
          {editing && editMode === "source" ? (
            <>
              {typeof doc.markdown !== "string" && (
                <p className="document-source-notice">
                  {t(
                    "修改源码后将以 Markdown 保存；富文本专属格式可能变化。仅查看源码不会改变原文。",
                  )}
                </p>
              )}
              <DocumentMarkdownEditor
                value={documentMarkdown(doc)}
                readOnly={finishing}
                onChange={(markdown) => update({ markdown })}
              />
            </>
          ) : typeof doc.markdown === "string" || (editing && editMode === "preview") ? (
            <div className="document-markdown" role="region" aria-label={t("文档正文")}>
              <Markdown>{documentMarkdown(doc)}</Markdown>
            </div>
          ) : (
            <EditorContent
              editor={editor}
              onPasteCapture={(event) => {
                if (!richEditing || finishing) return;
                const files = Array.from(event.clipboardData.files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (files.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  void insertImages(files);
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) event.preventDefault();
              }}
              onDragStartCapture={(event) => {
                if (!richEditing || finishing) event.preventDefault();
              }}
              onDropCapture={(event) => {
                if (!richEditing || finishing) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                const files = Array.from(event.dataTransfer.files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (files.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  void insertImages(files);
                }
              }}
            />
          )}
        </article>
      </div>
      <DocumentNavigation editor={editor} readerRef={readerRef} />
      {infoOpen && (
        <EditorDialog title={t("文档信息")} onClose={() => setInfoOpen(false)}>
          <div className="editor-scroll">
            <aside className="document-bindings">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Paperclip className="size-4" />
                {t("关联资产")}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {t("可选关联一项或多项资产。取消关联不会删除文档。")}
              </p>
              <input
                className="doc-binding-search"
                aria-label={t("查找关联资产")}
                placeholder={t("搜索资产名称")}
                value={bindingQuery}
                onChange={(e) => setBindingQuery(e.target.value)}
              />
              <div className="max-h-80 space-y-1 overflow-y-auto">
                {choices.map((asset) => (
                  <div className="flex items-center gap-2" key={refKey(asset)}>
                    <label className="document-binding min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={doc.bindings.some((ref) => refKey(ref) === refKey(asset))}
                        onChange={(e) =>
                          update({
                            bindings: e.target.checked
                              ? [...doc.bindings, { kind: asset.kind, id: asset.id }]
                              : doc.bindings.filter((ref) => refKey(ref) !== refKey(asset)),
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{asset.label}</span>
                        <span className="text-xs text-muted">{t(KIND_LABEL[asset.kind])}</span>
                      </span>
                    </label>
                    {doc.bindings.some((ref) => refKey(ref) === refKey(asset)) && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("打开资产 {0}", asset.label)}
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          void flush(doc.id)
                            .then(() => {
                              setInfoOpen(false);
                              useAppStore.getState().setExpanded({
                                kind: asset.kind,
                                id: asset.id,
                                origin: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                              });
                            })
                            .catch(fail);
                        }}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {!choices.length && (
                  <p className="py-4 text-xs text-muted">
                    {t("没有匹配的资产，可以先保存为独立文档。")}
                  </p>
                )}
              </div>
              {doc.bindings
                .filter((ref) => !assets.some((a) => refKey(a) === refKey(ref)))
                .map((ref) => (
                  <button
                    type="button"
                    className="my-2 text-xs text-muted"
                    key={refKey(ref)}
                    onClick={() =>
                      update({ bindings: doc.bindings.filter((r) => refKey(r) !== refKey(ref)) })
                    }
                  >
                    {t("移除已不存在的关联")} <X className="inline size-3" />
                  </button>
                ))}
              <div className="mt-6 space-y-3 border-t border-line pt-4">
                <h3 className="text-sm font-semibold">{t("图片设置与已有图片迁移")}</h3>
                <p className="break-words text-xs text-muted" role="status">
                  {!desktop()
                    ? t("图片保存在当前浏览器的本地文档")
                    : imageStatusError
                      ? t("图片保存位置读取失败，可在图片设置中重试。")
                      : !imageStatus
                        ? t("正在读取图片保存位置…")
                        : imageStatus.enabled
                          ? t("图片保存到图床：{0}", imageStatus.origin)
                          : t("图片嵌入本机文档")}
                </p>
                <p className="text-xs text-muted">
                  {t("支持多选、粘贴截图或拖入照片。删除图片只移除文档引用。")}
                </p>
                <ImageBedSettings onStatusChange={handleImageStatus} />
                {richEditing && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={uploading || finishing}
                    onClick={() => void migrateImages().catch(fail)}
                  >
                    {t("将内嵌图片迁移到图床")}
                  </Button>
                )}
                {(uploading || uploadResult) && (
                  <p role="status" className="text-xs text-muted">
                    {uploading ? uploadProgress : uploadResult}
                  </p>
                )}
                {uploadError && (
                  <div
                    role="alert"
                    className="space-y-2 rounded-md border border-crit p-3 text-sm text-crit"
                  >
                    <p className="break-words">{uploadError}</p>
                    {retryMigration && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={uploading}
                        onClick={() => void migrateImages().catch(fail)}
                      >
                        {t("继续迁移内嵌图片")}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-6 grid gap-2 border-t border-line pt-4">
                {desktop() && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={uploading || finishing}
                    onClick={() => {
                      setInfoOpen(false);
                      setExtractOpen(true);
                    }}
                  >
                    <ScanText />
                    {t("从文档提取账号")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    downloadText(
                      doc.title + ".md",
                      documentMarkdown(doc),
                      "text/markdown;charset=utf-8",
                    )
                  }
                >
                  <Download />
                  {t("导出 Markdown")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadJson(doc.title + ".json", doc)}
                >
                  <Download />
                  {t("导出文档")}
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={uploading || finishing}
                  onClick={(event) => onDelete(event.currentTarget)}
                >
                  <Trash2 />
                  {t("删除文档")}
                </Button>
              </div>
            </aside>
          </div>
        </EditorDialog>
      )}
      {convertOpen && (
        <AlertDialog.Root open onOpenChange={setConvertOpen}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="editor-backdrop" />
            <AlertDialog.Content className="document-delete-dialog">
              <AlertDialog.Title className="text-lg font-semibold">
                {t("转换为富文本编辑？")}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-muted">
                {t(
                  "转换后将以富文本保存，Markdown 表格、脚注和源码排版可能变化。你可以先导出 Markdown 留存原文。",
                )}
              </AlertDialog.Description>
              <div className="document-delete-buttons">
                <AlertDialog.Cancel asChild>
                  <Button variant="secondary">{t("保留 Markdown")}</Button>
                </AlertDialog.Cancel>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadText(
                      doc.title + ".md",
                      documentMarkdown(doc),
                      "text/markdown;charset=utf-8",
                    )
                  }
                >
                  {t("导出 Markdown")}
                </Button>
                <AlertDialog.Action asChild>
                  <Button
                    onClick={(event) => {
                      event.preventDefault();
                      try {
                        const latest = useDocuments.getState().drafts[doc.id];
                        const content = markdownContent(documentMarkdown(latest));
                        const { markdown: _markdown, ...rich } = latest;
                        change({ ...rich, content });
                        editor?.commands.setContent(content, { emitUpdate: false });
                        setEditMode("rich");
                        setConvertOpen(false);
                      } catch (cause) {
                        fail(cause);
                      }
                    }}
                  >
                    {t("确认转换")}
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
      {extractOpen && (
        <DocumentAccountExtract documentId={doc.id} close={() => setExtractOpen(false)} />
      )}
    </div>
  );
}

/** 正文字数与阅读时长：中文按字计，英文按词计，约每分钟 400 字。 */
function ReadingMeta({ doc }: { doc: { markdown?: string; content: unknown } }) {
  const count = useMemo(() => {
    const parts: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const item = node as { type?: string; text?: string; content?: unknown[] };
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      for (const child of item.content ?? []) walk(child);
    };
    if (typeof doc.markdown === "string") parts.push(doc.markdown);
    else walk(doc.content);
    const text = parts.join(" ");
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
    return han + words;
  }, [doc.markdown, doc.content]);
  return (
    <>
      <span>{t("{0} 字", count.toLocaleString())}</span>
      <span>{t("约 {0} 分钟读完", Math.max(1, Math.round(count / 400)))}</span>
    </>
  );
}
