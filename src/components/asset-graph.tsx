import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
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
import "./resource-relations.css";

type AssetNode = Node<
  { asset: ResourceRow; vertical: boolean; focus?: (ref: ResourceRef) => void },
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
function GraphNode({ id, data, isConnectable }: NodeProps<AssetNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => updateNodeInternals(id), [id, data.vertical, updateNodeInternals]);
  const asset = data.asset;
  const Icon = ICONS[asset.kind];
  return (
    <div className="asset-graph-node" data-asset-id={asset.id} data-asset-kind={asset.kind}>
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
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          void openResource(asset, { x: rect.x, y: rect.y, w: rect.width, h: rect.height }).catch(
            (error) => toast.error(String(error.message)),
          );
        }}
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
  return <BaseEdge id={props.id} path={path} style={props.style} />;
}
const edgeTypes = { resource: ResourceEdge };

export default function AssetGraph(props: {
  rows: ResourceRow[];
  resources: ResourceRow[];
  relations: Relation[];
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
    <div className="resource-graph-workspace">
      <div className="resource-graph-intro">
        <p>{t("实线表示已保存关联，虚线表示文档绑定；号码和节点可直接关联其他资源。")}</p>
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
      <ResourceChainPanel
        resources={props.resources}
        relations={props.relations}
        focus={root || null}
        onFocus={onFocus}
      />
      {manage && <ResourceRelationsPanel resources={props.resources} relations={props.relations} />}
      {shown.length > 300 && (
        <p className="text-sm text-muted">
          {t("画布显示前 300 项资源，请缩小筛选范围查看其余资源。")}
        </p>
      )}
      <ReactFlowProvider>
        <GraphCanvas rows={shown.slice(0, 300)} relations={props.relations} onFocus={onFocus} />
      </ReactFlowProvider>
    </div>
  );
}

function GraphCanvas({
  rows,
  relations,
  onFocus,
}: {
  rows: ResourceRow[];
  relations: Relation[];
  onFocus: (ref: ResourceRef) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState(false);
  const [frameSize, setFrameSize] = useState("");
  const [layoutRevision, setLayoutRevision] = useState(0);
  const nodesInitialized = useNodesInitialized();
  const [linkMode, setLinkMode] = useState(false);
  const graph = useMemo(
    () => resourceGraph(rows, relations, vertical),
    [rows, relations, vertical],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<AssetNode>(graph.nodes);
  const edges = useMemo(() => {
    const outerBoundary = Math.min(
      0,
      ...nodes.map((node) => (vertical ? node.position.x : node.position.y)),
    );
    return graph.edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, lane: outerBoundary - edge.data.laneOffset },
    }));
  }, [graph.edges, nodes, vertical]);
  const { fitBounds, getNodes, getNodesBounds, zoomIn, zoomOut } = useReactFlow();
  const theme = useSettings((s) => s.resolved);
  const motionMode = useMotionPolicy();
  const duration = motionMode === "full" ? 180 : 0;
  const topology = JSON.stringify([vertical, graph.nodes.map((node) => node.id)]);
  const previousTopology = useRef(topology);
  const routeMargin = Math.max(
    24,
    ...graph.edges.filter((edge) => edge.data.bypass).map((edge) => edge.data.laneOffset + 16),
  );
  const fitGraph = useCallback(
    (transition = 0) => {
      const expectedIds = new Set<string>(JSON.parse(topology)[1]);
      const current = getNodes();
      if (
        !current.length ||
        current.length !== expectedIds.size ||
        current.some(
          (node) => !expectedIds.has(node.id) || !node.measured?.width || !node.measured?.height,
        )
      )
        return;
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
      );
    },
    [fitBounds, getNodes, getNodesBounds, topology, routeMargin, vertical],
  );
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => {
      setVertical(element.clientWidth < 600);
      setFrameSize(`${element.clientWidth}:${element.clientHeight}`);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // 数据更新保留拖动位置；筛选导致节点集合变化时重新布局并适配。
    const preserve = previousTopology.current === topology;
    previousTopology.current = topology;
    setNodes((previous) =>
      graph.nodes.map((node) => {
        const old = previous.find((item) => item.id === node.id);
        return {
          ...old,
          ...node,
          data: { ...node.data, focus: onFocus },
          position: (preserve && old?.position) || node.position,
        };
      }),
    );
  }, [graph.nodes, setNodes, topology, onFocus]);
  useEffect(() => {
    if (!nodesInitialized) return;
    // 等受控节点和连接点完成测量，再统一适配，避免两套初始 fit 互相覆盖。
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => fitGraph());
    });
    return () => cancelAnimationFrame(frame);
  }, [fitGraph, nodesInitialized, frameSize, layoutRevision]);
  return (
    <div ref={container} className="asset-graph" role="region" aria-label={t("资产关系图")}>
      <ReactFlow
        nodes={nodes}
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
        edgesFocusable={false}
        deleteKeyCode={null}
        colorMode={theme}
        ariaLabelConfig={{
          "node.a11yDescription.default": t("资产节点"),
          "node.a11yDescription.keyboardDisabled": t("资产节点"),
        }}
      />
      <div className="graph-toolbar">
        <span className="graph-count">
          {t("{0} 项资源 · {1} 条已确认关联", rows.length, graph.edges.length)}
        </span>
        <div className="graph-controls">
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
            onClick={() => fitGraph(duration)}
          >
            <Maximize className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={t("重排节点")}
            aria-label={t("重排节点")}
            onClick={() => {
              setNodes(graph.nodes);
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
