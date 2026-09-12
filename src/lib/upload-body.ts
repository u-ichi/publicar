export class UploadInputError extends Error {
  constructor(message: string, public status: 400 | 413 = 400) { super(message); }
}

export async function boundedUploadBody(request: Request, maximum: number, allowEmpty = false): Promise<ArrayBuffer> {
  const length = request.headers.get("Content-Length");
  if (length && Number(length) > maximum) throw new UploadInputError("payload_too_large", 413);
  if (!request.body && allowEmpty) return new ArrayBuffer(0);
  if (!request.body) throw new UploadInputError("empty_upload");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new UploadInputError("payload_too_large", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size && !allowEmpty) throw new UploadInputError("empty_upload");
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body.buffer;
}
