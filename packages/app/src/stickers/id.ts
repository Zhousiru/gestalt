const STICKER_ID_HEX_LENGTH = 16;

export function stickerIdFromSha256(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Sticker id requires a lowercase SHA-256 digest.");
  }
  return `stk_${sha256.slice(0, STICKER_ID_HEX_LENGTH)}`;
}
