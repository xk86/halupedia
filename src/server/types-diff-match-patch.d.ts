declare module "diff-match-patch" {
  class diff_match_patch {
    patch_make(text1: string, text2: string): object[];
    patch_apply(patches: object[], text: string): [string, boolean[]];
    patch_toText(patches: object[]): string;
    patch_fromText(text: string): object[];
  }
  export = diff_match_patch;
}
