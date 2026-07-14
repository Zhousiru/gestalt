import sharp from "sharp";

const GRID_COLUMNS = 4;
const GRID_ROWS = 4;
const SAMPLE_COUNT = GRID_COLUMNS * GRID_ROWS;
const ANALYSIS_MAX_DIMENSION = 1_024;
const CELL_SIZE = ANALYSIS_MAX_DIMENSION / GRID_COLUMNS;
const SUPPORTED_FORMATS = new Set(["png", "jpeg", "jpg", "gif", "webp"]);

export const STICKER_MEDIA_LIMITS = Object.freeze({
  maxAnalysisDimension: ANALYSIS_MAX_DIMENSION,
  maxDimension: 4_096,
  maxFramePixels: 8 * 1_024 * 1_024,
  maxFrameCount: 256,
  maxTotalAnimationPixels: 64 * 1_024 * 1_024,
  sharpTimeoutSeconds: 10
});

// Keep libvips' own input guard close to the application budget while leaving
// enough headroom for our explicit total-animation error to be reported.
const SHARP_INPUT_PIXEL_LIMIT =
  STICKER_MEDIA_LIMITS.maxTotalAnimationPixels +
  STICKER_MEDIA_LIMITS.maxFramePixels;
const GUARDED_SHARP_INPUT = {
  failOn: "error",
  limitInputPixels: SHARP_INPUT_PIXEL_LIMIT,
  sequentialRead: true
} as const;

export interface PreparedStickerMedia {
  mime: string;
  extension: string;
  width?: number;
  height?: number;
  animated: boolean;
  frameCount: number;
  analysisImage: Uint8Array;
  contactSheet?: Uint8Array;
}

export async function prepareStickerMedia(
  bytes: Uint8Array
): Promise<PreparedStickerMedia> {
  // metadata() only opens the image header. Sharp does not apply pipeline
  // timeouts to metadata reads, so the native input-pixel guard is the
  // fail-fast boundary before any frame is decoded.
  const metadata = await sharp(bytes, {
    ...GUARDED_SHARP_INPUT,
    animated: true,
    pages: -1
  }).metadata();
  if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
    throw new Error(
      `Unsupported sticker image format: ${metadata.format ?? "unknown"}.`
    );
  }
  const geometry = validateStickerGeometry(metadata);
  const { width, height, frameCount } = geometry;
  const mime = mimeForFormat(metadata.format);
  const extension = extensionForFormat(metadata.format);
  const base = {
    mime,
    extension,
    width,
    height,
    animated: frameCount > 1,
    frameCount
  };

  if (frameCount === 1) {
    const analysisImage = await prepareStaticAnalysisImage(bytes, width, height);
    return {
      ...base,
      analysisImage
    };
  }

  const selectedPages = sampleFrameIndices(frameCount, metadata.delay);
  const frameCache = new Map<number, Buffer>();
  const frameBuffers: Buffer[] = [];
  for (const page of selectedPages) {
    let frame = frameCache.get(page);
    if (!frame) {
      frame = await sharp(bytes, {
        ...GUARDED_SHARP_INPUT,
        page
      })
        .timeout({ seconds: STICKER_MEDIA_LIMITS.sharpTimeoutSeconds })
        .ensureAlpha()
        .resize({
          width: CELL_SIZE,
          height: CELL_SIZE,
          fit: "contain",
          withoutEnlargement: true,
          background: { r: 250, g: 250, b: 250, alpha: 1 }
        })
        .png()
        .toBuffer();
      frameCache.set(page, frame);
    }
    frameBuffers.push(frame);
  }
  const contactSheet = await sharp({
    create: {
      width: GRID_COLUMNS * CELL_SIZE,
      height: GRID_ROWS * CELL_SIZE,
      channels: 4,
      background: { r: 250, g: 250, b: 250, alpha: 1 }
    }
  })
    .timeout({ seconds: STICKER_MEDIA_LIMITS.sharpTimeoutSeconds })
    .composite(
      frameBuffers.map((input, index) => ({
        input,
        left: (index % GRID_COLUMNS) * CELL_SIZE,
        top: Math.floor(index / GRID_COLUMNS) * CELL_SIZE
      }))
    )
    .png()
    .toBuffer();

  return {
    ...base,
    analysisImage: contactSheet,
    contactSheet
  };
}

async function prepareStaticAnalysisImage(
  bytes: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  if (
    width <= STICKER_MEDIA_LIMITS.maxAnalysisDimension &&
    height <= STICKER_MEDIA_LIMITS.maxAnalysisDimension
  ) {
    return bytes;
  }

  return sharp(bytes, GUARDED_SHARP_INPUT)
    .timeout({ seconds: STICKER_MEDIA_LIMITS.sharpTimeoutSeconds })
    .autoOrient()
    .resize({
      width: STICKER_MEDIA_LIMITS.maxAnalysisDimension,
      height: STICKER_MEDIA_LIMITS.maxAnalysisDimension,
      fit: "inside",
      withoutEnlargement: true
    })
    .toBuffer();
}

function validateStickerGeometry(metadata: {
  width?: number | undefined;
  height?: number | undefined;
  pageHeight?: number | undefined;
  pages?: number | undefined;
}): { width: number; height: number; frameCount: number } {
  const width = readPositiveInteger(metadata.width, "width");
  const frameCount = readPositiveInteger(metadata.pages ?? 1, "frame count");
  const height = readPositiveInteger(
    frameCount > 1
      ? metadata.pageHeight
      : (metadata.pageHeight ?? metadata.height),
    frameCount > 1 ? "page height" : "height"
  );

  if (width > STICKER_MEDIA_LIMITS.maxDimension) {
    throw new Error(
      `Sticker media width ${width} exceeds ${STICKER_MEDIA_LIMITS.maxDimension} pixels.`
    );
  }
  if (height > STICKER_MEDIA_LIMITS.maxDimension) {
    throw new Error(
      `Sticker media height ${height} exceeds ${STICKER_MEDIA_LIMITS.maxDimension} pixels.`
    );
  }

  const framePixels = BigInt(width) * BigInt(height);
  if (framePixels > BigInt(STICKER_MEDIA_LIMITS.maxFramePixels)) {
    throw new Error(
      `Sticker media frame pixels ${framePixels} exceeds ${STICKER_MEDIA_LIMITS.maxFramePixels}.`
    );
  }
  if (frameCount > STICKER_MEDIA_LIMITS.maxFrameCount) {
    throw new Error(
      `Sticker media frame count ${frameCount} exceeds ${STICKER_MEDIA_LIMITS.maxFrameCount}.`
    );
  }

  const totalAnimationPixels = framePixels * BigInt(frameCount);
  if (
    frameCount > 1 &&
    totalAnimationPixels >
      BigInt(STICKER_MEDIA_LIMITS.maxTotalAnimationPixels)
  ) {
    throw new Error(
      `Sticker media animation pixels ${totalAnimationPixels} exceeds ${STICKER_MEDIA_LIMITS.maxTotalAnimationPixels}.`
    );
  }

  return { width, height, frameCount };
}

function readPositiveInteger(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Sticker media has invalid ${label} metadata.`);
  }
  return value;
}

export function sampleFrameIndices(
  frameCount: number,
  delays: number[] | undefined
): number[] {
  if (frameCount <= 1) {
    return [0];
  }
  const normalizedDelays = Array.from({ length: frameCount }, (_, index) => {
    const delay = delays?.[index];
    return typeof delay === "number" && delay > 0 ? delay : 100;
  });
  const totalDuration = normalizedDelays.reduce((sum, delay) => sum + delay, 0);
  const boundaries: number[] = [];
  let elapsed = 0;
  for (const delay of normalizedDelays) {
    elapsed += delay;
    boundaries.push(elapsed);
  }
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => {
    const timestamp = ((index + 0.5) / SAMPLE_COUNT) * totalDuration;
    const page = boundaries.findIndex((boundary) => timestamp < boundary);
    return page < 0 ? frameCount - 1 : page;
  });
}

function mimeForFormat(format: string | undefined): string {
  switch (format) {
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    default:
      throw new Error(`Unsupported sticker image format: ${format ?? "unknown"}.`);
  }
}

function extensionForFormat(format: string | undefined): string {
  if (!format || !SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported sticker image format: ${format ?? "unknown"}.`);
  }
  return format === "jpeg" ? "jpg" : format;
}
