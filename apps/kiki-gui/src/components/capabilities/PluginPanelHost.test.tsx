// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginPanelHost } from './PluginPanelHost';

const getPluginPanelDocument = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({
  client: {
    baseUrl: 'https://server.example.test/root/',
    getPluginPanelDocument,
  },
}));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => connection,
  useConnection: () => connection,
}));
vi.mock('../../host', () => ({ useHost: () => ({}) }));
vi.mock('../../host/external', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeEach(() => {
  getPluginPanelDocument.mockReset();
  connection.client.baseUrl = 'https://server.example.test/root/';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

async function renderPanel(document: { readonly html: string; readonly url?: string }): Promise<HTMLIFrameElement> {
  getPluginPanelDocument.mockResolvedValueOnce(document);
  const container = window.document.createElement('div');
  window.document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (frame !== null) return frame;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error('plugin panel did not mount');
}

describe('PluginPanelHost document source', () => {
  it('resolves a server document URL against the connected client base URL', async () => {
    const frame = await renderPanel({ html: '<p>unused fallback</p>', url: '../panels/panel.html' });

    expect(frame.getAttribute('src')).toBe('https://server.example.test/panels/panel.html');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it.each(['/plugin-panel/grant', 'http://document.kiki-document.localhost:1234/plugin-panel/grant'])('resolves %s for the same-origin web client', async (url) => {
    connection.client.baseUrl = '';
    const frame = await renderPanel({ html: '<p>panel</p>', url });
    expect(frame.getAttribute('src')).toBe(new URL(url, window.location.origin).toString());
    expect(frame.getAttribute('srcdoc')).toBeNull();
  });

  it('initializes the bridge again after a document navigation', async () => {
    const frame = await renderPanel({ html: '<p>panel</p>', url: '/plugin-panel/grant' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith({ channel: 'kiki.panel.v1', kind: 'init', sessionId: null }, '*');
  });

  it('keeps using srcDoc when the server document has no URL', async () => {
    const html = '<!doctype html><html><body><p>legacy panel</p></body></html>';
    const frame = await renderPanel({ html });

    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('srcdoc')).toBe(html);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('preserves the live iframe grant URL across background refetches when HTML is unchanged, and updates when HTML changes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/grant-1' })
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/grant-2' })
      .mockResolvedValueOnce({ html: '<p>v2</p>', url: '/plugin-panel/grant-3' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    let frame: HTMLIFrameElement | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      frame = container.querySelector<HTMLIFrameElement>('iframe');
      if (frame !== null) break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-1');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-1');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (frame!.getAttribute('src') === 'https://server.example.test/plugin-panel/grant-3') break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(3);
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-3');
  });

  it('adopts a refreshed grant after remounting with a cached document older than the reuse window', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      ['plugin-panel-document', 'plugin-id', 'panel-id', ''],
      { html: '<p>v1</p>', url: '/plugin-panel/expired-grant' },
      { updatedAt: Date.now() - 11 * 60_000 },
    );
    getPluginPanelDocument.mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/fresh-grant' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (container.querySelector('iframe')?.getAttribute('src')?.endsWith('/fresh-grant')) break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://server.example.test/plugin-panel/fresh-grant');
    queryClient.clear();
  });

  it.each([false, true])('replaces the previous server grant after server generation recovery (endpoint changed: %s)', async (changeEndpoint) => {
    const bag = connection as typeof connection & { scopeId?: string; meta?: { server_id: string } };
    bag.scopeId = 'local';
    bag.meta = { server_id: 'server-a' };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: 'http://grant-a.kiki-document.localhost:1234/plugin-panel/a' })
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: 'http://grant-b.kiki-document.localhost:5678/plugin-panel/b' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const render = () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );

    await act(async () => {
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 12 && container.querySelector('iframe') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain('/plugin-panel/a');

    bag.meta = { server_id: 'server-b' };
    if (changeEndpoint) bag.client.baseUrl = 'https://new-server.example.test/root/';
    await act(async () => { render(); });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('http://grant-b.kiki-document.localhost:5678/plugin-panel/b');
    queryClient.clear();
    delete bag.scopeId;
    delete bag.meta;
  });
});
