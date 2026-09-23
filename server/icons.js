import sharp from "sharp";
export async function normalizeIcon(bytes) {
  const invalid = () =>
    Object.assign(
      new Error(
        "Choose a valid PNG, JPEG, or WebP image (maximum 5 MiB and 16 million pixels).",
      ),
      { status: 400 },
    );
  try {
    const image = sharp(bytes, {
      limitInputPixels: 16000000,
      failOn: "warning",
    });
    const meta = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format) || (meta.pages || 1) > 1)
      throw invalid();
    const panel = await image
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .png()
      .toBuffer();
    const minecraft = await sharp(panel).resize(64, 64).png().toBuffer();
    return { panel, minecraft };
  } catch {
    throw invalid();
  }
}
