import { EventEmitter } from 'node:events';
export function io() {
    return new class extends EventEmitter {
        connected = false;
        volatile = this;
        emit(event, ...args) { if (event === 'ping') args[0]?.(); return super.emit(event, ...args); }
        connect() { this.connected = true; queueMicrotask(() => this.emit('connect')); return this; }
        disconnect() { this.connected = false; return this; }
        close() { this.connected = false; return this; }
        timeout() { return this; }
        async emitWithAck(_event, data) { return { result: 'success', version: data.expectedVersion + 1, metadata: data.metadata, agentState: data.agentState }; }
    }();
}
