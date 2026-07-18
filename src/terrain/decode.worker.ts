/**
 * INV-2 : le .bin uint16 little-endian est décodé en Float32 ici, hors main
 * thread. Le GPU filtre ensuite des hauteurs en mètres, jamais des canaux RGB.
 */

export interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
  heightScale: number;
  heightOffset: number;
}

export interface DecodeResponse {
  id: number;
  heights: Float32Array;
}

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(msg: DecodeResponse, transfer: Transferable[]): void;
};

scope.onmessage = (ev) => {
  const { id, buffer, heightScale, heightOffset } = ev.data;
  const u16 = new Uint16Array(buffer);
  const heights = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    // `!` justifié : i < u16.length par construction.
    heights[i] = u16[i]! * heightScale + heightOffset;
  }
  scope.postMessage({ id, heights }, [heights.buffer]);
};
