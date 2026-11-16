// Use the first plugin for data hooks; route and frontend hooks are additive.
export function firstPluginWith(plugins, hookName) {
  return plugins.find((plugin) => typeof plugin[hookName] === 'function');
}

export async function loadConfiguredPlugins({ directory, modules = [], importModule = specifier => import(specifier) } = {}) {
  const { readdir } = await import('node:fs/promises');
  const files = directory
    ? (await readdir(directory)).filter(name => name.endsWith('-plugin.js')).sort().map(name => new URL(name, directory))
    : [];
  const result = [];
  for (const specifier of [...modules, ...files]) {
    // Configured plugins may enforce access/quota rules. A failure must stop
    // startup rather than silently remove those protections.
    const plugin = (await importModule(specifier)).default;
    if (!plugin || typeof plugin !== 'object') throw new Error('Invalid configured plugin export');
    result.push(plugin);
  }
  return result;
}
