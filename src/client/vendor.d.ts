declare module "graphology-communities-louvain";
declare module "3d-force-graph";
declare module "troika-three-text" {
  import type { Mesh, Material } from "three";
  export class Text extends Mesh {
    text: string;
    font: string;
    fontSize: number;
    anchorX: string | number;
    anchorY: string | number;
    color: string | number;
    fillOpacity: number;
    material: Material & { depthWrite: boolean };
    textRenderInfo: { blockBounds: [number, number, number, number] } | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
declare module "*.woff?url" {
  const url: string;
  export default url;
}
