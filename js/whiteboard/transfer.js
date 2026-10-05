import { isSafeWhiteboardElement, MAX_WHITEBOARD_ELEMENTS } from './shared.js';

const utf8Bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const CHUNK_SIZE = 30_000;
const TTL_MS = 60_000;
const MAX_TRANSFERS = 25;
const MAX_IMAGE_BYTES = 5_000_000;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 128;
const peerKey = conn => conn?.peer || 'local';
const transferKey = (conn, id) => JSON.stringify([peerKey(conn), id]);

export function sendWhiteboardImage(element, send, { isUpdate = false, syncId } = {}) {
  const { dataUrl, ...meta } = element;
  const total = Math.ceil(dataUrl.length / CHUNK_SIZE);
  const chunkId = `wb_img_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  for (let index = 0; index < total; index++) {
    send({ type: 'WHITEBOARD_ELEMENT_CHUNK', chunkId, index, total,
      chunk: dataUrl.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), meta, isUpdate,
      ...(syncId ? { syncId } : {}) });
  }
}

export function sendWhiteboardSnapshot(elements, send) {
  const images = elements.filter(el => el.type === 'image' && el.dataUrl.length > CHUNK_SIZE);
  const regular = elements.filter(el => !images.includes(el));
  if (images.length === 0 && utf8Bytes(regular) < 48 * 1024) {
    send({ type: 'WHITEBOARD_SYNC', elements: regular });
    return;
  }
  const syncId = `wb_sync_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const batches = [];
  let batch = [], bytes = 0;
  for (const el of regular) {
    const size = utf8Bytes(el);
    if (batch.length && bytes + size > 48 * 1024) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(el); bytes += size;
  }
  // An empty initial batch is required for snapshots containing only images.
  if (batch.length || !batches.length) batches.push(batch);
  const elementsOrder = elements.map(element => element.id);
  batches.forEach((elements, batchIndex) => send({ type: 'WHITEBOARD_SYNC_BATCH', syncId,
    elements, batchIndex, totalBatches: batches.length, imageCount: images.length, isFinal: false,
    ...(batchIndex === 0 ? { elementOrder: elementsOrder } : {}) }));
  images.forEach(image => sendWhiteboardImage(image, send, { syncId, isUpdate: true }));
  send({ type: 'WHITEBOARD_SYNC_END', syncId });
}

// One resource budget covers incomplete images and staged full snapshots.
// The visible document changes only after every part of a snapshot arrives.
export function createWhiteboardTransfers(manager, { relayImage = () => {}, onSnapshotApplied = () => {}, maxBufferedBytes = 16 * 1024 * 1024 } = {}) {
  const chunks = new Map(), snapshots = new Map();
  let bufferedBytes = 0, expiryTimer = null;
  const remove = (map, key) => {
    const entry = map.get(key);
    if (entry) bufferedBytes -= entry.bytes;
    map.delete(key);
    if (!chunks.size && !snapshots.size) { clearTimeout(expiryTimer); expiryTimer = null; }
  };
  const reserve = (entry, bytes) => {
    if (bufferedBytes + bytes > maxBufferedBytes) return false;
    entry.bytes += bytes; bufferedBytes += bytes;
    return true;
  };
  const prune = () => {
    expiryTimer = null;
    for (const map of [chunks, snapshots]) {
      for (const [key, entry] of map) if (Date.now() - entry.createdAt >= TTL_MS) remove(map, key);
    }
    scheduleExpiry();
  };
  const scheduleExpiry = () => {
    if (!expiryTimer && (chunks.size || snapshots.size)) {
      const earliest = Math.min(...[...chunks.values(), ...snapshots.values()].map(entry => entry.createdAt + TTL_MS));
      expiryTimer = setTimeout(prune, Math.max(0, earliest - Date.now()));
    }
  };
  const finish = (conn, syncId) => {
    const key = transferKey(conn, syncId), entry = snapshots.get(key);
    if (!entry || !entry.ended || entry.batches.size !== entry.totalBatches || entry.images.size !== entry.imageCount) return;
    const elements = [];
    for (let index = 0; index < entry.totalBatches; index++) elements.push(...entry.batches.get(index));
    elements.push(...entry.images.values());
    remove(snapshots, key);
    const byId = new Map(elements.map(element => [element.id, element]));
    if (elements.length === entry.elementOrder.length && byId.size === elements.length &&
        entry.elementOrder.every(id => byId.has(id))) {
      manager.setElements(entry.elementOrder.map(id => byId.get(id)));
      onSnapshotApplied(manager.elements, conn);
    }
  };

  return {
    receiveChunk(data, conn) {
      if (!validId(data?.chunkId) || !Number.isInteger(data.index) || !Number.isInteger(data.total) ||
          data.total <= 0 || data.total > 200 || data.index < 0 || data.index >= data.total ||
          typeof data.chunk !== 'string' || utf8Bytes(data.chunk) > 65_536 ||
          !isSafeWhiteboardElement({ ...data.meta, dataUrl: 'data:image/png;base64,' }) || data.meta.type !== 'image' ||
          (data.syncId !== undefined && !validId(data.syncId))) return;
      const metaSignature = JSON.stringify(data.meta);
      if (utf8Bytes(metaSignature) > 8192) return;
      const key = transferKey(conn, data.chunkId);
      let entry = chunks.get(key);
      const snapshot = data.syncId && snapshots.get(transferKey(conn, data.syncId));
      if (data.syncId && !snapshot) return;
      if (!entry) {
        if (chunks.size >= MAX_TRANSFERS) return;
        entry = { total: data.total, received: new Map(), meta: { ...data.meta }, metaSignature,
          isUpdate: Boolean(data.isUpdate), syncId: data.syncId, createdAt: Date.now(), bytes: 0, imageBytes: 0 };
        if (!reserve(entry, utf8Bytes(metaSignature))) return;
        chunks.set(key, entry); scheduleExpiry();
      }
      if (entry.total !== data.total || entry.metaSignature !== metaSignature || entry.syncId !== data.syncId ||
          entry.isUpdate !== Boolean(data.isUpdate)) { remove(chunks, key); return; }
      if (entry.received.has(data.index)) {
        if (entry.received.get(data.index) !== data.chunk) remove(chunks, key);
        return;
      }
      const size = utf8Bytes(data.chunk);
      if (entry.imageBytes + size > MAX_IMAGE_BYTES || !reserve(entry, size)) { remove(chunks, key); return; }
      entry.imageBytes += size;
      entry.received.set(data.index, data.chunk);
      if (entry.received.size !== entry.total) return;
      const parts = [];
      for (let index = 0; index < entry.total; index++) parts.push(entry.received.get(index));
      const element = { ...entry.meta, dataUrl: parts.join('') };
      remove(chunks, key);
      if (!isSafeWhiteboardElement(element)) return;
      if (entry.syncId) {
        if (snapshot.images.has(element.id) || snapshot.images.size >= snapshot.imageCount) return;
        if (!reserve(snapshot, utf8Bytes(element))) { remove(snapshots, transferKey(conn, entry.syncId)); return; }
        snapshot.images.set(element.id, element);
        finish(conn, entry.syncId);
      } else if (entry.isUpdate || !manager.elements.some(el => el.id === element.id)) {
        if (entry.isUpdate) manager.updateElement(element, false);
        else manager.addElement(element, false);
        relayImage(element, entry.isUpdate, conn);
      }
    },

    receiveBatch(data, conn) {
      if (!Array.isArray(data.elements) || data.elements.length > MAX_WHITEBOARD_ELEMENTS ||
          !data.elements.every(isSafeWhiteboardElement) || !validId(data.syncId) ||
          !Number.isInteger(data.batchIndex) || !Number.isInteger(data.totalBatches) ||
          data.totalBatches < 1 || data.totalBatches > MAX_WHITEBOARD_ELEMENTS ||
          data.batchIndex < 0 || data.batchIndex >= data.totalBatches) return;
      // Compatibility with the previous regular-element batching protocol.
      if (data.imageCount === undefined) {
        if (data.batchIndex === 0) manager.setElements([]);
        data.elements.forEach(el => manager.addElement(el, false));
        if (data.batchIndex === data.totalBatches - 1) onSnapshotApplied(manager.elements, conn);
        return;
      }
      if (!Number.isInteger(data.imageCount) || data.imageCount < 0 || data.imageCount > MAX_WHITEBOARD_ELEMENTS) return;
      const key = transferKey(conn, data.syncId);
      let entry = snapshots.get(key);
      if (!entry) {
        if (data.batchIndex !== 0 || snapshots.size >= MAX_TRANSFERS) return;
        if (!Array.isArray(data.elementOrder) || data.elementOrder.length > MAX_WHITEBOARD_ELEMENTS ||
            !data.elementOrder.every(id => typeof id === 'string' && id.length <= 64) ||
            new Set(data.elementOrder).size !== data.elementOrder.length) return;
        // A newer snapshot replaces any incomplete snapshot from this peer.
        for (const [oldKey, old] of snapshots) if (old.peer === peerKey(conn)) remove(snapshots, oldKey);
        entry = { peer: peerKey(conn), totalBatches: data.totalBatches, imageCount: data.imageCount,
          batches: new Map(), images: new Map(), createdAt: Date.now(), bytes: 0, ended: false, elementCount: 0,
          elementOrder: [...data.elementOrder] };
        if (!reserve(entry, utf8Bytes(entry.elementOrder))) return;
        snapshots.set(key, entry); scheduleExpiry();
      }
      if (entry.totalBatches !== data.totalBatches || entry.imageCount !== data.imageCount) { remove(snapshots, key); return; }
      if (entry.batches.has(data.batchIndex)) return;
      entry.elementCount += data.elements.length;
      if (entry.elementCount + entry.imageCount > MAX_WHITEBOARD_ELEMENTS || !reserve(entry, utf8Bytes(data.elements))) { remove(snapshots, key); return; }
      entry.batches.set(data.batchIndex, data.elements);
      finish(conn, data.syncId);
    },

    endSnapshot(data, conn) {
      if (!validId(data.syncId)) return;
      const entry = snapshots.get(transferKey(conn, data.syncId));
      if (entry) { entry.ended = true; finish(conn, data.syncId); }
    },

    receiveFull(data, conn) {
      if (!Array.isArray(data.elements) || data.elements.length > MAX_WHITEBOARD_ELEMENTS || !data.elements.every(isSafeWhiteboardElement)) return;
      for (const [key, entry] of snapshots) if (entry.peer === peerKey(conn)) remove(snapshots, key);
      manager.setElements(data.elements);
      onSnapshotApplied(manager.elements, conn);
    },

    dispose() {
      clearTimeout(expiryTimer); expiryTimer = null;
      chunks.clear(); snapshots.clear(); bufferedBytes = 0;
    }
  };
}
