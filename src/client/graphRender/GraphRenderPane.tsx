// Unified, dense render-settings panel for the ontology and the link graph.
//
// One panel serves both surfaces so we're not tracking two UIs. Sections are
// gated by `mode` (ontology | links) and `view` (3d | tree) so irrelevant
// controls stay off-screen instead of noisily disabled.
//
// Layout: each row is `[label · slider · value]` on a single line so the whole
// pane stays scannable — matches the density of the legacy bespoke panel while
// staying inside our shadcn/base-ui primitives.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  BG_PRESETS,
  DEFAULT_GRAPH_RENDER_SETTINGS,
  type GraphRenderSettings,
  type LabelDegreeMode,
  type LinkColorMode,
} from "./settings";

export type GraphRenderMode = "ontology" | "links";
export type GraphRenderView = "3d" | "tree";

interface RowProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

function Row({
  id,
  label,
  value,
  min,
  max,
  step,
  format = (n) => n.toFixed(1),
  onChange,
}: RowProps) {
  return (
    <div
      data-slot="graph-render-row"
      className="grid grid-cols-[7rem_minmax(0,1fr)_3rem] items-center gap-2"
    >
      <label htmlFor={id} className="truncate text-sm text-foreground">
        {label}
      </label>
      <Slider
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Number(next))}
        aria-label={label}
      />
      <output htmlFor={id} className="text-right font-mono text-xs tabular-nums text-muted-foreground">
        {format(value)}
      </output>
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(c) => onCheckedChange(c === true)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={id} className="text-sm leading-none text-foreground">
          {label}
        </label>
        {hint ? (
          <span className="mt-0.5 text-xs leading-tight text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      data-slot="graph-render-section"
      className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export interface GraphRenderPaneProps {
  mode: GraphRenderMode;
  view: GraphRenderView;
  settings: GraphRenderSettings;
  onChange: (settings: GraphRenderSettings) => void;
  onReset?: () => void;
  /**
   * Link-graph-only: external shading toggle. When these are provided (and
   * mode === "links"), the pane renders the "Shading" checkbox. The link-graph
   * host owns this bit because it also flips shading automatically when path
   * mode turns on.
   */
  shadingEnabled?: boolean;
  onShadingEnabledChange?: (enabled: boolean) => void;
}

export function GraphRenderPane({
  mode,
  view,
  settings,
  onChange,
  onReset,
  shadingEnabled,
  onShadingEnabledChange,
}: GraphRenderPaneProps) {
  const set = <K extends keyof GraphRenderSettings>(
    key: K,
    value: GraphRenderSettings[K],
  ) => onChange({ ...settings, [key]: value });

  const is3d = view === "3d";
  const isLinks = mode === "links";
  const isOntology = mode === "ontology";

  const reset = () => {
    if (onReset) onReset();
    else onChange(DEFAULT_GRAPH_RENDER_SETTINGS);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Render</CardTitle>
        <CardDescription>
          {is3d
            ? "3D node, link, label, and force settings."
            : "2D tree node, link, label, and layout settings."}
        </CardDescription>
        <CardAction>
          <Button size="xs" variant="ghost" onClick={reset}>
            Reset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Section title="Nodes">
          {is3d ? (
            <Row
              id="grr-node-resolution"
              label="Resolution"
              value={settings.nodeResolution}
              min={4}
              max={32}
              step={2}
              format={(n) => n.toFixed(0)}
              onChange={(v) => set("nodeResolution", v)}
            />
          ) : null}
          <Row
            id="grr-node-size"
            label="Base size"
            value={settings.nodeRelSize}
            min={1}
            max={12}
            step={0.5}
            onChange={(v) => set("nodeRelSize", v)}
          />
          <Row
            id="grr-node-opacity"
            label="Opacity"
            value={settings.nodeOpacity}
            min={0.1}
            max={1}
            step={0.05}
            format={(n) => n.toFixed(2)}
            onChange={(v) => set("nodeOpacity", v)}
          />
          <Toggle
            id="grr-show-labels"
            label="Always show names"
            hint="show node labels above all nodes, not just on hover"
            checked={settings.showLabels}
            onCheckedChange={(c) => set("showLabels", c)}
          />
          {settings.showLabels ? (
            <Row
              id="grr-label-size"
              label="Label size"
              value={settings.labelSize}
              min={0.5}
              max={15}
              step={0.25}
              onChange={(v) => set("labelSize", v)}
            />
          ) : null}
          {settings.showLabels && is3d ? (
            <Toggle
              id="grr-dynamic-label"
              label="Size by link count"
              hint="scale each label by how many links the node has"
              checked={settings.dynamicLabelSize}
              onCheckedChange={(c) => set("dynamicLabelSize", c)}
            />
          ) : null}
          {settings.showLabels && settings.dynamicLabelSize && is3d ? (
            <>
              <Row
                id="grr-label-influence"
                label="Count influence"
                value={settings.labelSizeInfluence}
                min={0}
                max={1}
                step={0.05}
                format={(n) => n.toFixed(2)}
                onChange={(v) => set("labelSizeInfluence", v)}
              />
              <div className="grid grid-cols-[7rem_minmax(0,1fr)_3rem] items-center gap-2">
                <label
                  htmlFor="grr-label-degree"
                  className="truncate text-sm text-foreground"
                >
                  Count
                </label>
                <Select
                  value={settings.labelDegreeMode}
                  onValueChange={(v) =>
                    v && set("labelDegreeMode", v as LabelDegreeMode)
                  }
                >
                  <SelectTrigger id="grr-label-degree" size="sm" aria-label="Count">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="in">In links</SelectItem>
                    <SelectItem value="out">Out links</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
                <span />
              </div>
            </>
          ) : null}
          {isLinks && shadingEnabled !== undefined && onShadingEnabledChange ? (
            <>
              <Toggle
                id="grr-shaded"
                label="Shading"
                hint="dim nodes outside the highlight set (hover / path waypoints)"
                checked={shadingEnabled}
                onCheckedChange={onShadingEnabledChange}
              />
              {shadingEnabled ? (
                <Row
                  id="grr-shaded-opacity"
                  label="Shaded opacity"
                  value={settings.shadedOpacity}
                  min={0}
                  max={0.99}
                  step={0.05}
                  format={(n) => n.toFixed(2)}
                  onChange={(v) => set("shadedOpacity", v)}
                />
              ) : null}
            </>
          ) : null}
        </Section>

        <Section title="Links">
          <Row
            id="grr-link-opacity"
            label="Opacity"
            value={settings.linkOpacity}
            min={0.01}
            max={1}
            step={0.01}
            format={(n) => n.toFixed(2)}
            onChange={(v) => set("linkOpacity", v)}
          />
          <Row
            id="grr-link-width"
            label="Width"
            value={settings.linkWidth}
            min={0.1}
            max={5}
            step={0.1}
            onChange={(v) => set("linkWidth", v)}
          />
          {is3d ? (
            <>
              <Row
                id="grr-arrow"
                label="Arrow size"
                value={settings.arrowLength}
                min={0}
                max={10}
                step={0.5}
                onChange={(v) => set("arrowLength", v)}
              />
              <Row
                id="grr-curvature"
                label="Curvature"
                value={settings.linkCurvature}
                min={0}
                max={0.8}
                step={0.05}
                format={(n) => n.toFixed(2)}
                onChange={(v) => set("linkCurvature", v)}
              />
              <Toggle
                id="grr-show-link-labels"
                label="Show predicate labels"
                hint="draw the relation name on each edge"
                checked={settings.showLinkLabels}
                onCheckedChange={(c) => set("showLinkLabels", c)}
              />
              {settings.showLinkLabels ? (
                <Row
                  id="grr-link-label-size"
                  label="Label size"
                  value={settings.linkLabelSize}
                  min={0.4}
                  max={4}
                  step={0.1}
                  onChange={(v) => set("linkLabelSize", v)}
                />
              ) : null}
            </>
          ) : null}
          <div className="grid grid-cols-[7rem_minmax(0,1fr)_3rem] items-center gap-2">
            <label
              htmlFor="grr-link-color-mode"
              className="truncate text-sm text-foreground"
            >
              Color
            </label>
            <Select
              value={settings.linkColorMode}
              onValueChange={(v) =>
                v && set("linkColorMode", v as LinkColorMode)
              }
            >
              <SelectTrigger
                id="grr-link-color-mode"
                size="sm"
                aria-label="Link color"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectItem value="neutral">Neutral</SelectItem>
                <SelectItem value="gradient">Endpoint gradient (OKLCH)</SelectItem>
              </SelectContent>
            </Select>
            <span />
          </div>
          {settings.linkColorMode === "gradient" ? (
            <Row
              id="grr-link-color-intensity"
              label="Color intensity"
              value={settings.linkColorIntensity}
              min={0}
              max={1}
              step={0.05}
              format={(n) => `${Math.round(n * 100)}%`}
              onChange={(v) => set("linkColorIntensity", v)}
            />
          ) : null}
          {isLinks && is3d ? (
            <>
              <Row
                id="grr-particles"
                label="Particles"
                value={settings.particles}
                min={0}
                max={8}
                step={1}
                format={(n) => n.toFixed(0)}
                onChange={(v) => set("particles", v)}
              />
              <Row
                id="grr-particle-speed"
                label="Particle speed"
                value={settings.particleSpeed}
                min={0.001}
                max={0.02}
                step={0.001}
                format={(n) => n.toFixed(3)}
                onChange={(v) => set("particleSpeed", v)}
              />
              <Row
                id="grr-particle-size"
                label="Particle size"
                value={settings.particleWidth}
                min={0.5}
                max={6}
                step={0.5}
                onChange={(v) => set("particleWidth", v)}
              />
              <Toggle
                id="grr-directional"
                label="Color by direction"
                hint="green=in red=out (needs seeds + particles)"
                checked={settings.directionalParticles}
                onCheckedChange={(c) => set("directionalParticles", c)}
              />
            </>
          ) : null}
        </Section>

        {is3d ? (
          <Section title="Physics">
            <Row
              id="grr-charge"
              label="Repulsion"
              value={settings.chargeStrength}
              min={-1200}
              max={-20}
              step={10}
              format={(n) => n.toFixed(0)}
              onChange={(v) => set("chargeStrength", v)}
            />
            <Row
              id="grr-center-strength"
              label="Gravity"
              value={settings.centerStrength}
              min={0}
              max={3}
              step={0.05}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("centerStrength", v)}
            />
            <Row
              id="grr-link-distance"
              label="Link distance"
              value={settings.linkDistance}
              min={5}
              max={400}
              step={5}
              format={(n) => n.toFixed(0)}
              onChange={(v) => set("linkDistance", v)}
            />
            <Row
              id="grr-alpha-decay"
              label="Alpha decay"
              value={settings.alphaDecay}
              min={0.001}
              max={0.06}
              step={0.001}
              format={(n) => n.toFixed(3)}
              onChange={(v) => set("alphaDecay", v)}
            />
            <Row
              id="grr-velocity-decay"
              label="Velocity decay"
              value={settings.velocityDecay}
              min={0.1}
              max={0.99}
              step={0.01}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("velocityDecay", v)}
            />
          </Section>
        ) : null}

        {isLinks && is3d ? (
          <Section title="Path trace">
            <Row
              id="grr-max-paths"
              label="Max routes"
              value={settings.maxPaths}
              min={1}
              max={10}
              step={1}
              format={(n) => n.toFixed(0)}
              onChange={(v) => set("maxPaths", v)}
            />
            <Row
              id="grr-trace-speed"
              label="Speed"
              value={settings.traceSpeed}
              min={0.4}
              max={5}
              step={0.1}
              onChange={(v) => set("traceSpeed", v)}
            />
            <Row
              id="grr-trace-accel"
              label="Acceleration"
              value={settings.traceAccel}
              min={0}
              max={1}
              step={0.05}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("traceAccel", v)}
            />
            <Row
              id="grr-trace-loop"
              label="Loop delay"
              value={settings.traceLoopDelay}
              min={0}
              max={5}
              step={0.1}
              format={(n) => `${n.toFixed(1)}s`}
              onChange={(v) => set("traceLoopDelay", v)}
            />
            <Row
              id="grr-trace-lightness"
              label="Color lightness"
              value={settings.traceLightness}
              min={0.4}
              max={0.95}
              step={0.01}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("traceLightness", v)}
            />
            <Row
              id="grr-trace-chroma"
              label="Color vividness"
              value={settings.traceChroma}
              min={0.02}
              max={0.37}
              step={0.01}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("traceChroma", v)}
            />
            <Row
              id="grr-trace-start-hue"
              label="Start hue"
              value={settings.traceStartHue}
              min={0}
              max={360}
              step={5}
              format={(n) => `${Math.round(n)}°`}
              onChange={(v) => set("traceStartHue", v)}
            />
            <Row
              id="grr-trace-end-hue"
              label="End hue"
              value={settings.traceEndHue}
              min={0}
              max={360}
              step={5}
              format={(n) => `${Math.round(n)}°`}
              onChange={(v) => set("traceEndHue", v)}
            />
            <Row
              id="grr-trace-hue-spread"
              label="Hue spread"
              value={settings.traceHueSpread}
              min={0}
              max={120}
              step={2}
              format={(n) => `${Math.round(n)}°`}
              onChange={(v) => set("traceHueSpread", v)}
            />
            <Row
              id="grr-path-brightness"
              label="Path edges"
              value={settings.pathLinkBrightness}
              min={0}
              max={1}
              step={0.05}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("pathLinkBrightness", v)}
            />
            <Toggle
              id="grr-particle-glow"
              label="Particle glow"
              hint="soft halo around the travelling particle (between 2 waypoints)"
              checked={settings.particleGlow}
              onCheckedChange={(c) => set("particleGlow", c)}
            />
          </Section>
        ) : null}

        {isLinks && is3d ? (
          <Section title="Background">
            <div className="flex flex-wrap gap-2">
              {BG_PRESETS.map((preset) => {
                const active = settings.bgColor === preset.value;
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => set("bgColor", preset.value)}
                    aria-pressed={active}
                    className={
                      "flex items-center gap-2 rounded-md border px-2 py-1 text-xs " +
                      (active
                        ? "border-primary text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground")
                    }
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-4 w-4 rounded border border-border"
                      style={{ background: preset.value }}
                    />
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

        {isOntology && !is3d ? (
          <Section title="Tree">
            <Row
              id="grr-tree-spread"
              label="Branch spread"
              value={settings.treeSpread}
              min={0.35}
              max={1.5}
              step={0.05}
              format={(n) => n.toFixed(2)}
              onChange={(v) => set("treeSpread", v)}
            />
          </Section>
        ) : null}
      </CardContent>
    </Card>
  );
}
