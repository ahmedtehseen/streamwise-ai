export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function isSupportedImageType(type: string) {
  return SUPPORTED_IMAGE_TYPES.some((supportedType) => supportedType === type);
}

export function hasValidImageSignature(bytes: Uint8Array, type: string) {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  if (type === "image/webp") return bytes.length >= 12 && "RIFF" === String.fromCharCode(...bytes.slice(0, 4)) && "WEBP" === String.fromCharCode(...bytes.slice(8, 12));
  return false;
}
