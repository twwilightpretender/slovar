/*
 * Запись файла в OPFS через синхронный доступ.
 * Нужна для Safari (в том числе Chrome на iPhone): там нет createWritable, а createSyncAccessHandle работает только в воркере.
 */
type Msg =
  | { id: number; t: 'open'; file: FileSystemFileHandle }
  | { id: number; t: 'write'; buf: ArrayBuffer }
  | { id: number; t: 'reset' }
  | { id: number; t: 'close' }
  | { id: number; t: 'abort' };

interface SyncHandle {
  write(b: Uint8Array, o: { at: number }): number;
  truncate(n: number): void;
  flush(): void;
  close(): void;
}
let h: SyncHandle | null = null;
let pos = 0;
const reply = (m: object) => (self as unknown as { postMessage(m: object): void }).postMessage(m);

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.t === 'open') {
      h = await (m.file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      h.truncate(0);
      pos = 0;
    } else if (m.t === 'write') {
      const data = new Uint8Array(m.buf);
      let off = 0;
      while (off < data.length) {
        const n = h!.write(data.subarray(off), { at: pos });
        if (!n) throw new Error('не удалось записать данные (нет места?)');
        off += n;
        pos += n;
      }
    } else if (m.t === 'reset') {
      h!.truncate(0);
      pos = 0;
    } else if (m.t === 'close') {
      h?.flush();
      h?.close();
      h = null;
    } else if (m.t === 'abort') {
      try { h?.close(); } catch { /* уже закрыт */ }
      h = null;
    }
    reply({ id: m.id, ok: true });
  } catch (e) {
    reply({ id: m.id, err: e instanceof Error ? e.message : String(e) });
  }
};
