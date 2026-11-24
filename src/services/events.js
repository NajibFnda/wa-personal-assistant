import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(100);

/**
 * Broadcast real-time data changes to connected Web Dashboard clients (SSE).
 */
export function emitDataChange(module, source = 'api', meta = {}) {
  bus.emit('change', {
    module,
    source,
    meta,
    timestamp: Date.now(),
  });
}

export function onDataChange(listener) {
  bus.on('change', listener);
  return () => bus.off('change', listener);
}
