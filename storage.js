// Every piece of saved state (core and plugins) goes through this interface,
// so the JSON-file backend below can be replaced by a database without
// touching the code that uses it.
//
// A store holds named collections of JSON documents keyed by string IDs:
//
//   const accounts = store.collection('plex-accounts');
//   await accounts.get(id)            -> document, or null
//   await accounts.entries()          -> [[id, document], ...]
//   await accounts.set(id, document)
//   await accounts.delete(id)         -> true if it existed
//   await accounts.update(id, fn)     -> atomic read-modify-write; fn gets the
//                                        current document (or null) and returns
//                                        the next one, null to delete, or
//                                        undefined to leave it unchanged
//
// Documents are copied in and out, so callers can't change stored data by
// mutating an object they read. A database backend maps each collection to
// rows of (collection, id, document) and update() to a transaction.
//
// Backends are pluggable: the first plugin defining createStore({ dataDir })
// supplies the store; otherwise the JSON files below are used. A backend
// must honor collection(name, { migrate, importFrom }) when a collection has
// no saved data yet: read importFrom (a JSON file) if it exists and pass it
// through migrate. A backend replacing these JSON files should import each
// collection's existing .<name>.json from dataDir the same way.

import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256;
const copy = value => (value === null || value === undefined ? null : structuredClone(value));

function assertId(id) {
  if (!validId(id)) throw new TypeError('Storage IDs must be non-empty strings of at most 256 characters');
}

const STORE_METHODS = ['get', 'entries', 'set', 'delete', 'update'];

// Open the configured backend. plugins: the loaded plugin list.
export async function openStore({ plugins = [], dataDir }) {
  const backend = plugins.find(plugin => typeof plugin.createStore === 'function');
  if (!backend) return createJsonStore({ dir: dataDir });
  const store = await backend.createStore({ dataDir });
  if (typeof store?.collection !== 'function') throw new Error('Storage plugin did not return a store with collection()');
  // Check the shape once at startup rather than failing on the first save.
  const probe = store.collection('storage-check');
  const missing = STORE_METHODS.filter(method => typeof probe?.[method] !== 'function');
  if (missing.length) throw new Error(`Storage plugin collections are missing: ${missing.join(', ')}`);
  return store;
}

// dir: where collection files live, or null for an in-memory store (tests).
export function createJsonStore({ dir = null } = {}) {
  if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const collections = new Map();

  return {
    // options.migrate(raw) converts an older file layout to { id: document }.
    // options.importFrom: a legacy file read once if this collection's file
    // doesn't exist yet; it is renamed to <file>.imported afterwards.
    collection(name, options = {}) {
      if (!NAME.test(name)) throw new TypeError(`Invalid collection name: ${name}`);
      if (!collections.has(name)) collections.set(name, createJsonCollection(dir && path.join(dir, `.${name}.json`), options));
      return collections.get(name);
    },
  };
}

function readJsonFile(file) {
  chmodSync(file, 0o600);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function writeJsonFile(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function createJsonCollection(file, { migrate = raw => raw, importFrom = null } = {}) {
  let documents = null; // Map id -> document, loaded on first use
  let queue = Promise.resolve();

  function toMap(raw) {
    const converted = migrate(raw ?? {});
    if (!converted || typeof converted !== 'object' || Array.isArray(converted)) throw new Error('Stored collection must be an object of documents');
    return new Map(Object.entries(converted).filter(([id]) => validId(id)));
  }

  function load() {
    if (documents) return documents;
    if (!file) return (documents = new Map());
    if (existsSync(file)) return (documents = toMap(readJsonFile(file)));
    documents = new Map();
    if (importFrom && existsSync(importFrom)) {
      documents = toMap(readJsonFile(importFrom));
      queue = queue.then(async () => {
        await writeJsonFile(file, Object.fromEntries(documents));
        renameSync(importFrom, `${importFrom}.imported`);
      }).catch(() => console.error(`Could not finish importing ${path.basename(importFrom)}; it will be read again next start`));
    }
    return documents;
  }

  // Mutations run one at a time and are saved before they become visible.
  function mutate(change) {
    const run = queue.then(async () => {
      const current = load();
      const { next, result } = await change(current);
      if (next !== current) {
        if (file) await writeJsonFile(file, Object.fromEntries(next));
        documents = next;
      }
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    async get(id) {
      assertId(id);
      await queue;
      return copy(load().get(id));
    },
    async entries() {
      await queue;
      return [...load()].map(([id, value]) => [id, copy(value)]);
    },
    async set(id, value) {
      assertId(id);
      if (value === null || value === undefined) throw new TypeError('Use delete() to remove a document');
      const stored = copy(value);
      return mutate(current => ({ next: new Map(current).set(id, stored), result: undefined }));
    },
    async delete(id) {
      assertId(id);
      return mutate(current => {
        if (!current.has(id)) return { next: current, result: false };
        const next = new Map(current);
        next.delete(id);
        return { next, result: true };
      });
    },
    async update(id, fn) {
      assertId(id);
      return mutate(async current => {
        const value = await fn(copy(current.get(id)));
        if (value === undefined) return { next: current, result: copy(current.get(id)) };
        const next = new Map(current);
        if (value === null) next.delete(id);
        else next.set(id, copy(value));
        return { next, result: copy(value) };
      });
    },
  };
}
