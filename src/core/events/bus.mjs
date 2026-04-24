import { createRuntimeEvent } from "./schema.mjs";

export class RuntimeEventBus {
  constructor() {
    this.listeners = new Set();
  }

  on(listener) {
    if (typeof listener !== "function") {
      throw new Error("listener must be a function");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type, payload = {}) {
    const event = createRuntimeEvent(type, payload);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }
}
