import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  BaseEdge,
  Handle,
  Position,
  useNodesState,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  MiniMap,
  Panel,
  type Node,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import {
  Globe,
  Shield,
  Server,
  Mail,
  KeyRound,
  Sparkles,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  Link2,
  FileText,
  Phone,
  Focus,
  Radio,
  Info,
  ArrowRightLeft,
  ArrowDownUp,
  Map as MapIcon,
  Expand,
  Shrink,
  Palette,
  X,
  ArrowUpRight,
  Network,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import "@xyflow/react/dist/style.css";
import {
  resourceGraph,
  resourceKey,
  canRelateResources,
  resourceRelationPath,
  relationPaths,
  type ResourceRef,
  type ResourceRow,
  type Relation,
} from "@/lib/resource-relations.mjs";
import { updateResourceRelation } from "@/lib/resource-relation-actions";
import { openResource, resourceKindLabel } from "@/lib/resource-inventory";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { useMotionPolicy } from "@/lib/motion";
import { useSettings } from "@/lib/settings";
import { StatusBadge } from "./ui/status-badge";
import { Button } from "./ui/button";
import { useAppStore } from "@/lib/store";
import { ResourceRelationsPanel } from "./resource-relations-panel";
import { ResourceChainPanel } from "./resource-chain-panel";
import { Select } from "./ui/select";
import { GraphAppearancePanel } from "./graph-appearance-panel";
import { graphColorLegend, graphEdgeColor } from "@/lib/graph-appearance";
import "./resource-relations.css";

type AssetNode = Node<
  {
    asset: ResourceRow;
    vertical: boolean;
    focus?: (ref: ResourceRef) => void;
    highlightColor?: string;
    pulse?: boolean;
  },
  "asset"
>;
const ICONS = {
  domain: Globe,
  cert: Shield,
  server: Server,
  mail: Mail,
  ai: Sparkles,
  secret: KeyRound,
  service: Globe,
  document: FileText,
  phone: Phone,
  node: Radio,
};
async function openGraphResource(asset: ResourceRef, event: MouseEvent<HTMLButtonElement>) {
  const { x, y, width: w, height: h } = event.currentTarget.getBoundingClientRect();
  try {
    if (document.fullscreenElement?.classList.contains("asset-graph"))
      await document.exitFullscreen();
    await openResource(asset, { x, y, w, h });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

function GraphNode({ id, data, isConnectable }: NodeProps<AssetNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [id, data.vertical, updateNodeInternals]);
  const asset = data.asset;
  const Icon = ICONS[asset.kind];
  return (
    <div
      className="asset-graph-node"
      data-asset-id={asset.id}
      data-asset-kind={asset.kind}
      data-connection-highlighted={Boolean(data.highlightColor)}
      data-connection-pulse={Boolean(data.pulse)}
      style={
        data.highlightColor
          ? ({ "--graph-selection-color": data.highlightColor } as CSSProperties)
          : undefined
      }
    >
      <Handle
        type="target"
        position={data.vertical ? Position.Top : Position.Left}
        isConnectable={isConnectable}
      />
      <div className="graph-node-meta">
        <span>
          <Icon className="size-4" />
          {t(resourceKindLabel(asset))}
        </span>
        {asset.kind !== "document" && <StatusBadge status={asset.status} pending={asset.pending} />}
      </div>
      <button
        className="nodrag asset-name"
        title={t("查看 {0}", asset.name)}
        onClick={(event) => openGraphResource(asset, event)}
      >
        <span>{asset.name}</span>
        <small>{asset.detail}</small>
      </button>
      <button
        type="button"
        className="nodrag flex w-full items-center justify-center gap-1 border-t border-line px-2 py-1.5 text-2xs text-muted hover:text-ink"
        aria-label={t("查看 {0} 的关联链", asset.name)}
        onClick={() => data.focus?.(asset)}
      >
        <Focus className="size-3" />
        {t("查看关联链")}
      </button>
      <Handle
        type="source"
        position={data.vertical ? Position.Bottom : Position.Right}
        isConnectable={isConnectable}
      />
    </div>
  );
}
const nodeTypes = { asset: GraphNode };
function ResourceEdge(props: EdgeProps) {
  const path = resourceRelationPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    vertical: Boolean(props.data?.vertical),
    bypass: Boolean(props.data?.bypass),
    lane: Number(props.data?.lane ?? -40),
  });
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      className={props.data?.pulseSelection ? "graph-path-pulse" : undefined}
    />
  );
}
const edgeTypes = { resource: ResourceEdge };

export default function AssetGraph(props: {
  rows: ResourceRow[];
  resources: ResourceRow[];
  relations: Relation[];
  compact?: boolean;
  all: boolean;
  onScopeChange?: (all: boolean) => void;
}) {
  const [manage, setManage] = useState(false);
  const focus = useAppStore((state) => state.relationFocus);
  const onFocus = useCallback(
    (ref: ResourceRef | null) => useAppStore.setState({ relationFocus: ref }),
    [],
  );
  const root = focus && props.resources.find((r) => resourceKey(r) === resourceKey(focus));
  const shown = useMemo(
    () =>
      root ? relationPaths(props.resources, props.relations, root).map((p) => p.row) : props.rows,
    [root, props.resources, props.relations, props.rows],
  );
  return (
    <div
      className={
        props.compact
          ? "resource-graph-workspace resource-graph-compact"
          : "resource-graph-workspace"
      }
    >
      <header className="resource-graph-header">
        {props.compact && <h1 className="resource-graph-title">{t("资产关系图")}</h1>}
        {props.onScopeChange && (
          <div className="resource-graph-scope" role="group" aria-label={t("资源范围")}>
            {[false, true].map((all) => (
              <Button
                key={String(all)}
                size="sm"
                variant={!root && props.all === all ? "secondary" : "ghost"}
                aria-pressed={!root && props.all === all}
                onClick={() => {
                  onFocus(null);
                  props.onScopeChange?.(all);
                }}
              >
                {t(all ? "全部资源" : "当前资产及关联")}
              </Button>
            ))}
          </div>
        )}
        <div className="resource-graph-actions">
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("图谱说明")}
                title={t("图谱说明")}
              >
                <Info />
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="resource-graph-help"
                sideOffset={8}
                align="end"
                collisionPadding={12}
              >
                <h2>{t("图谱说明")}</h2>
                <p>{t("实线表示已保存关联，虚线表示文档绑定；号码和节点可直接关联其他资源。")}</p>
                <p>
                  {t(
                    "选择一个邮箱或账号，查看直接、间接关联及相连文档。搜索会保留已确认的关联链；建议需要确认后才进入图中。",
                  )}
                </p>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={manage}
            onClick={() => setManage(!manage)}
          >
            <Link2 />
            {t("管理资源关联")}
          </Button>
        </div>
      </header>
      <ResourceChainPanel
        resources={props.resources}
        relations={props.relations}
        focus={root || null}
        onFocus={onFocus}
        all={props.all}
      />
      {manage && <ResourceRelationsPanel resources={props.resources} relations={props.relations} />}
      {shown.length > 300 && (
        <p className="text-sm text-muted">
          {t("画布显示前 300 项资源，请缩小筛选范围查看其余资源。")}
        </p>
      )}
      <ReactFlowProvider>
        <GraphCanvas
          rows={shown.slice(0, 300)}
          relations={props.relations}
          onFocus={onFocus}
          focus={root || null}
          all={props.all}
          compact={props.compact}
        />
      </ReactFlowProvider>
    </div>
  );
}

function GraphCanvas({
  rows,
  relations,
  onFocus,
  focus,
  all,
  compact,
}: {
  rows: ResourceRow[];
  relations: Relation[];
  onFocus: (ref: ResourceRef) => void;
  focus: ResourceRef | null;
  all: boolean;
  compact?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<"auto" | "horizontal" | "vertical">("auto");
  const [narrow, setNarrow] = useState(false);
  const vertical = direction === "vertical" || (direction === "auto" && narrow);
  const [layout, setLayout] = useState<"types" | "relationships">(
    compact ? "relationships" : "types",
  );
  const [minimap, setMinimap] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const appearance = useSettings((state) => state.graphAppearance);
  const motionMode = useMotionPolicy();
  const [frameSize, setFrameSize] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const focusKey = focus ? resourceKey(focus) : null;
  const nodesInitialized = useNodesInitialized();
  const [linkMode, setLinkMode] = useState(false);
  const graph = useMemo(
    () => resourceGraph(rows, relations, vertical, layout, focus),
    [rows, relations, vertical, layout, focus],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<AssetNode>(graph.nodes);
  const clearAssetSelection = useCallback(() => {
    setSelectedNode(null);
    setNodes((current) =>
      current.map((node) => (node.selected ? { ...node, selected: false } : node)),
    );
  }, [setNodes]);
  const chosenEdge = graph.edges.find((edge) => edge.id === selectedEdge);
  const chosen = chosenEdge?.data.relation;
  const selectionColor = chosen ? graphEdgeColor(appearance, chosen) : undefined;
  const selectedNodeEdges = useMemo(
    () =>
      selectedNode
        ? graph.edges.filter((edge) => edge.source === selectedNode || edge.target === selectedNode)
        : [],
    [graph.edges, selectedNode],
  );
  const selectedNodeIds = useMemo(() => {
    const ids = new Set<string>(selectedNode ? [selectedNode] : []);
    for (const edge of selectedNodeEdges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, [selectedNode, selectedNodeEdges]);
  const selectedNodeColor = selectedNodeEdges[0]
    ? graphEdgeColor(appearance, selectedNodeEdges[0].data.relation)
    : appearance.singleColor;
  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => {
        const highlighted = chosenEdge
          ? node.id === chosenEdge.source || node.id === chosenEdge.target
          : selectedNode
            ? selectedNodeIds.has(node.id)
            : false;
        const dimmed = Boolean(chosenEdge || selectedNode) && !highlighted;
        return {
          ...node,
          zIndex: highlighted ? 3 : 0,
          style: { ...node.style, opacity: dimmed ? 0.24 : 1 },
          data: {
            ...node.data,
            highlightColor: highlighted ? (selectionColor ?? selectedNodeColor) : undefined,
            pulse: highlighted && appearance.pulseSelection && motionMode === "full",
          },
        };
      }),
    [
      nodes,
      chosenEdge,
      selectionColor,
      selectedNode,
      selectedNodeIds,
      selectedNodeColor,
      appearance.pulseSelection,
      motionMode,
    ],
  );
  const resourceNames = useMemo(
    () => Object.fromEntries(rows.map((row) => [resourceKey(row), row.name])),
    [rows],
  );
  const edges = useMemo(() => {
    const outerBoundary = Math.min(
      0,
      ...nodes.map((node) => (vertical ? node.position.x : node.position.y)),
    );
    return graph.edges.map((edge) => {
      const selectedIncident =
        Boolean(selectedNode) && (edge.source === selectedNode || edge.target === selectedNode);
      const hoveredIncident =
        Boolean(hovered) && (edge.source === hovered || edge.target === hovered);
      return {
        ...edge,
        data: {
          ...edge.data,
          lane: outerBoundary - edge.data.laneOffset,
          pulseSelection:
            (edge.id === selectedEdge || selectedIncident) &&
            appearance.pulseSelection &&
            motionMode === "full",
        },
        className: edge.id === selectedEdge || selectedIncident ? "graph-edge-active" : undefined,
        selected: edge.id === selectedEdge,
        ariaLabel: t(
          "关联连线：{0}",
          [edge.data.relation.from, edge.data.relation.to]
            .map((ref) => resourceNames[resourceKey(ref)] ?? ref.id)
            .join(" ↔ "),
        ),
        style: {
          ...edge.style,
          stroke: graphEdgeColor(appearance, edge.data.relation),
          color: graphEdgeColor(appearance, edge.data.relation),
          opacity: chosenEdge
            ? edge.id === chosenEdge.id
              ? 1
              : 0.1
            : selectedNode
              ? selectedIncident
                ? 1
                : 0.08
              : hovered && !hoveredIncident
                ? 0.12
                : 1,
          strokeWidth:
            edge.id === selectedEdge || selectedIncident || hoveredIncident
              ? appearance.width + 1
              : appearance.width,
        },
      };
    });
  }, [
    graph.edges,
    nodes,
    vertical,
    hovered,
    appearance,
    selectedEdge,
    selectedNode,
    resourceNames,
    chosenEdge,
    motionMode,
  ]);
  const chosenInfo = chosen
    ? {
        id: chosen.id,
        label: [chosen.from, chosen.to]
          .map((ref) => rows.find((row) => resourceKey(row) === resourceKey(ref))?.name ?? ref.id)
          .join(" ↔ "),
        color: graphEdgeColor(appearance, chosen),
      }
    : null;
  const selectedAsset = graph.nodes.find((node) => node.id === selectedNode)?.data.asset;
  const { fitBounds, getNodes, getNodesBounds, getZoom, zoomIn, zoomOut, setCenter } =
    useReactFlow();
  const theme = useSettings((s) => s.resolved);
  const duration = motionMode === "full" ? 180 : 0;
  useEffect(() => {
    clearAssetSelection();
    setSelectedEdge(null);
    setAppearanceOpen(false);
    setLayoutRevision((revision) => revision + 1);
  }, [all, focusKey, clearAssetSelection]);
  useEffect(() => {
    if (selectedEdge && !chosenEdge) setSelectedEdge(null);
  }, [selectedEdge, chosenEdge]);
  useEffect(() => {
    if (selectedNode && !nodes.some((node) => node.id === selectedNode)) setSelectedNode(null);
  }, [nodes, selectedNode]);
  useEffect(() => {
    if (!selectedEdge) return;
    const clear = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !appearanceOpen &&
        !document.fullscreenElement &&
        !document.querySelector('[role="dialog"], [role="listbox"]')
      )
        setSelectedEdge(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [selectedEdge, appearanceOpen]);
  const topology = JSON.stringify([
    vertical,
    graph.nodes.map((node) => node.id),
    layout,
    layout === "relationships" && focus ? resourceKey(focus) : null,
    layout === "relationships" ? graph.edges.map((edge) => edge.id).sort() : null,
  ]);
  const previousTopology = useRef(topology);
  const routeMargin = Math.max(
    24,
    ...graph.edges.filter((edge) => edge.data.bypass).map((edge) => edge.data.laneOffset + 16),
  );
  const fitGraph = useCallback(
    (transition = 0, readable = false) => {
      const expectedIds = new Set<string>(JSON.parse(topology)[1]);
      const current = getNodes();
      if (
        !current.length ||
        current.length !== expectedIds.size ||
        current.some(
          (node) => !expectedIds.has(node.id) || !node.measured?.width || !node.measured?.height,
        )
      )
        return false;
      const bounds = getNodesBounds(current);
      // 适配须纳入外侧绕线，不能只按卡片边界缩放，否则窄屏会裁掉跨列关联。
      void fitBounds(
        {
          x: bounds.x - (vertical ? routeMargin : 32),
          y: bounds.y - (vertical ? 32 : routeMargin),
          width: bounds.width + (vertical ? routeMargin : 32) + 32,
          height: bounds.height + (vertical ? 32 : routeMargin) + 32,
        },
        { padding: 0.12, duration: transition },
      ).then(() => {
        if (!readable || getZoom() >= 0.55) return;
        // 大图优先定位到聚焦资源或关联最多的节点，避免停在分组之间的空白处。
        const degree = new Map<string, number>();
        for (const { source, target } of graph.edges) {
          degree.set(source, (degree.get(source) ?? 0) + 1);
          degree.set(target, (degree.get(target) ?? 0) + 1);
        }
        const anchor =
          current.find((node) => node.id === encodeURIComponent(focusKey ?? "")) ??
          current.reduce((best, node) =>
            (degree.get(node.id) ?? 0) > (degree.get(best.id) ?? 0) ? node : best,
          );
        const anchorBounds = getNodesBounds([anchor]);
        void setCenter(
          anchorBounds.x + anchorBounds.width / 2,
          anchorBounds.y + anchorBounds.height / 2,
          {
            zoom: 0.55,
            duration: transition,
          },
        );
      });
      return true;
    },
    [
      fitBounds,
      getNodes,
      getNodesBounds,
      getZoom,
      setCenter,
      topology,
      focusKey,
      graph.edges,
      routeMargin,
      vertical,
    ],
  );
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => {
      setNarrow(element.clientWidth < 600);
      setFrameSize(`${element.clientWidth}:${element.clientHeight}`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const changed = (event: Event) => {
      if (event.target !== container.current) return;
      setFullscreen(document.fullscreenElement === container.current);
      setLayoutRevision((revision) => revision + 1);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        appearanceOpen ||
        document.querySelector('[role="dialog"], [role="listbox"]')
      )
        return;
      event.preventDefault();
      if (document.fullscreenElement === container.current)
        void document
          .exitFullscreen()
          .catch((error) => toast.error(t("无法退出图谱全屏：{0}", String(error.message))));
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [fullscreen, appearanceOpen]);
  useEffect(() => {
    // 数据更新保留拖动位置；筛选导致节点集合变化时重新布局并适配。
    const preserve = previousTopology.current === topology;
    if (!preserve) setHovered(null);
    previousTopology.current = topology;
    setNodes((previous) => {
      const previousById = new Map(previous.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const old = previousById.get(node.id);
        return {
          ...old,
          ...node,
          data: { ...node.data, focus: onFocus },
          position: (preserve && old?.position) || node.position,
        };
      });
    });
  }, [graph.nodes, setNodes, topology, onFocus]);
  const fitted = useRef(false);
  const lastFitRevision = useRef(-1);
  useEffect(() => {
    if (!nodesInitialized) return;
    // 初次进入和明确触发的重排才 fit；后台数据刷新不能重置用户视口。
    if (fitted.current && lastFitRevision.current === layoutRevision) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!fitGraph(0, true)) return;
        fitted.current = true;
        lastFitRevision.current = layoutRevision;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [fitGraph, nodesInitialized, frameSize, layoutRevision]);
  return (
    <div ref={container} className="asset-graph" role="region" aria-label={t("资产关系图")}>
      <ReactFlow
        nodes={renderedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.1}
        maxZoom={1.8}
        nodesConnectable={linkMode}
        isValidConnection={({ source, target }) => {
          const from = rows.find((row) => encodeURIComponent(resourceKey(row)) === source);
          const to = rows.find((row) => encodeURIComponent(resourceKey(row)) === target);
          return Boolean(from && to && canRelateResources(from, to));
        }}
        onConnect={({ source, target }) => {
          if (!linkMode) return;
          const from = rows.find((row) => encodeURIComponent(resourceKey(row)) === source);
          const to = rows.find((row) => encodeURIComponent(resourceKey(row)) === target);
          if (from && to)
            void updateResourceRelation(from, to).catch((error) =>
              toast.error(t(String(error.message))),
            );
        }}
        edgesFocusable
        onNodeClick={(_, node) => {
          clearAssetSelection();
          setSelectedNode(node.id);
          setSelectedEdge(null);
          setAppearanceOpen(false);
        }}
        onEdgeClick={(_, edge) => {
          clearAssetSelection();
          setSelectedEdge(edge.id);
          setAppearanceOpen(false);
        }}
        onEdgeDoubleClick={(_, edge) => {
          clearAssetSelection();
          setSelectedEdge(edge.id);
          setAppearanceOpen(true);
        }}
        onPaneClick={() => {
          clearAssetSelection();
          setSelectedEdge(null);
        }}
        onEdgesChange={(changes) => {
          const picked = changes.find((change) => change.type === "select" && change.selected);
          if (picked?.type === "select") setSelectedEdge(picked.id);
          else if (
            changes.some(
              (change) =>
                change.type === "select" && !change.selected && change.id === selectedEdge,
            )
          )
            setSelectedEdge(null);
        }}
        deleteKeyCode={null}
        colorMode={theme}
        ariaLabelConfig={{
          "node.a11yDescription.default": t("资产节点"),
          "node.a11yDescription.keyboardDisabled": t("资产节点"),
        }}
        onNodeMouseEnter={(_, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
      >
        {selectedAsset && !chosenInfo && (
          <Panel position="bottom-left" className="graph-selection-info">
            <div role="status">
              <b>{t("聚焦资产")}</b>
              <span title={selectedAsset.name}>{selectedAsset.name}</span>
              <small>{t("直接关联 {0} 项", selectedNodeIds.size - 1)}</small>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("打开资产 {0}", selectedAsset.name)}
              title={t("打开资产 {0}", selectedAsset.name)}
              onClick={(event) => openGraphResource(selectedAsset, event)}
            >
              <ArrowUpRight />
              <span className="graph-open-label">{t("打开资源")}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("定位选中资产")}
              title={t("定位选中资产")}
              onClick={() => {
                const targets = getNodes().filter((node) => selectedNodeIds.has(node.id));
                if (!targets.length) return;
                const bounds = getNodesBounds(targets);
                void fitBounds(
                  {
                    x: bounds.x - 28,
                    y: bounds.y - 28,
                    width: bounds.width + 56,
                    height: bounds.height + 56,
                  },
                  { padding: 0.15, duration },
                );
              }}
            >
              <Focus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("清除资产高亮")}
              title={t("清除资产高亮")}
              onClick={clearAssetSelection}
            >
              <X />
            </Button>
          </Panel>
        )}
        {rows.length === 0 && (
          <div className="graph-empty-state" role="status">
            <Network aria-hidden="true" />
            <p>{t("当前范围没有资源")}</p>
          </div>
        )}
        {chosenInfo && (
          <Panel position="bottom-left" className="graph-selection-info">
            <div role="status">
              <b>{t("选中关联")}</b>
              <span title={chosenInfo.label}>{chosenInfo.label}</span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("定位选中关联")}
              title={t("定位选中关联")}
              onClick={() => {
                const targets = getNodes().filter(
                  (node) => node.id === chosenEdge?.source || node.id === chosenEdge?.target,
                );
                if (targets.length !== 2) return;
                const bounds = getNodesBounds(targets);
                const lane = edges.find((edge) => edge.id === selectedEdge)?.data.lane ?? 0;
                const x = vertical ? Math.min(bounds.x, lane) : bounds.x;
                const y = vertical ? bounds.y : Math.min(bounds.y, lane);
                void fitBounds(
                  {
                    x: x - 24,
                    y: y - 24,
                    width: bounds.x + bounds.width - x + 48,
                    height: bounds.y + bounds.height - y + 48,
                  },
                  { padding: 0.15, duration },
                );
              }}
            >
              <Focus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("调整选中连线配色")}
              title={t("调整选中连线配色")}
              onClick={() => setAppearanceOpen(true)}
            >
              <Palette />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("清除关联高亮")}
              title={t("清除关联高亮")}
              onClick={() => setSelectedEdge(null)}
            >
              <X />
            </Button>
          </Panel>
        )}
        {appearance.showLegend && graph.edges.length > 0 && (
          <Panel position="top-left" className="graph-color-legend" aria-label={t("连线颜色图例")}>
            {graphColorLegend(
              appearance,
              graph.edges.map((edge) => edge.data.relation),
            ).map((item) => (
              <span key={item.key}>
                <i style={{ borderColor: item.color }} />
                {t(item.label)}
              </span>
            ))}
          </Panel>
        )}
        {minimap && (
          <MiniMap
            pannable
            zoomable
            position="top-right"
            ariaLabel={t("图谱导航小地图")}
            nodeColor="var(--color-card)"
            nodeStrokeColor="var(--color-muted)"
          />
        )}
      </ReactFlow>
      <div className="graph-toolbar">
        <span className="graph-count">
          {t("{0} 项资源 · {1} 条已确认关联", rows.length, graph.edges.length)}
        </span>
        <div className="graph-layout-controls" role="group" aria-label={t("图谱布局")}>
          <Select
            aria-label={t("布局方式")}
            portalContainer={fullscreen ? container.current : undefined}
            value={layout}
            onValueChange={(value) => {
              setLayout(value as "types" | "relationships");
              setLayoutRevision((revision) => revision + 1);
            }}
            options={[
              { value: "relationships", label: t("关系分层") },
              { value: "types", label: t("按类型分组") },
            ]}
          />
          <Button
            size="sm"
            variant={vertical ? "ghost" : "secondary"}
            aria-label={t("横向布局")}
            aria-pressed={!vertical}
            onClick={() => {
              setDirection("horizontal");
              setLayoutRevision((revision) => revision + 1);
            }}
          >
            <ArrowRightLeft />
            <span>{t("横向")}</span>
          </Button>
          <Button
            size="sm"
            variant={vertical ? "secondary" : "ghost"}
            aria-label={t("纵向布局")}
            aria-pressed={vertical}
            onClick={() => {
              setDirection("vertical");
              setLayoutRevision((revision) => revision + 1);
            }}
          >
            <ArrowDownUp />
            <span>{t("纵向")}</span>
          </Button>
        </div>
        <div className="graph-controls">
          <GraphAppearancePanel
            open={appearanceOpen}
            onOpenChange={setAppearanceOpen}
            portalContainer={fullscreen ? container.current : undefined}
            selected={chosenInfo}
            onClearSelection={() => setSelectedEdge(null)}
          />
          <Button
            size="icon-sm"
            variant={minimap ? "secondary" : "ghost"}
            title={t("导航小地图")}
            aria-label={t("导航小地图")}
            aria-pressed={minimap}
            onClick={() => setMinimap(!minimap)}
          >
            <MapIcon className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={t("按原尺寸查看")}
            aria-label={t("按原尺寸查看")}
            onClick={() => {
              const bounds = getNodesBounds(getNodes());
              void setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
                zoom: 1,
                duration,
              });
            }}
          >
            100%
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t(fullscreen ? "退出图谱全屏" : "全屏查看图谱")}
            aria-label={t(fullscreen ? "退出图谱全屏" : "全屏查看图谱")}
            onClick={() => {
              const task = fullscreen
                ? document.exitFullscreen()
                : container.current?.requestFullscreen();
              void task?.catch((error) =>
                toast.error(t("无法全屏显示：{0}", String(error.message))),
              );
            }}
          >
            {fullscreen ? <Shrink className="size-4" /> : <Expand className="size-4" />}
          </Button>
          <Button
            size="icon-sm"
            variant={linkMode ? "solid" : "ghost"}
            aria-pressed={linkMode}
            title={t("连接资产")}
            aria-label={t("连接资产")}
            onClick={() => setLinkMode(!linkMode)}
          >
            <Link2 className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("放大")}
            aria-label={t("放大")}
            onClick={() => void zoomIn({ duration })}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("缩小")}
            aria-label={t("缩小")}
            onClick={() => void zoomOut({ duration })}
          >
            <Minus className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("适应画布")}
            aria-label={t("适应画布")}
            onClick={() => fitGraph(duration, false)}
          >
            <Maximize className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("重排节点")}
            aria-label={t("重排节点")}
            onClick={() => {
              setNodes(
                graph.nodes.map((node) => ({ ...node, data: { ...node.data, focus: onFocus } })),
              );
              setLayoutRevision((value) => value + 1);
            }}
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
