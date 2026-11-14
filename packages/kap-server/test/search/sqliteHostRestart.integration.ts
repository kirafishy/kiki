import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SqliteSearchHost } from '../../src/search/sqlite/host';
import type { IndexerEvent, IndexerRequest } from '../../src/search/sqlite/processProtocol';

const hosts: SqliteSearchHost[] = [];
const children: ChildProcess[] = [];
const homes: string[] = [];
const indexerRoot = new URL('../../src/search/sqlite/', import.meta.url);

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-sqlite-restart-'));
  homes.push(home);
  return home;
}

function spawnIndexer(database: string, hardMb: number): ChildProcess {
  const child = spawn(process.execPath, [
    '--max-old-space-size=256', '--experimental-transform-types', '--import', 'tsx',
    '--import', new URL('register-dev-hooks.mjs', indexerRoot).href,
    fileURLToPath(new URL('indexerDev.ts', indexerRoot)), database,
  ], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256',
      KIKI_SEARCH_INDEXER_HARD_MB: String(hardMb), KIKI_SEARCH_INDEXER_SOFT_MB: '32',
      KIKI_SEARCH_INDEX_SUBAGENTS: '0' },
  });
  children.push(child);
  return child;
}

function waitExit(child: ChildProcess, limitMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('indexer did not exit')); }, limitMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function walBytes(database: string): Promise<number> {
  try { return (await stat(`${database}-wal`)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}

it('runs the scheduled indexer restart when the timer fires before retryAt', async () => {
  const home = await tempHome();
  const script = join(home, 'exit86.mjs');
  await writeFile(script, 'process.exit(86);\n');
  let armed: { run: () => void; timer: NodeJS.Timeout; delay: number } | undefined;
  const host = new SqliteSearchHost({
    database: join(home, 'index.sqlite'), backoffMs: [5_000], memoryBackoffMs: [5_000], indexerEntry: script,
    scheduleRestart: (run, delay) => {
      const timer = setTimeout(() => {}, 60_000);
      armed = { run, timer, delay };
      return timer;
    },
  });
  hosts.push(host);
  await host.open();
  const deadline = Date.now() + 10_000;
  while (armed === undefined || host.snapshot().indexerPid !== undefined) {
    if (Date.now() > deadline) throw new Error('restart was not armed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(armed.delay).toBe(5_000);
  expect(host.snapshot().retryAfterMs).toBeGreaterThan(1_000);
  clearTimeout(armed.timer);
  armed.run();
  expect(host.snapshot().retryAfterMs).toBeUndefined();
  expect(host.snapshot().indexerPid).toBeGreaterThan(0);
});

it('exits a booting indexer when close arrives before the database is opened', async () => {
  const home = await tempHome();
  const database = join(home, 'missing', 'index.sqlite');
  const started = Date.now();
  const child = spawnIndexer(database, 768);
  child.once('spawn', () => { child.send({ type: 'close' }); });
  await expect(waitExit(child, 8_000)).resolves.toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect(stat(join(home, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('orders host inventories and targeted work on one revision clock and ignores superseded acknowledgements', { timeout: 20_000 }, async () => {
  const home = await tempHome();
  const host = new SqliteSearchHost({ database: join(home, 'index.sqlite') });
  hosts.push(host);
  await host.open();
  await expect.poll(() => host['ready'], { timeout: 10_000 }).toBe(true);
  const child = host['child']!;
  const send = child.send.bind(child);
  const sent: IndexerRequest[] = [];
  child.send = ((message: IndexerRequest) => { sent.push(message); return true; }) as typeof child.send;
  try {
    const session = { id: 'example', dir: home, workspaceId: 'w', updatedAt: 1 };
    host.sync([session]);
    const inventory = host['inventoryRevision'];
    host.syncSession({ ...session, workspaceId: 'new' });
    const targeted = host['targeted'].get(session.id)!;
    expect(targeted.revision).toBeGreaterThan(inventory);
    child.emit('message', { type: 'synced', sessionId: session.id, revision: inventory, missing: true } satisfies IndexerEvent);
    expect(host['pending'].has(session.id)).toBe(true);
    expect(host['known'].get(session.id)?.workspaceId).toBe('new');

    host.sync([session]);
    expect(host['inventoryRevision']).toBeGreaterThan(targeted.revision);
    child.emit('message', { type: 'session_synced', sessionId: session.id, revision: targeted.revision, missing: true } satisfies IndexerEvent);
    expect(host['pending'].has(session.id)).toBe(true);
    expect(host['known'].get(session.id)).toEqual(session);
    expect(sent.map((message) => message.type)).toEqual(['sync', 'sync_session', 'sync']);
  } finally { child.send = send; }
});

it('keeps newer updates and retirements ahead of queued or staged full inventory work', { timeout: 20_000 }, async () => {
  const home = await tempHome();
  const database = join(home, 'index.sqlite');
  const inputs = await Promise.all(['first', 'retired', 'moved'].map(async (id) => {
    const dir = join(home, id);
    await mkdir(dir);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ title: id }));
    return { id, dir, workspaceId: 'old', updatedAt: 1 };
  }));
  const [first, retired, moved] = inputs as [typeof inputs[number], typeof inputs[number], typeof inputs[number]];
  const dbHost = spawnIndexer(database, 768);
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const events: IndexerEvent[] = [];
  dbHost.on('message', (event: IndexerEvent) => {
    events.push(event);
    if (event.type === 'ready') markReady();
  });
  const send = (request: IndexerRequest) => dbHost.send(request);
  await ready;
  send({ type: 'sync', revision: 1, first: true, last: true, sessions: inputs });
  send({ type: 'retire_session', revision: 2, sessionId: retired.id });
  await expect.poll(() => events.some((event) => event.type === 'inventory_synced' && event.revision === 1)).toBe(true);

  const databaseRows = () => {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return db.prepare('SELECT id,workspace_id FROM sessions ORDER BY id').all(); }
    finally { db.close(); }
  };
  expect(databaseRows()).toEqual([{ id: first.id, workspace_id: 'old' }, { id: moved.id, workspace_id: 'old' }]);

  send({ type: 'sync', revision: 3, first: true, last: false, sessions: [first, retired] });
  send({ type: 'sync_session', revision: 4, session: { ...moved, workspaceId: 'new' } });
  send({ type: 'retire_session', revision: 5, sessionId: retired.id });
  await expect.poll(() => events.some((event) => event.type === 'session_synced' && event.revision === 5)).toBe(true);
  send({ type: 'sync', revision: 3, first: false, last: true, sessions: [] });
  await expect.poll(() => events.some((event) => event.type === 'inventory_synced' && event.revision === 3)).toBe(true);
  expect(databaseRows()).toEqual([{ id: first.id, workspace_id: 'old' }, { id: moved.id, workspace_id: 'new' }]);
  const exit = waitExit(dbHost, 8_000);
  send({ type: 'close' });
  await expect(exit).resolves.toBe(0);
});

it('closes the index after open when the memory budget exits', async () => {
  const home = await tempHome();
  const database = join(home, 'index.sqlite');
  const child = spawnIndexer(database, 64);
  const kinds: string[] = [];
  let stderr = '';
  child.on('message', (message: { type?: string }) => { if (message?.type) kinds.push(message.type); });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  await expect(waitExit(child, 15_000)).resolves.toBe(86);
  expect(kinds).toContain('ready');
  expect(stderr).toContain('memory_budget');
  expect(await walBytes(database)).toBe(0);
  await expect(stat(database)).resolves.toMatchObject({ size: expect.any(Number) });
});
