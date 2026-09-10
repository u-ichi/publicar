export function validCommentAnchor(anchor: Record<string, unknown>): boolean {
  if (JSON.stringify(anchor).length > 20000) return false;
  for (const [key, limit] of Object.entries({ blockId: 256, selectedText: 10000, prefix: 500, suffix: 500, blockText: 1000, blockTagName: 32, frameHash: 2048, frameUrl: 4096 })) {
    if (anchor[key] !== undefined && (typeof anchor[key] !== "string" || (anchor[key] as string).length > limit)) return false;
  }
  for (const key of ["start", "end"]) {
    if (anchor[key] !== undefined && (!Number.isInteger(anchor[key]) || Number(anchor[key]) < 0 || Number(anchor[key]) > 10000000)) return false;
  }
  if (anchor.start !== undefined && anchor.end !== undefined && Number(anchor.end) <= Number(anchor.start)) return false;
  if (anchor.frameHash && !(anchor.frameHash as string).startsWith("#")) return false;
  return true;
}
