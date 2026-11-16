// Register plugin-owned browse tabs and their onOpen/onClose callbacks.
const tabs = new Map();

export function registerTab({ id, label, onOpen, onClose, onSearch }) {
  tabs.set(id, { id, label, onOpen, onClose, onSearch });
}

export function getTabs() {
  return [...tabs.values()];
}

export function getTab(id) {
  return tabs.get(id);
}
