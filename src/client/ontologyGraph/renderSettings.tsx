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
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_FORCE_GRAPH_DRAW_SETTINGS } from "../forceGraph3d";
import type { OntologyGraphView } from "./types";

export interface OntologyRenderSettings {
  nodeScale: number;
  nodeOpacity: number;
  showLabels: boolean;
  labelScale: number;
  linkOpacity: number;
  linkWidth: number;
  arrowLength: number;
  chargeStrength: number;
  linkDistance: number;
  treeSpread: number;
}

const ONTOLOGY_RENDER_SETTINGS_KEY = "halupedia:ontology-render:v1";
const DEFAULT_ONTOLOGY_RENDER_SETTINGS: OntologyRenderSettings = {
  nodeScale: 1,
  nodeOpacity: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.nodeOpacity,
  showLabels: true,
  labelScale: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.labelSize,
  linkOpacity: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.linkOpacity,
  linkWidth: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.linkWidth,
  arrowLength: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.arrowLength,
  chargeStrength: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.chargeStrength,
  linkDistance: DEFAULT_FORCE_GRAPH_DRAW_SETTINGS.linkDistance,
  treeSpread: 1,
};

export function loadOntologyRenderSettings(): OntologyRenderSettings {
  try {
    const raw = localStorage.getItem(ONTOLOGY_RENDER_SETTINGS_KEY);
    if (!raw) return DEFAULT_ONTOLOGY_RENDER_SETTINGS;
    return {
      ...DEFAULT_ONTOLOGY_RENDER_SETTINGS,
      ...(JSON.parse(raw) as Partial<OntologyRenderSettings>),
    };
  } catch {
    return DEFAULT_ONTOLOGY_RENDER_SETTINGS;
  }
}

export function saveOntologyRenderSettings(
  settings: OntologyRenderSettings,
): void {
  try {
    localStorage.setItem(
      ONTOLOGY_RENDER_SETTINGS_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Storage is optional.
  }
}

function RenderSlider({
  id,
  label,
  value,
  min,
  max,
  step,
  format = (next) => next.toFixed(1),
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <output
          htmlFor={id}
          className="font-mono text-xs text-muted-foreground"
        >
          {format(value)}
        </output>
      </div>
      <Slider
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => onChange(Number(next))}
        aria-label={label}
      />
    </Field>
  );
}

export function OntologyRenderPane({
  view,
  settings,
  onChange,
}: {
  view: OntologyGraphView;
  settings: OntologyRenderSettings;
  onChange: (settings: OntologyRenderSettings) => void;
}) {
  const set = <Key extends keyof OntologyRenderSettings>(
    key: Key,
    value: OntologyRenderSettings[Key],
  ) => onChange({ ...settings, [key]: value });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Render</CardTitle>
        <CardDescription>
          {view === "3d"
            ? "3D node, link, label, and force settings."
            : "2D tree node, link, label, and spacing settings."}
        </CardDescription>
        <CardAction>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onChange(DEFAULT_ONTOLOGY_RENDER_SETTINGS)}
          >
            Reset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-5">
          <FieldSet>
            <FieldLegend variant="label">Nodes</FieldLegend>
            <FieldGroup className="gap-4">
              <RenderSlider
                id="ontology-node-scale"
                label="Size"
                value={settings.nodeScale}
                min={0.4}
                max={2.5}
                step={0.1}
                onChange={(value) => set("nodeScale", value)}
              />
              <RenderSlider
                id="ontology-node-opacity"
                label="Opacity"
                value={settings.nodeOpacity}
                min={0.1}
                max={1}
                step={0.05}
                format={(value) => value.toFixed(2)}
                onChange={(value) => set("nodeOpacity", value)}
              />
              <Field orientation="horizontal">
                <Checkbox
                  id="ontology-show-labels"
                  checked={settings.showLabels}
                  onCheckedChange={(checked) =>
                    set("showLabels", checked === true)
                  }
                />
                <FieldLabel htmlFor="ontology-show-labels">
                  Always show names
                </FieldLabel>
              </Field>
              {settings.showLabels ? (
                <RenderSlider
                  id="ontology-label-scale"
                  label="Label size"
                  value={settings.labelScale}
                  min={0.5}
                  max={4}
                  step={0.1}
                  onChange={(value) => set("labelScale", value)}
                />
              ) : null}
            </FieldGroup>
          </FieldSet>
          <FieldSet>
            <FieldLegend variant="label">Links</FieldLegend>
            <FieldGroup className="gap-4">
              <RenderSlider
                id="ontology-link-opacity"
                label="Opacity"
                value={settings.linkOpacity}
                min={0.05}
                max={1}
                step={0.05}
                format={(value) => value.toFixed(2)}
                onChange={(value) => set("linkOpacity", value)}
              />
              <RenderSlider
                id="ontology-link-width"
                label="Width"
                value={settings.linkWidth}
                min={0.25}
                max={5}
                step={0.25}
                onChange={(value) => set("linkWidth", value)}
              />
              {view === "3d" ? (
                <RenderSlider
                  id="ontology-arrow-length"
                  label="Arrow size"
                  value={settings.arrowLength}
                  min={0}
                  max={10}
                  step={0.5}
                  onChange={(value) => set("arrowLength", value)}
                />
              ) : null}
            </FieldGroup>
          </FieldSet>
          {view === "3d" ? (
            <FieldSet>
              <FieldLegend variant="label">Physics</FieldLegend>
              <FieldGroup className="gap-4">
                <RenderSlider
                  id="ontology-charge"
                  label="Repulsion"
                  value={settings.chargeStrength}
                  min={-800}
                  max={-20}
                  step={10}
                  format={(value) => value.toFixed(0)}
                  onChange={(value) => set("chargeStrength", value)}
                />
                <RenderSlider
                  id="ontology-link-distance"
                  label="Link distance"
                  value={settings.linkDistance}
                  min={10}
                  max={240}
                  step={5}
                  format={(value) => value.toFixed(0)}
                  onChange={(value) => set("linkDistance", value)}
                />
              </FieldGroup>
            </FieldSet>
          ) : (
            <FieldSet>
              <FieldLegend variant="label">Tree</FieldLegend>
              <FieldGroup className="gap-4">
                <RenderSlider
                  id="ontology-tree-spread"
                  label="Branch spread"
                  value={settings.treeSpread}
                  min={0.35}
                  max={1.25}
                  step={0.05}
                  format={(value) => value.toFixed(2)}
                  onChange={(value) => set("treeSpread", value)}
                />
              </FieldGroup>
            </FieldSet>
          )}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
